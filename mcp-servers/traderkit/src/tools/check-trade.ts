import { z } from "zod";
import { composeCheckTrade } from "../gates/compose.js";
import { readPortfolioTotal, PortfolioTotalError } from "../gates/portfolio-total.js";
import { VAULT_ROOT } from "../config.js";
import type { Profile } from "../profiles/schema.js";
import type { SnaptradeReadClient } from "../mcp/snaptrade-read-client.js";

const StrikeGridEntry = z.object({
  strike: z.number(),
  premium: z.number().nonnegative(),
  delta: z.number(),
  notes: z.string().optional(),
});

const ActiveThesis = z.object({
  thesis_id: z.string().min(1),
  tickers: z.array(z.string()).min(1),
  structures: z.array(z.string()).optional(),
  status: z.enum(["active", "paused", "closed"]),
});

export const CheckTradeArgs = z.object({
  profile: z.string().min(1),
  tool: z.string().min(1),
  ticker: z.string().min(1).max(20),
  direction: z.enum(["BUY", "SELL", "BUY_TO_OPEN", "BUY_TO_CLOSE", "SELL_TO_OPEN", "SELL_TO_CLOSE"]),
  qty: z.number().positive(),
  notional_usd: z.number().nonnegative(),
  leg_shape: z.string().optional(),
  portfolio_total_usd: z.number().nonnegative().default(0),
  existing_ticker_exposure_usd: z.number().nonnegative().default(0),
  require_wash_sale_check: z.boolean().default(false),
  now: z.string().optional(),
  // R0 freshness timestamps — pass ISO8601 strings from the upstream data pull.
  // Required for SELL_TO_OPEN (short opens) under DEFAULT_RULES R0_no_stale_data.
  // Omitting them when R0 is enabled causes an unavoidable R0 fail (gate is
  // unsatisfiable). Use PERMISSIVE_RULES or supply these fields to satisfy R0.
  quote_as_of: z.string().optional(),
  regime_as_of: z.string().optional(),
  portfolio_total_as_of: z.string().optional(),
  activities_as_of: z.string().optional(),
  expiry_date: z.string().optional(),
  selected_strike: z.number().optional(),
  strike_grid: z.array(StrikeGridEntry).optional(),
  grid_as_of: z.string().optional(),
  is_wheel_assignment_leg: z.boolean().optional(),
  thesis_ref: z.string().optional(),
  discretionary_event: z.boolean().optional(),
  discretionary_rationale: z.string().optional(),
  active_theses: z.array(ActiveThesis).optional(),
  proposed_structure: z.string().optional(),
  thesis_md_path: z.string().optional(),
  thesis_md_sha256: z.string().optional(),
});

export interface CheckTradeDeps {
  allProfiles: Profile[];
  snaptradeRead: SnaptradeReadClient | null;
  /** What a profile's `vault_link` resolves against. Falls back to config. */
  vaultRoot?: string | null;
}

const usd = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

/** Below this the two figures are the same book read a few minutes apart. */
const DISAGREEMENT_PCT = 1;

/**
 * The denominator for the single-name cap.
 *
 * A caller who sends a partial book gets a refusal that is precise, hash-chained
 * and wrong — 2026-08-07, five brokers summed to $162,951.25 on a book of about
 * $763,553, and a roll was refused at "31.5% against a 15% cap" when it stood at
 * 6.7%. So the gate reads the aggregate the profile points at, and treats a
 * caller's number as a claim to check rather than a fact to divide by.
 */
function resolveDenominator(
  profile: Profile,
  supplied: number,
  vaultRoot: string | null,
  now: Date | undefined
): { usd: number; asOf?: string; warnings: string[] } {
  if (!profile.vault_link) {
    return {
      usd: supplied,
      warnings: supplied > 0
        ? [
            `caps: profile "${profile.name}" names no vault_link, so the gate ` +
              `cannot verify the $${usd(supplied)} portfolio total it was handed. ` +
              `The single-name cap rests on a figure with no source.`,
          ]
        : [],
    };
  }

  if (!vaultRoot) {
    return {
      usd: supplied,
      warnings: [
        `caps: profile "${profile.name}" points at ${profile.vault_link} but no ` +
          `vault root is configured (TRADERKIT_VAULT_ROOT), so the gate cannot ` +
          `verify the portfolio total it was handed.`,
      ],
    };
  }

  const total = readPortfolioTotal(vaultRoot, profile.vault_link, now ? { now } : {});
  const warnings: string[] = [];

  if (supplied > 0) {
    const gap = Math.abs(supplied - total.usd) / total.usd * 100;
    if (gap > DISAGREEMENT_PCT) {
      warnings.push(
        `caps: the supplied portfolio total $${usd(supplied)} disagrees with ` +
          `$${usd(total.usd)} in ${total.source} (${total.asOf}) by ` +
          `${gap.toFixed(1)}%. The aggregate is what the cap was checked against. ` +
          `A short total reads as concentration that is not there.`
      );
    }
  }

  return { usd: total.usd, asOf: total.asOf, warnings };
}

export async function checkTradeHandler(
  raw: unknown,
  deps: CheckTradeDeps
): Promise<{ pass: boolean; reasons: string[]; warnings: string[]; ticket_id?: string }> {
  const args = CheckTradeArgs.parse(raw);
  const profile = deps.allProfiles.find((p) => p.name === args.profile);
  if (!profile) {
    return { pass: false, reasons: [`unknown profile: ${args.profile}`], warnings: [] };
  }

  const now = args.now ? new Date(args.now) : undefined;

  let denominator: ReturnType<typeof resolveDenominator>;
  try {
    denominator = resolveDenominator(
      profile,
      args.portfolio_total_usd,
      deps.vaultRoot ?? VAULT_ROOT,
      now
    );
  } catch (err) {
    if (err instanceof PortfolioTotalError) {
      // No ticket. A refusal we cannot stand behind is worse than no answer,
      // and this one names the file to fix.
      return { pass: false, reasons: [err.message], warnings: [] };
    }
    throw err;
  }

  const tradeBase = {
    tool: args.tool,
    ticker: args.ticker,
    direction: args.direction,
    qty: args.qty,
    notional_usd: args.notional_usd,
    portfolio_total_usd: denominator.usd,
    existing_ticker_exposure_usd: args.existing_ticker_exposure_usd,
  };
  const trade = {
    ...tradeBase,
    ...(args.leg_shape !== undefined ? { leg_shape: args.leg_shape } : {}),
    ...(args.selected_strike !== undefined ? { selected_strike: args.selected_strike } : {}),
  };

  const result = await composeCheckTrade({
    profile,
    allProfiles: deps.allProfiles,
    trade,
    fetchActivities: async (accounts, since) => {
      if (!deps.snaptradeRead) throw new Error("snaptrade-read not configured");
      return deps.snaptradeRead.getActivities(accounts, since);
    },
    requireWashSaleCheck: args.require_wash_sale_check,
    now,
    quote_as_of: args.quote_as_of,
    regime_as_of: args.regime_as_of,
    // Deliberately the caller's stamp, not the vault's. R0 asks how recently
    // the brokers were pulled and runs on a 4-hour TTL; the aggregate carries a
    // date, not a time. Feeding a day into an hour-granularity check measures
    // nothing. The aggregate's own age is bounded in readPortfolioTotal.
    portfolio_total_as_of: args.portfolio_total_as_of,
    activities_as_of: args.activities_as_of,
    expiry_date: args.expiry_date,
    strike_grid: args.strike_grid,
    grid_as_of: args.grid_as_of,
    is_wheel_assignment_leg: args.is_wheel_assignment_leg,
    thesis_ref: args.thesis_ref,
    discretionary_event: args.discretionary_event,
    discretionary_rationale: args.discretionary_rationale,
    active_theses: args.active_theses,
    proposed_structure: args.proposed_structure,
    thesis_md_path: args.thesis_md_path,
    thesis_md_sha256: args.thesis_md_sha256,
  });

  return { ...result, warnings: [...result.warnings, ...denominator.warnings] };
}

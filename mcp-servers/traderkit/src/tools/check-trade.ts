import { z } from "zod";
import { composeCheckTrade } from "../gates/compose.js";
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

  const tradeBase = {
    tool: args.tool,
    ticker: args.ticker,
    direction: args.direction,
    qty: args.qty,
    notional_usd: args.notional_usd,
    portfolio_total_usd: args.portfolio_total_usd,
    existing_ticker_exposure_usd: args.existing_ticker_exposure_usd,
  };
  const trade = {
    ...tradeBase,
    ...(args.leg_shape !== undefined ? { leg_shape: args.leg_shape } : {}),
    ...(args.selected_strike !== undefined ? { selected_strike: args.selected_strike } : {}),
  };

  return composeCheckTrade({
    profile,
    allProfiles: deps.allProfiles,
    trade,
    fetchActivities: async (accounts, since) => {
      if (!deps.snaptradeRead) throw new Error("snaptrade-read not configured");
      return deps.snaptradeRead.getActivities(accounts, since);
    },
    requireWashSaleCheck: args.require_wash_sale_check,
    now: args.now ? new Date(args.now) : undefined,
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
}

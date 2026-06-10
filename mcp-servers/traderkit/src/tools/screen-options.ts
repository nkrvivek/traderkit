import { z } from "zod";
import { uwOptionChain, uwExpiryList, uwIvRank, uwStockState } from "../clients/uw-client.js";
import { finnhubProfile } from "../clients/finnhub-client.js";
import { fmpEarnings, fmpDcf, fmpPriceTarget } from "../clients/fmp-client.js";
import { TickerSchema } from "../utils/schemas.js";
import { daysUntil } from "../utils/date.js";
import { round } from "../utils/math.js";
import { toMessage } from "../utils/errors.js";

export const ScreenOptionsArgs = z.object({
  tickers: z.array(TickerSchema).min(1).max(50),
  strategy: z.enum(["csp", "cc", "pcs", "ccs"]).default("csp"),
  dte_min: z.number().int().positive().default(14),
  dte_max: z.number().int().positive().default(45),
  delta_abs_max: z.number().positive().max(1).default(0.30),
  delta_abs_min: z.number().nonnegative().max(1).default(0.10),
  iv_rank_min: z.number().min(0).max(100).default(30),
  min_credit: z.number().nonnegative().default(0.25),
  min_yor: z.number().nonnegative().default(0.08),
  min_oi: z.number().int().nonnegative().default(100),
  min_mkt_cap_usd: z.number().nonnegative().default(500_000_000),
  avoid_earnings_within_dte: z.boolean().default(true),
  max_results: z.number().int().positive().max(100).default(25),
  spread_width: z.number().positive().optional(),
});

type Args = z.infer<typeof ScreenOptionsArgs>;

/** IVR gate status for premium-selling structures.
 *  PASS    = IVR ≥ 50 (structural VRP edge confirmed).
 *  SOFT-FAIL = IVR < 50 (premium not demonstrably rich — soft warn, never hard-block).
 *  UNKNOWN = UW returned no iv_rank data.
 */
export type IvrGate = "PASS" | "SOFT-FAIL" | "UNKNOWN";

/** All strategies in screen_options are premium-sell structures. */
const PREMIUM_SELL_STRATEGIES = new Set(["csp", "cc", "pcs", "ccs"]);

export function ivrGate(ivRank: number | null | undefined, strategy: string): IvrGate {
  if (!PREMIUM_SELL_STRATEGIES.has(strategy)) return "UNKNOWN"; // debit/directional — no gate
  if (ivRank == null || Number.isNaN(ivRank)) return "UNKNOWN";
  return ivRank >= 50 ? "PASS" : "SOFT-FAIL";
}

/** One-liner suitable for the notes/text output. */
export function ivrGateLine(ivRank: number | null | undefined, strategy: string): string {
  const gate = ivrGate(ivRank, strategy);
  if (!PREMIUM_SELL_STRATEGIES.has(strategy)) return "";
  if (gate === "UNKNOWN") return "IVR unknown — premium-sell gate UNKNOWN (data missing)";
  if (gate === "PASS") return `IVR ${Math.round(ivRank!)} — premium-sell gate PASS`;
  return `IVR ${Math.round(ivRank!)} — premium rich? NO (soft gate: prefer waiting or switch to debit structures)`;
}

interface Candidate {
  ticker: string;
  strategy: string;
  short_strike: number;
  long_strike?: number | undefined;
  expiry: string;
  dte: number;
  credit: number;
  max_risk?: number | undefined;
  yor?: number | undefined;
  short_delta: number;
  pop: number;
  iv?: number | undefined;
  iv_rank?: number | undefined;
  /** IVR soft gate: PASS ≥50, SOFT-FAIL <50, UNKNOWN when data missing. Never hard-blocks. */
  ivr_gate: IvrGate;
  oi: number;
  volume?: number | undefined;
  underlying_price?: number | undefined;
  market_cap_usd?: number | undefined;
  sector?: string | undefined;
  earnings_date?: string | undefined;
  earnings_timing?: "bmo" | "amc" | "unknown" | undefined;
  earnings_in_window: boolean;
  dcf_value?: number | undefined;
  dcf_vs_spot_pct?: number | undefined;
  target_consensus?: number | undefined;
  target_high?: number | undefined;
  target_low?: number | undefined;
  target_vs_spot_pct?: number | undefined;
  score: number;
  notes: string[];
}

function isBetween(iso: string | undefined, minDte: number, maxDte: number): boolean {
  if (!iso) return false;
  const d = daysUntil(iso);
  return d >= minDte && d <= maxDte;
}

export async function screenOptionsHandler(raw: unknown): Promise<{
  candidates: Candidate[];
  skipped: { ticker: string; reason: string }[];
}> {
  const args = ScreenOptionsArgs.parse(raw);
  const candidates: Candidate[] = [];
  const skipped: { ticker: string; reason: string }[] = [];

  for (const ticker of args.tickers) {
    try {
      const today = new Date();
      const fromIso = today.toISOString().slice(0, 10);
      const toIso = new Date(today.getTime() + (args.dte_max + 30) * 86_400_000)
        .toISOString().slice(0, 10);
      const [profile, earnings, dcf, priceTarget, ivRank, state] = await Promise.all([
        finnhubProfile(ticker),
        fmpEarnings(ticker, fromIso, toIso),
        fmpDcf(ticker),
        fmpPriceTarget(ticker),
        uwIvRank(ticker),
        uwStockState(ticker),
      ]);

      if (profile.market_cap_usd !== undefined && profile.market_cap_usd < args.min_mkt_cap_usd) {
        skipped.push({ ticker, reason: `mkt_cap ${profile.market_cap_usd} < min ${args.min_mkt_cap_usd}` });
        continue;
      }
      if (ivRank.iv_rank !== undefined && ivRank.iv_rank < args.iv_rank_min) {
        skipped.push({ ticker, reason: `iv_rank ${ivRank.iv_rank} < min ${args.iv_rank_min}` });
        continue;
      }

      const expiries = await uwExpiryList(ticker);
      const eligibleExpiries = expiries.filter((e) => isBetween(e, args.dte_min, args.dte_max));
      if (eligibleExpiries.length === 0) {
        skipped.push({ ticker, reason: `no expiries in DTE [${args.dte_min}, ${args.dte_max}]` });
        continue;
      }

      const isPutSide = args.strategy === "csp" || args.strategy === "pcs";
      const optionType = isPutSide ? "put" : "call";
      const chains = await Promise.all(
        eligibleExpiries.map((expiry) =>
          uwOptionChain(ticker, expiry)
            .then((chain) => ({ expiry, chain } as const))
            .catch((e) => {
              process.stderr.write(`traderkit: uwOptionChain(${ticker}, ${expiry}) failed: ${toMessage(e)}\n`);
              return { expiry, chain: [] } as const;
            }),
        ),
      );

      for (const { expiry, chain } of chains) {
        const dte = daysUntil(expiry);
        const earningsInWindow = earnings.next_earnings_date
          ? daysUntil(earnings.next_earnings_date) <= dte && daysUntil(earnings.next_earnings_date) >= 0
          : false;
        if (args.avoid_earnings_within_dte && earningsInWindow) continue;

        const legs = chain.filter((c) => c.type === optionType);
        for (const leg of legs) {
          if (leg.delta === undefined || leg.mid === undefined || leg.open_interest === undefined) continue;
          const absDelta = Math.abs(leg.delta);
          if (absDelta < args.delta_abs_min || absDelta > args.delta_abs_max) continue;
          if (leg.open_interest < args.min_oi) continue;

          const credit = leg.mid;
          if (credit < args.min_credit) continue;

          let longStrike: number | undefined;
          let maxRisk: number | undefined;
          let netCredit = credit;

          if (args.strategy === "pcs" || args.strategy === "ccs") {
            const width = args.spread_width ?? 5;
            longStrike = isPutSide ? leg.strike - width : leg.strike + width;
            const longLeg = legs.find((c) => c.strike === longStrike);
            if (!longLeg?.mid) continue;
            netCredit = credit - longLeg.mid;
            if (netCredit < args.min_credit) continue;
            maxRisk = width - netCredit;
            if (maxRisk <= 0) continue;
          }

          const yor = maxRisk !== undefined ? netCredit / maxRisk : netCredit / leg.strike;
          if (yor < args.min_yor) continue;

          const pop = 1 - absDelta;
          const score = yor * pop * (1 + (ivRank.iv_rank ?? 30) / 200);
          const notes: string[] = [];
          if (earningsInWindow) notes.push("earnings_in_window");
          if (ivRank.iv_rank !== undefined && ivRank.iv_rank > 60) notes.push("high_iv_rank");
          if (leg.volume !== undefined && leg.volume > (leg.open_interest ?? 0)) notes.push("unusual_vol");

          // IVR soft gate — annotate every premium-sell candidate (never hard-blocks; vault rules authoritative)
          const gate = ivrGate(ivRank.iv_rank, args.strategy);
          const gateLine = ivrGateLine(ivRank.iv_rank, args.strategy);
          if (gateLine) notes.push(gateLine);

          const dcfVsSpotPct = (dcf.dcf !== undefined && state.price)
            ? round((dcf.dcf / state.price - 1) * 100, 100)
            : undefined;
          const targetVsSpotPct = (priceTarget.target_consensus !== undefined && state.price)
            ? round((priceTarget.target_consensus / state.price - 1) * 100, 100)
            : undefined;
          candidates.push({
            ticker,
            strategy: args.strategy,
            short_strike: leg.strike,
            long_strike: longStrike,
            expiry,
            dte,
            credit: round(netCredit),
            max_risk: maxRisk !== undefined ? round(maxRisk) : undefined,
            yor: round(yor, 10_000),
            short_delta: round(leg.delta, 10_000),
            pop: round(pop, 10_000),
            iv: leg.iv,
            iv_rank: ivRank.iv_rank,
            ivr_gate: gate,
            oi: leg.open_interest,
            volume: leg.volume,
            underlying_price: state.price,
            market_cap_usd: profile.market_cap_usd,
            sector: profile.sector,
            earnings_date: earnings.next_earnings_date,
            earnings_timing: earnings.timing,
            earnings_in_window: earningsInWindow,
            dcf_value: dcf.dcf,
            dcf_vs_spot_pct: dcfVsSpotPct,
            target_consensus: priceTarget.target_consensus,
            target_high: priceTarget.target_high,
            target_low: priceTarget.target_low,
            target_vs_spot_pct: targetVsSpotPct,
            score: round(score, 10_000),
            notes,
          });
        }
      }
    } catch (err) {
      skipped.push({ ticker, reason: toMessage(err).slice(0, 200) });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return {
    candidates: candidates.slice(0, args.max_results),
    skipped,
  };
}

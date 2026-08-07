// squeeze_score — 0-100 composite: crowded-short × aggressive-call-buying ×
// gamma-load. One number that flags short-squeeze setups.
//
// Pure scoring fn (options-analyzer spec.md §squeeze_score). It does NOT fetch:
// the caller sources the three input blocks from the tools it already runs —
// uw_shorts (short interest % float + days-to-cover), uw_flow (net premium +
// call/put skew of aggressive ask-side flow), uw_gex_levels (spot proximity to
// a gamma wall / flip). Keeping it pure makes it deterministic and testable;
// live UW parsing stays in the agent layer where the raw shapes live.
//
// Never emits a bare score: returns the 3 sub-scores + the raw inputs behind
// each so the number is auditable.
import { z } from "zod";
import { round } from "../utils/math.js";

// clamp helper
function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export const SqueezeScoreArgs = z.object({
  ticker: z.string().min(1).max(20),
  // uw_shorts inputs
  short_interest_pct_float: z.number().nonnegative().describe("short interest as % of float, e.g. 22.5 for 22.5%"),
  days_to_cover: z.number().nonnegative().describe("short-interest days-to-cover ratio"),
  // uw_flow inputs (aggressive / ask-side flow, last session)
  net_call_premium_usd: z.number().describe("net ask-side call premium last session, USD (can be negative)"),
  net_put_premium_usd: z.number().default(0).describe("net ask-side put premium last session, USD"),
  // uw_gex_levels input
  gamma_proximity: z
    .number()
    .min(0)
    .max(1)
    .describe("0-1: how close spot sits to a large gamma wall / negative-gamma flip that would accelerate a move (1 = at the wall)"),
});

export type SqueezeScoreInput = z.infer<typeof SqueezeScoreArgs>;

// Thresholds — where each sub-score saturates. Named, not magic.
const SI_FLOOR_PCT = 5; // below this, no short crowding credit
const SI_SATURATE_PCT = 30; // >=30% float short = full SI credit
const DTC_SATURATE = 7; // >=7 days-to-cover = full DTC credit
const SHORT_MAX = 40;
const FLOW_MAX = 40;
const GAMMA_MAX = 20;

export interface SqueezeScore {
  ticker: string;
  score: number; // 0-100
  short_component: number; // 0-40
  flow_component: number; // 0-40
  gamma_component: number; // 0-20
  inputs: {
    short_interest_pct_float: number;
    days_to_cover: number;
    net_call_premium_usd: number;
    net_put_premium_usd: number;
    net_premium_usd: number;
    call_share: number | null;
    gamma_proximity: number;
  };
  notes: string[];
}

export function squeezeScore(a: SqueezeScoreInput): SqueezeScore {
  // short_component (0-40): higher SI% float + higher days-to-cover.
  // Split the budget: 26 pts for SI% ramp, 14 pts for DTC ramp.
  const siRamp = clamp((a.short_interest_pct_float - SI_FLOOR_PCT) / (SI_SATURATE_PCT - SI_FLOOR_PCT), 0, 1);
  const dtcRamp = clamp(a.days_to_cover / DTC_SATURATE, 0, 1);
  const shortComponent = SHORT_MAX * (0.65 * siRamp + 0.35 * dtcRamp);

  // flow_component (0-40): bullish, aggressive call-buying. Uses the call share
  // of gross aggressive premium AND the net-call-premium sign. Bearish net
  // (net_call <= 0) earns nothing — a squeeze needs buyers pressing calls.
  const grossPrem = Math.abs(a.net_call_premium_usd) + Math.abs(a.net_put_premium_usd);
  const callShare = grossPrem > 0 ? Math.abs(a.net_call_premium_usd) / grossPrem : null;
  const netPremium = a.net_call_premium_usd - a.net_put_premium_usd;
  let flowComponent = 0;
  if (a.net_call_premium_usd > 0 && callShare !== null) {
    // skew term: 0 at 50/50, 1 when all aggressive premium is calls
    const skew = clamp((callShare - 0.5) / 0.5, 0, 1);
    flowComponent = FLOW_MAX * skew;
  }

  // gamma_component (0-20): proximity to a gamma wall / flip.
  const gammaComponent = GAMMA_MAX * clamp(a.gamma_proximity, 0, 1);

  const score = clamp(shortComponent + flowComponent + gammaComponent, 0, 100);

  const notes: string[] = [];
  if (a.short_interest_pct_float < SI_FLOOR_PCT) notes.push(`SI ${a.short_interest_pct_float}% < ${SI_FLOOR_PCT}% floor — not crowded short`);
  if (a.net_call_premium_usd <= 0) notes.push("net aggressive call premium ≤ 0 — no bullish flow, flow_component=0");
  if (a.gamma_proximity >= 0.8) notes.push("spot near a gamma wall/flip — a move can accelerate");
  if (score >= 70) notes.push("elevated squeeze setup — crowded short + call-buying + gamma");

  return {
    ticker: a.ticker,
    score: round(score, 10),
    short_component: round(shortComponent, 10),
    flow_component: round(flowComponent, 10),
    gamma_component: round(gammaComponent, 10),
    inputs: {
      short_interest_pct_float: a.short_interest_pct_float,
      days_to_cover: a.days_to_cover,
      net_call_premium_usd: a.net_call_premium_usd,
      net_put_premium_usd: a.net_put_premium_usd,
      net_premium_usd: round(netPremium, 100),
      call_share: callShare === null ? null : round(callShare, 1e4),
      gamma_proximity: a.gamma_proximity,
    },
    notes,
  };
}

export async function squeezeScoreHandler(raw: unknown): Promise<SqueezeScore> {
  const args = SqueezeScoreArgs.parse(raw);
  return squeezeScore(args);
}

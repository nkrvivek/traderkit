import { z } from "zod";
import { TickerSchema } from "../utils/schemas.js";
import { round } from "../utils/math.js";

const ChannelGroup = z.enum([
  "POSITIONING",
  "FLOW",
  "TECHNICAL",
  "VOLATILITY",
  "MACRO",
  "FUNDAMENTAL",
  "THESIS",
]);

type Group = z.infer<typeof ChannelGroup>;
type Tier = "CORE" | "TIER-1" | "TIER-2" | "WATCH" | "NOISE";

const SignalInput = z.object({
  ticker: TickerSchema,
  source: z.string().min(1),
  group: ChannelGroup.optional(),
  direction: z.enum(["BULLISH", "BEARISH", "NEUTRAL"]),
  confidence: z.number().min(0).max(1),
  detail: z.string().optional(),
});

type Signal = z.infer<typeof SignalInput>;

export const SignalRankArgs = z.object({
  signals: z.array(SignalInput),
  multi_source_bonus: z.number().min(0).max(0.5).default(0.1),
  min_confidence: z.number().min(0).max(1).default(0.3),
  max_results: z.number().positive().default(20),
  earnings_within_days: z.record(z.string(), z.number()).optional(),
  iv_tier_by_ticker: z.record(z.string(), z.enum(["GREEN", "YELLOW", "RED"])).optional(),
  /** IVR (IV rank 0–100) per ticker from UW /stock/{T}/iv-rank.
   *  Used to emit VOLATILITY-group IVR gate annotations on premium-sell proposals.
   *  IVR ≥ 50 → note "IVR_PASS" in ivr_warnings (VOLATILITY channel edge confirmed).
   *  IVR < 50 → warning "IVR_SOFT_FAIL" (premium not demonstrably rich).
   *  When ivr_scoring_enabled=true: IVR≥50 on premium-sell tickers counts as a
   *    synthetic VOLATILITY channel hit, incrementing groups_hit/channels_hit/confluence_score.
   */
  ivr_rank_by_ticker: z.record(z.string(), z.number().min(0).max(100)).optional(),
  /** Tickers whose signals represent a premium-sell proposal (CSP/CC/PCS/CCS).
   *  Required for IVR gate annotation; non-sell tickers are left unannotated.
   */
  premium_sell_tickers: z.array(z.string()).optional(),
  /** Opt-in: when true and IVR≥50 on a premium-sell ticker, count IVR as a
   *  synthetic VOLATILITY:ivr_rank channel hit in confluence scoring.
   *  Default false — keeps backward-compat tier calibration.
   *  Enable after backtest validation of IVR-scoring impact on tier distribution.
   */
  ivr_scoring_enabled: z.boolean().default(false),
});

interface RankedSignal {
  ticker: string;
  direction: "BULLISH" | "BEARISH" | "NEUTRAL";
  composite_confidence: number;
  source_count: number;
  sources: string[];
  top_detail: string | null;
  raw_signals: Array<{ source: string; group: Group; confidence: number; direction: string }>;
  confluence_score: number;
  tier: Tier;
  groups_hit: number;
  channels_hit: number;
  thesis_bonus: number;
  earnings_penalty: number;
  green_bonus: number;
  /** IVR gate annotations for premium-sell tickers (populated when ivr_rank_by_ticker supplied).
   *  Empty array = not a premium-sell ticker OR IVR data not supplied. */
  ivr_warnings: string[];
}

const SOURCE_GROUP_HEURISTIC: Array<[RegExp, Group]> = [
  [/darkpool|insider|congress|institut|holding|whale/i, "POSITIONING"],
  [/flow|sweep|alert|unusual.*opt/i, "FLOW"],
  [/technical|rsi|moving.*avg|breakout|momentum|seasonal/i, "TECHNICAL"],
  [/iv|rvi|vol|skew|vega/i, "VOLATILITY"],
  [/regime|cri|vcg|market_quality|macro|sector/i, "MACRO"],
  [/earnings|fundamental|income|cashflow|balance/i, "FUNDAMENTAL"],
  [/thesis/i, "THESIS"],
];

function inferGroup(source: string): Group {
  for (const [re, g] of SOURCE_GROUP_HEURISTIC) if (re.test(source)) return g;
  return "FLOW";
}

function tierOf(score: number): Tier {
  if (score >= 60) return "CORE";
  if (score >= 40) return "TIER-1";
  if (score >= 25) return "TIER-2";
  if (score >= 10) return "WATCH";
  return "NOISE";
}

export async function signalRankHandler(raw: unknown) {
  const args = SignalRankArgs.parse(raw);

  const byTicker = new Map<string, Signal[]>();
  for (const s of args.signals) {
    const sig: Signal = { ...s, group: s.group ?? inferGroup(s.source) };
    if (!byTicker.has(sig.ticker)) byTicker.set(sig.ticker, []);
    byTicker.get(sig.ticker)!.push(sig);
  }

  const ranked: RankedSignal[] = [];
  for (const [ticker, signals] of byTicker) {
    const deduped = dedupBySource(signals);
    const sourceCount = deduped.length;
    const baseConfidence = Math.max(...deduped.map((s) => s.confidence));
    const bonus = (sourceCount - 1) * args.multi_source_bonus;
    const composite = Math.min(1.0, round(baseConfidence + bonus));

    if (composite < args.min_confidence) continue;

    const directionVotes = { BULLISH: 0, BEARISH: 0, NEUTRAL: 0 };
    for (const s of deduped) directionVotes[s.direction] += s.confidence;
    const direction = (Object.entries(directionVotes) as Array<[keyof typeof directionVotes, number]>)
      .sort((a, b) => b[1] - a[1])[0]![0];

    const topDetail = deduped
      .filter((s) => s.detail)
      .sort((a, b) => b.confidence - a.confidence)[0]?.detail ?? null;

    const groups = new Set<Group>();
    const channels = new Set<string>();
    for (const s of deduped) {
      groups.add(s.group as Group);
      channels.add(`${s.group}:${s.source}`);
    }
    const thesisBonus = groups.has("THESIS") ? 20 : 0;

    const earningsDays = args.earnings_within_days?.[ticker];
    const ivTier = args.iv_tier_by_ticker?.[ticker];
    // Earnings penalty: base -10 for ANY ticker with earnings inside trade life
    // (≤7d), regardless of IV tier (spec: signal-confluence.md:49).
    // RED tier adds an additional -5 increment (elevated IV-crush + assignment risk).
    // Net: base -10 (any), RED adds -5 → total -15 for RED.
    const earningsBase = earningsDays !== undefined && earningsDays <= 7 ? 10 : 0;
    const earningsRedIncrement = earningsBase > 0 && ivTier === "RED" ? 5 : 0;
    const earningsPenalty = earningsBase + earningsRedIncrement;
    const greenBonus = earningsDays !== undefined && earningsDays <= 14 && ivTier === "GREEN" ? 10 : 0;

    // IVR gate annotation + optional scoring
    const ivrWarnings: string[] = [];
    const isPremiumSell = args.premium_sell_tickers?.includes(ticker) ?? false;
    let ivrScoringHit = false;
    if (isPremiumSell && args.ivr_rank_by_ticker) {
      const ivr = args.ivr_rank_by_ticker[ticker];
      if (ivr === undefined) {
        ivrWarnings.push(`IVR unknown — premium-sell gate UNKNOWN (data missing for ${ticker})`);
      } else if (ivr >= 50) {
        ivrWarnings.push(`IVR ${Math.round(ivr)} — premium-sell gate PASS (VOLATILITY channel edge confirmed)`);
        if (args.ivr_scoring_enabled) {
          // Opt-in: count IVR≥50 as a synthetic VOLATILITY:ivr_rank channel hit
          groups.add("VOLATILITY");
          channels.add("VOLATILITY:ivr_rank");
          ivrScoringHit = true;
        }
      } else {
        ivrWarnings.push(`IVR ${Math.round(ivr)} — premium rich? NO (soft gate: prefer waiting or switch to debit structures for ${ticker})`);
      }
    }

    // Recompute groups/channels size after optional IVR scoring injection
    const confluenceScore = groups.size * 10 + channels.size * 2 + thesisBonus + greenBonus - earningsPenalty;

    ranked.push({
      ticker,
      direction,
      composite_confidence: composite,
      source_count: sourceCount,
      sources: deduped.map((s) => s.source),
      top_detail: topDetail,
      raw_signals: deduped.map((s) => ({
        source: s.source,
        group: s.group as Group,
        confidence: s.confidence,
        direction: s.direction,
      })),
      confluence_score: confluenceScore,
      tier: tierOf(confluenceScore),
      groups_hit: groups.size,
      channels_hit: channels.size,
      thesis_bonus: thesisBonus,
      earnings_penalty: earningsPenalty,
      green_bonus: greenBonus,
      ivr_warnings: ivrWarnings,
    });
  }

  ranked.sort((a, b) => {
    if (b.confluence_score !== a.confluence_score) return b.confluence_score - a.confluence_score;
    return b.composite_confidence - a.composite_confidence;
  });
  const results = ranked.slice(0, args.max_results);

  return {
    ranked: results,
    total_signals: args.signals.length,
    unique_tickers: byTicker.size,
    returned: results.length,
    filtered_below_min: byTicker.size - ranked.length,
  };
}

function dedupBySource(signals: Signal[]): Signal[] {
  const seen = new Map<string, Signal>();
  for (const s of signals) {
    const key = `${s.group}:${s.source}`;
    const existing = seen.get(key);
    if (!existing || s.confidence > existing.confidence) {
      seen.set(key, s);
    }
  }
  return [...seen.values()];
}

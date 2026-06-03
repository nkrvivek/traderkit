import { z } from "zod";
import type { Profile } from "../profiles/schema.js";
import { concentrationLabel } from "../utils/concentration.js";
import { round } from "../utils/math.js";
import { comboFillabilityHandler } from "./combo-fillability.js";
import { getLayerForTicker } from "./check-ai-bott-layer.js";

const RollLegSchema = z.object({
  action: z.enum(["BUY", "SELL"]),
  right: z.enum(["C", "P"]),
  strike: z.number().positive(),
  expiry: z.string(),
  ratio: z.number().int().positive().default(1),
});

const RollContextSchema = z.object({
  legs: z.array(RollLegSchema).min(2),
  net_price: z.number(),
  tif: z.enum(["DAY", "GTC"]).default("DAY"),
  underlying_adv_30d: z.number().positive().optional(),
  now: z.string().optional(),
  close_time: z.string().optional(),
});

export const ProposeTradeArgs = z.object({
  profile: z.string().min(1),
  ticker: z.string().min(1).max(20),
  direction: z.enum(["BUY", "SELL", "BUY_TO_OPEN", "BUY_TO_CLOSE", "SELL_TO_OPEN", "SELL_TO_CLOSE"]),
  current_price: z.number().positive(),
  portfolio_total_usd: z.number().positive(),
  existing_ticker_exposure_usd: z.number().nonnegative().default(0),
  regime_tier: z.enum(["CLEAR", "CAUTION", "DEFENSIVE", "HALT"]).default("CLEAR"),
  structure: z.string().optional(),
  thesis_ref: z.string().optional(),
  signal_summary: z.string().optional(),
  roll_context: RollContextSchema.optional(),
  confluence_score: z.number().min(-50).max(150).optional(),
  confluence_tier: z.enum(["CORE", "TIER-1", "TIER-2", "WATCH", "NOISE"]).optional(),
  tactical_hedge: z.boolean().default(false),
  roll: z.boolean().default(false),
});

const SIZE_MULTIPLIERS: Record<string, number> = {
  CLEAR: 1.0, CAUTION: 0.75, DEFENSIVE: 0.5, HALT: 0.25,
};

const BLOCKED_DIRECTIONS: Record<string, string[]> = {
  CLEAR: [],
  CAUTION: [],
  DEFENSIVE: ["BUY", "BUY_TO_OPEN"],
  HALT: ["BUY", "BUY_TO_OPEN", "SELL_TO_OPEN"],
};

export async function proposeTradeHandler(
  raw: unknown,
  deps: { allProfiles: Profile[] }
) {
  const args = ProposeTradeArgs.parse(raw);
  const profile = deps.allProfiles.find((p) => p.name === args.profile);
  if (!profile) {
    return { status: "REJECTED", reason: `unknown profile: ${args.profile}` };
  }

  const cap = profile.caps.max_single_name_pct;
  const currentPct = (args.existing_ticker_exposure_usd / args.portfolio_total_usd) * 100;
  const headroomPct = Math.max(0, cap - currentPct);
  const headroomLabel = concentrationLabel(currentPct, cap);

  const blocked = BLOCKED_DIRECTIONS[args.regime_tier]!;
  if (blocked.includes(args.direction)) {
    return {
      status: "REJECTED",
      reason: `${args.direction} blocked in ${args.regime_tier} regime`,
      ticker: args.ticker,
      regime_tier: args.regime_tier,
      concentration: { current_pct: round(currentPct), cap_pct: cap, label: headroomLabel },
    };
  }

  const tier = args.confluence_tier;
  const tierEligible = tier === "CORE" || tier === "TIER-1";
  if (tier && !args.tactical_hedge && !args.roll && !tierEligible) {
    return {
      status: "REJECTED",
      reason: `confluence tier ${tier}${args.confluence_score !== undefined ? ` (score ${args.confluence_score})` : ""} below TIER-1 — set tactical_hedge:true if VCG/CRI hedge or roll:true if rolling existing leg`,
      ticker: args.ticker,
      confluence: { score: args.confluence_score ?? null, tier },
    };
  }

  if (headroomLabel === "OVER-CAP" && ["BUY", "BUY_TO_OPEN"].includes(args.direction)) {
    return {
      status: "REJECTED",
      reason: `${args.ticker} at ${round(currentPct)}% exceeds ${cap}% cap — no adds`,
      ticker: args.ticker,
      concentration: { current_pct: round(currentPct), cap_pct: cap, label: headroomLabel },
    };
  }

  const multiplier = SIZE_MULTIPLIERS[args.regime_tier]!;
  const rawSizeUsd = headroomPct * 0.5 * 0.01 * args.portfolio_total_usd;
  const cappedSizeUsd = Math.min(rawSizeUsd, profile.caps.max_order_notional);
  const adjustedSizeUsd = round(cappedSizeUsd * multiplier);
  const shares = Math.floor(adjustedSizeUsd / args.current_price);

  if (shares <= 0) {
    return {
      status: "REJECTED",
      reason: `computed size is 0 shares — headroom ${round(headroomPct)}% too small or price too high`,
      ticker: args.ticker,
      sizing_trace: `headroom=${round(headroomPct)}% × 0.5 × NAV × ${multiplier}x = $${adjustedSizeUsd}`,
    };
  }

  const postPct = round(((args.existing_ticker_exposure_usd + adjustedSizeUsd) / args.portfolio_total_usd) * 100);

  let fillability: Awaited<ReturnType<typeof comboFillabilityHandler>> | undefined;
  const warnings: string[] = [];
  if (!tier && !args.tactical_hedge && !args.roll) {
    warnings.push("no confluence_tier supplied — TIER-1 gate skipped (provide confluence_tier from signal_rank to enforce gate)");
  }
  const isRoll = args.structure === "calendar_roll" || args.structure === "diagonal_roll";
  if (isRoll && args.roll_context) {
    try {
      fillability = await comboFillabilityHandler({
        ticker: args.ticker,
        legs: args.roll_context.legs,
        net_price: args.roll_context.net_price,
        tif: args.roll_context.tif,
        ...(args.roll_context.underlying_adv_30d !== undefined && { underlying_adv_30d: args.roll_context.underlying_adv_30d }),
        ...(args.roll_context.now && { now: args.roll_context.now }),
        ...(args.roll_context.close_time && { close_time: args.roll_context.close_time }),
      });
      if (fillability.score === "LOW") {
        warnings.push(`R14: combo fillability LOW (${fillability.numeric_score}/100) — prefer leg_out over BAG submit`);
      } else if (fillability.score === "MEDIUM") {
        warnings.push(`R14: combo fillability MEDIUM (${fillability.numeric_score}/100) — consider repricing toward combo mid before submit`);
      }
    } catch (e) {
      warnings.push(`combo_fillability gate failed: ${(e as Error).message}`);
    }
  } else if (isRoll && !args.roll_context) {
    warnings.push(`structure=${args.structure} but no roll_context provided — fillability gate skipped (R14 risk unchecked)`);
  }

  const aiBottLayer = getLayerForTicker(args.ticker);
  if (aiBottLayer) {
    warnings.push(
      `[AI-BOTT] ${args.ticker} → Layer ${aiBottLayer.layer_roman} (${aiBottLayer.layer_name}) — ` +
      `call check_ai_bott_layer w/ full positions for cap check (default 4% NAV/layer)`,
    );
  }

  return {
    status: "CANDIDATE",
    ticker: args.ticker,
    direction: args.direction,
    structure: args.structure ?? "equity",
    shares,
    notional_usd: round(shares * args.current_price),
    sizing: {
      headroom_pct: round(headroomPct),
      raw_size_usd: round(rawSizeUsd),
      regime_multiplier: multiplier,
      adjusted_size_usd: adjustedSizeUsd,
      trace: `(${cap}% - ${round(currentPct)}%) × 0.5 × $${args.portfolio_total_usd.toLocaleString()} × ${multiplier}x = $${adjustedSizeUsd.toLocaleString()}`,
    },
    concentration: {
      current_pct: round(currentPct),
      post_trade_pct: postPct,
      cap_pct: cap,
      label: headroomLabel,
    },
    regime_tier: args.regime_tier,
    confluence: tier ? { score: args.confluence_score ?? null, tier, gate: "PASS" } : null,
    bypass: args.tactical_hedge ? "tactical_hedge" : args.roll ? "roll" : null,
    thesis_ref: args.thesis_ref ?? null,
    signal_summary: args.signal_summary ?? null,
    cap_check: adjustedSizeUsd <= profile.caps.max_order_notional ? "PASS" : "CAPPED",
    fillability: fillability ?? null,
    suggested_structure: fillability?.score === "LOW" ? "leg_out" : (args.structure ?? "equity"),
    ai_bott_layer: aiBottLayer,
    warnings,
  };
}

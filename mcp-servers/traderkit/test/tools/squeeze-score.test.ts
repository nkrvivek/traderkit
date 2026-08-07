import { describe, expect, it } from "vitest";
import { squeezeScore, squeezeScoreHandler } from "../../src/tools/squeeze-score.js";

describe("squeezeScore — auditable 0-100 composite", () => {
  it("max setup saturates near 100 with all three components maxed", () => {
    const r = squeezeScore({
      ticker: "GME",
      short_interest_pct_float: 35, // >= 30 saturates SI ramp
      days_to_cover: 10, // >= 7 saturates DTC ramp
      net_call_premium_usd: 5_000_000,
      net_put_premium_usd: 0, // all aggressive premium is calls -> full skew
      gamma_proximity: 1,
    });
    expect(r.short_component).toBeCloseTo(40, 6);
    expect(r.flow_component).toBeCloseTo(40, 6);
    expect(r.gamma_component).toBeCloseTo(20, 6);
    expect(r.score).toBeCloseTo(100, 6);
  });

  it("no crowding + bearish flow scores near zero", () => {
    const r = squeezeScore({
      ticker: "KO",
      short_interest_pct_float: 2, // below floor
      days_to_cover: 0.5,
      net_call_premium_usd: -1_000_000, // net put buying
      net_put_premium_usd: 1_000_000,
      gamma_proximity: 0,
    });
    expect(r.flow_component).toBe(0); // net calls <= 0
    expect(r.score).toBeLessThan(5);
    expect(r.notes.join(" ")).toMatch(/no bullish flow/);
  });

  it("flow_component is 0 when net call premium is negative regardless of skew", () => {
    const r = squeezeScore({
      ticker: "X",
      short_interest_pct_float: 20,
      days_to_cover: 4,
      net_call_premium_usd: -10,
      net_put_premium_usd: 1,
      gamma_proximity: 0.5,
    });
    expect(r.flow_component).toBe(0);
  });

  it("call skew scales flow_component between 50/50 and all-calls", () => {
    // callShare = 3/(3+1) = 0.75 -> skew = (0.75-0.5)/0.5 = 0.5 -> 20 pts
    const r = squeezeScore({
      ticker: "AMC",
      short_interest_pct_float: 10,
      days_to_cover: 3,
      net_call_premium_usd: 3_000_000,
      net_put_premium_usd: 1_000_000,
      gamma_proximity: 0.2,
    });
    expect(r.flow_component).toBeCloseTo(20, 6);
    expect(r.inputs.call_share).toBeCloseTo(0.75, 4);
  });

  it("never emits a bare score — sub-scores + raw inputs present", async () => {
    const r: any = await squeezeScoreHandler({
      ticker: "TSLA",
      short_interest_pct_float: 3,
      days_to_cover: 1.2,
      net_call_premium_usd: 800_000,
      gamma_proximity: 0.9,
    });
    expect(r).toHaveProperty("short_component");
    expect(r).toHaveProperty("flow_component");
    expect(r).toHaveProperty("gamma_component");
    expect(r.inputs.short_interest_pct_float).toBe(3);
    expect(r.inputs.gamma_proximity).toBe(0.9);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });
});

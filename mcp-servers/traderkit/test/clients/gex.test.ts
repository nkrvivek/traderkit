import { describe, expect, it } from "vitest";
import {
  bucketSizeFor,
  parseStrikeRows,
  computeGexAnalysis,
} from "../../src/clients/gex.js";

// Synthetic per-strike GEX grid, spot 100, integer strikes (bucket size = 1).
// Structure is hand-built so each computed level has an unambiguous winner.
const ROWS = [
  { strike: 90, call_gex: 1000, put_gex: -500, call_delta: 0, put_delta: 0 },
  { strike: 95, call_gex: 2000, put_gex: -9000, call_delta: 0, put_delta: 0 }, // max |put_gex| + most-neg net
  { strike: 98, call_gex: 500, put_gex: -3000, call_delta: 0, put_delta: 0 }, // negative
  { strike: 99, call_gex: 6000, put_gex: -1000, call_delta: 0, put_delta: 0 }, // neg→pos crossing ≤ spot ⇒ flip
  { strike: 100, call_gex: 3000, put_gex: -2000, call_delta: 100, put_delta: -40 }, // spot
  { strike: 105, call_gex: 12000, put_gex: -1000, call_delta: 0, put_delta: 0 }, // max call_gex + max net
  { strike: 108, call_gex: 8000, put_gex: -500, call_delta: 0, put_delta: 0 }, // 2nd net
  { strike: 110, call_gex: 4000, put_gex: -200, call_delta: 0, put_delta: 0 },
];

describe("gex bucketSizeFor", () => {
  it("index/ETF use fixed widths, equities scale ~0.5% of spot", () => {
    expect(bucketSizeFor("SPX", 5000)).toBe(25);
    expect(bucketSizeFor("SPY", 500)).toBe(5);
    expect(bucketSizeFor("AAPL", 315)).toBe(2); // round(1.575)
    expect(bucketSizeFor("TEST", 100)).toBe(1); // round(0.5)=1, floored at 1
  });
});

describe("gex parseStrikeRows", () => {
  it("computes net_gex/net_delta and drops malformed rows", () => {
    const parsed = parseStrikeRows([
      { strike: 100, call_gex: 5, put_gex: -2, call_delta: 3, put_delta: -1 },
      { strike: "bad", call_gex: 1, put_gex: 1 } as unknown as Record<string, unknown>,
      { call_gex: 1 } as unknown as Record<string, unknown>, // no strike
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.net_gex).toBe(3);
    expect(parsed[0]!.net_delta).toBe(2);
  });
});

describe("gex computeGexAnalysis", () => {
  const rows = parseStrikeRows(ROWS);
  const a = computeGexAnalysis(rows, "TEST", 100, { atmIv: 0.2376, shortCallStrike: 105 });

  it("identifies call wall, put wall, magnets, accelerator, flip", () => {
    expect(a.levels.call_wall!.strike).toBe(105); // max call_gex
    expect(a.levels.put_wall!.strike).toBe(95); // max |put_gex|
    expect(a.levels.max_magnet!.strike).toBe(105); // max net_gex
    expect(a.levels.second_magnet!.strike).toBe(108);
    expect(a.levels.max_accelerator!.strike).toBe(95); // most-negative net
    expect(a.levels.gex_flip!.strike).toBe(99); // neg(98)→pos(99) ≤ spot
  });

  it("sums net GEX and net DEX across all rows", () => {
    expect(a.net_gex).toBe(19300);
    expect(a.net_dex).toBe(60); // only strike 100 has deltas: 100 + (-40)
  });

  it("ranks upside call walls above spot by call_gex", () => {
    expect(a.upside_call_walls.map((w) => w.strike)).toEqual([105, 108, 110]);
  });

  it("tags the bucketed profile (SPOT / walls)", () => {
    const spotBucket = a.profile.find((b) => b.tag === "SPOT");
    expect(spotBucket!.strike).toBe(100);
  });

  it("computes a 1-day expected range from atm_iv", () => {
    expect(a.expected_range!.low!).toBeLessThan(100);
    expect(a.expected_range!.high!).toBeGreaterThan(100);
    expect(a.expected_range!.iv_1d!).toBeGreaterThan(0);
  });

  it("cc_signal classifies short strike vs nearest upside wall", () => {
    expect(computeGexAnalysis(rows, "TEST", 100, { shortCallStrike: 105 }).cc_signal!.vs_wall).toBe("at_wall");
    expect(computeGexAnalysis(rows, "TEST", 100, { shortCallStrike: 110 }).cc_signal!.vs_wall).toBe("above_wall_safe");
    expect(computeGexAnalysis(rows, "TEST", 100, { shortCallStrike: 102 }).cc_signal!.vs_wall).toBe("below_wall_risk");
  });
});

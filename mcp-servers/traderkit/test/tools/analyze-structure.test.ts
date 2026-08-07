import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  analyzeStructure,
  analyzeStructureHandler,
  bsPrice,
  type Leg,
} from "../../src/tools/analyze-structure.js";

// The contract: this TS engine must reproduce goldens.json, emitted by the
// Python reference oracle (scratchpad/options-analyzer/reference.py). Matching a
// different-language impl proves the math, not a shared bug.
const here = dirname(fileURLToPath(import.meta.url));
const goldens = JSON.parse(
  readFileSync(join(here, "../fixtures/options-analyzer-goldens.json"), "utf8"),
).goldens as Array<Record<string, any>>;

const T30 = 30 / 365;
const IV = 0.25;
const S = 100.0;
const R = 0.04;

// Mirror reference.py `_mk`: each option leg's entry_price = its fair BS value
// at spot (so P&L = 0 at entry).
function mk(name: string, legs: Omit<Leg, "entry_price">[]): {
  name: string;
  spot: number;
  r: number;
  legs: Leg[];
} {
  const priced = legs.map((l) =>
    l.right === "stock"
      ? { ...l, entry_price: 100.0 }
      : { ...l, entry_price: round4(bsPrice(S, l.strike, l.T, R, l.iv, l.right)) },
  );
  return { name, spot: S, r: R, legs: priced };
}
function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

const structures = [
  mk("long_call_atm", [{ right: "call", qty: 1, strike: 100, T: T30, iv: IV }]),
  mk("short_put_csp", [{ right: "put", qty: -1, strike: 95, T: T30, iv: IV }]),
  mk("bull_put_spread", [
    { right: "put", qty: -1, strike: 95, T: T30, iv: IV },
    { right: "put", qty: 1, strike: 90, T: T30, iv: IV },
  ]),
  mk("iron_condor", [
    { right: "call", qty: -1, strike: 105, T: T30, iv: IV },
    { right: "call", qty: 1, strike: 110, T: T30, iv: IV },
    { right: "put", qty: -1, strike: 95, T: T30, iv: IV },
    { right: "put", qty: 1, strike: 90, T: T30, iv: IV },
  ]),
  mk("debit_call_vertical", [
    { right: "call", qty: 1, strike: 100, T: T30, iv: IV },
    { right: "call", qty: -1, strike: 105, T: T30, iv: IV },
  ]),
  mk("covered_call", [
    { right: "stock", qty: 100, strike: 0, T: 0, iv: 0 },
    { right: "call", qty: -1, strike: 105, T: T30, iv: IV },
  ]),
];

describe("analyzeStructure — reproduces the Python golden vectors", () => {
  it("BS oracle self-check: ATM call S=K=100 T=1 r=0 σ=0.2 ≈ 7.9656", () => {
    expect(bsPrice(100, 100, 1.0, 0.0, 0.2, "call")).toBeCloseTo(7.9656, 3);
    // put-call parity: C - P = S - K e^{-rT}
    const c = bsPrice(100, 95, 0.5, 0.03, 0.25, "call");
    const p = bsPrice(100, 95, 0.5, 0.03, 0.25, "put");
    expect(c - p).toBeCloseTo(100 - 95 * Math.exp(-0.03 * 0.5), 6);
  });

  for (const g of goldens) {
    it(`${g.name}: every field matches the oracle`, () => {
      const s = structures.find((x) => x.name === g.name);
      expect(s, `structure ${g.name} defined in test`).toBeDefined();
      const out = analyzeStructure(s!);

      expect(out.max_profit_unbounded).toBe(g.max_profit_unbounded);
      expect(out.max_loss_unbounded).toBe(g.max_loss_unbounded);
      expect(out.horizon_days).toBeCloseTo(g.horizon_days, 4);
      expect(out.underlying_iv).toBeCloseTo(g.underlying_iv, 6);

      // grid-integrated / interpolated fields: match to the goldens' 4dp within
      // one ULP of grid + erf-approx noise (2dp tolerance for 2dp money fields).
      matchNullable(out.max_profit, g.max_profit, 2);
      matchNullable(out.max_loss, g.max_loss, 2);
      matchNullable(out.roc, g.roc, 3);
      matchNullable(out.pop, g.pop, 3);
      matchNullable(out.p50, g.p50, 3);
      matchNullable(out.prob_touch_nearest_be, g.prob_touch_nearest_be, 3);
      matchNullable(out.nearest_breakeven, g.nearest_breakeven, 2);

      for (const k of ["delta", "gamma", "theta", "vega", "rho"] as const) {
        expect(out.greeks[k], `${g.name}.greeks.${k}`).toBeCloseTo(g.greeks[k], 2);
      }
    });
  }
});

function matchNullable(got: number | null, want: number | null, digits: number): void {
  if (want === null) {
    expect(got).toBeNull();
  } else {
    expect(got).not.toBeNull();
    expect(got as number).toBeCloseTo(want, digits);
  }
}

describe("analyzeStructureHandler — validation", () => {
  it("rejects a zero-qty leg", async () => {
    await expect(
      analyzeStructureHandler({ spot: 100, legs: [{ right: "call", qty: 0, strike: 100, T: T30, iv: IV, entry_price: 2 }] }),
    ).rejects.toThrow();
  });

  it("throws when no option leg and no underlying_iv", async () => {
    await expect(
      analyzeStructureHandler({ spot: 100, legs: [{ right: "stock", qty: 100, entry_price: 100 }] }),
    ).rejects.toThrow(/underlying_iv/);
  });
});

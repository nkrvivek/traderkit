// analyze_structure — multi-leg desk metrics for a proposed options structure.
//
// Independent TypeScript implementation of the options-analyzer contract
// (scratchpad/options-analyzer/spec.md). It must reproduce goldens.json, which
// is emitted by the Python reference oracle (reference.py). Python-vs-TS on
// purpose: matching a different-language impl proves the math, not a shared bug.
//
// Conventions (PIN — must match the contract exactly):
//   - Time in YEARS. r = continuously-compounded annual risk-free, decimal.
//   - iv = annualized decimal (0.25 = 25%). Option multiplier 100, stock 1.
//   - Leg qty is SIGNED: +long / -short. entry_price = per-share premium,
//     always positive; P&L sign comes from qty.
//   - Greeks: theta per calendar day, vega & rho per 0.01, delta/gamma raw.
//     Position greek = Σ leg_greek * qty * mult, at spot, t=0.
//   - POP/P50 under the risk-neutral terminal law of the underlying.
import { z } from "zod";
import { round } from "../utils/math.js";

const SQRT2 = Math.sqrt(2.0);
const SQRT2PI = Math.sqrt(2.0 * Math.PI);

// JavaScript's Math has no erf. Abramowitz & Stegun 7.1.26 (max err ~1.5e-7),
// well inside the 4dp rounding the goldens compare at.
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1.0 / (1.0 + 0.3275911 * ax);
  const y =
    1.0 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

// Normal CDF and standard-normal pdf.
function normCdf(x: number): number {
  return 0.5 * (1.0 + erf(x / SQRT2));
}
function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / SQRT2PI;
}

export type Right = "call" | "put" | "stock";

export interface Leg {
  right: Right;
  qty: number; // signed: +long / -short
  strike: number;
  T: number; // years to expiry (option legs); 0 for stock
  iv: number; // annualized decimal (option legs); 0 for stock
  entry_price: number; // per-share premium (always positive), or stock cost basis
}

export function bsPrice(S: number, K: number, T: number, r: number, sigma: number, right: "call" | "put"): number {
  if (T <= 0 || sigma <= 0) {
    return right === "call" ? Math.max(S - K, 0.0) : Math.max(K - S, 0.0);
  }
  const sq = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / sq;
  const d2 = d1 - sq;
  if (right === "call") return S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
  return K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1);
}

interface Greeks {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
}

// Per-share greeks (before qty/multiplier). theta/day, vega & rho per 0.01.
export function bsGreeks(S: number, K: number, T: number, r: number, sigma: number, right: "call" | "put"): Greeks {
  if (T <= 0 || sigma <= 0) {
    const delta = right === "call" ? (S > K ? 1.0 : 0.0) : S < K ? -1.0 : 0.0;
    return { delta, gamma: 0.0, theta: 0.0, vega: 0.0, rho: 0.0 };
  }
  const root = Math.sqrt(T);
  const sq = sigma * root;
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / sq;
  const d2 = d1 - sq;
  const pdf = normPdf(d1);
  const gamma = pdf / (S * sq);
  const vega = S * pdf * root;
  let delta: number;
  let theta: number;
  let rho: number;
  if (right === "call") {
    delta = normCdf(d1);
    theta = -(S * pdf * sigma) / (2 * root) - r * K * Math.exp(-r * T) * normCdf(d2);
    rho = K * T * Math.exp(-r * T) * normCdf(d2);
  } else {
    delta = normCdf(d1) - 1.0;
    theta = -(S * pdf * sigma) / (2 * root) + r * K * Math.exp(-r * T) * normCdf(-d2);
    rho = -K * T * Math.exp(-r * T) * normCdf(-d2);
  }
  return { delta, gamma, theta: theta / 365.0, vega: vega / 100.0, rho: rho / 100.0 };
}

function mult(leg: Leg): number {
  return leg.right === "stock" ? 1 : 100;
}

function legIntrinsic(leg: Leg, sT: number): number {
  if (leg.right === "call") return Math.max(sT - leg.strike, 0.0);
  if (leg.right === "put") return Math.max(leg.strike - sT, 0.0);
  return sT; // stock
}

function pnlAtExpiry(legs: Leg[], sT: number): number {
  let total = 0.0;
  for (const leg of legs) total += leg.qty * mult(leg) * (legIntrinsic(leg, sT) - leg.entry_price);
  return total;
}

export const AnalyzeStructureArgs = z.object({
  name: z.string().optional(),
  spot: z.number().positive(),
  r: z.number().default(0.0),
  underlying_iv: z.number().positive().optional(),
  legs: z
    .array(
      z.object({
        right: z.enum(["call", "put", "stock"]),
        qty: z.number().refine((q) => q !== 0, "leg qty must be non-zero (signed +long/-short)"),
        strike: z.number().nonnegative().default(0),
        T: z.number().nonnegative().default(0),
        iv: z.number().nonnegative().default(0),
        entry_price: z.number().nonnegative(),
      }),
    )
    .min(1),
});

export type AnalyzeStructureInput = z.infer<typeof AnalyzeStructureArgs>;

function underlyingIv(a: AnalyzeStructureInput): number {
  if (a.underlying_iv !== undefined) return a.underlying_iv;
  const opts = a.legs.filter((l) => l.right !== "stock");
  if (opts.length === 0) throw new Error("no option leg and no underlying_iv provided");
  return opts.reduce((best, l) => (Math.abs(l.strike - a.spot) < Math.abs(best.strike - a.spot) ? l : best)).iv;
}

function horizon(a: AnalyzeStructureInput): number {
  const ts = a.legs.filter((l) => l.right !== "stock").map((l) => l.T);
  if (ts.length === 0) return 30 / 365;
  return Math.max(...ts);
}

export interface StructureAnalysis {
  name: string | null;
  spot: number;
  horizon_days: number;
  underlying_iv: number;
  max_profit: number | null;
  max_loss: number | null;
  max_profit_unbounded: boolean;
  max_loss_unbounded: boolean;
  roc: number | null;
  pop: number;
  p50: number | null;
  prob_touch_nearest_be: number | null;
  nearest_breakeven: number | null;
  greeks: Greeks;
}

export function analyzeStructure(a: AnalyzeStructureInput): StructureAnalysis {
  const S0 = a.spot;
  const r = a.r;
  const sig = underlyingIv(a);
  const T = horizon(a);
  const legs = a.legs as Leg[];

  // expiry payoff grid
  const N = 40001;
  const lo = 1e-4 * S0;
  const hi = 5.0 * S0;
  const step = (hi - lo) / (N - 1);
  // Float64Array for the 40001-point sweep. Index reads use `!` (repo
  // convention under noUncheckedIndexedAccess) — every access is in-bounds.
  const grid = new Float64Array(N);
  const payoff = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const s = lo + i * step;
    grid[i] = s;
    payoff[i] = pnlAtExpiry(legs, s);
  }

  let maxProfit = -Infinity;
  let maxLoss = Infinity;
  let imax = 0;
  let imin = 0;
  for (let i = 0; i < N; i++) {
    const p = payoff[i]!;
    if (p > maxProfit) {
      maxProfit = p;
      imax = i;
    }
    if (p < maxLoss) {
      maxLoss = p;
      imin = i;
    }
  }
  const upsideUnbounded = imax === 0 || imax === N - 1;
  const downsideUnbounded = imin === 0 || imin === N - 1;

  // risk-neutral lognormal terminal density
  const mu = Math.log(S0) + (r - 0.5 * sig * sig) * T;
  const sd = sig * Math.sqrt(T);
  const dens = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const s = grid[i]!;
    if (s <= 0) {
      dens[i] = 0.0;
    } else {
      const z = (Math.log(s) - mu) / sd;
      dens[i] = normPdf(z) / (s * sd);
    }
  }

  // Trapezoid of the terminal density over the region where `inRegion(i)` holds.
  const probWhere = (inRegion: (i: number) => boolean): number => {
    let tot = 0.0;
    for (let i = 0; i < N - 1; i++) {
      const f0 = inRegion(i) ? dens[i]! : 0.0;
      const f1 = inRegion(i + 1) ? dens[i + 1]! : 0.0;
      tot += 0.5 * (f0 + f1) * step;
    }
    return tot;
  };

  const pop = probWhere((i) => payoff[i]! > 0);
  let p50: number | null;
  if (upsideUnbounded) {
    p50 = null;
  } else {
    const thresh = 0.5 * maxProfit;
    p50 = probWhere((i) => payoff[i]! >= thresh);
  }

  const roc =
    upsideUnbounded || downsideUnbounded || maxLoss >= 0 ? null : maxProfit / Math.abs(maxLoss);

  // breakevens: sign changes of payoff (linear-interpolated zero crossings)
  const bes: number[] = [];
  for (let i = 0; i < N - 1; i++) {
    const y0 = payoff[i]!;
    const y1 = payoff[i + 1]!;
    if (y0 < 0 !== y1 < 0) {
      const x0 = grid[i]!;
      const x1 = grid[i + 1]!;
      bes.push(x0 - (y0 * (x1 - x0)) / (y1 - y0));
    }
  }
  let nearestBe: number | null = null;
  for (const b of bes) {
    if (nearestBe === null || Math.abs(b - S0) < Math.abs(nearestBe - S0)) nearestBe = b;
  }
  const probTouch =
    nearestBe === null ? null : Math.min(1.0, 2.0 * normCdf(-Math.abs(Math.log(nearestBe / S0)) / sd));

  // position greeks at S0, t=0
  const g: Greeks = { delta: 0.0, gamma: 0.0, theta: 0.0, vega: 0.0, rho: 0.0 };
  for (const leg of legs) {
    if (leg.right === "stock") {
      g.delta += leg.qty * 1.0;
      continue;
    }
    const m = mult(leg);
    const lg = bsGreeks(S0, leg.strike, leg.T, r, leg.iv, leg.right);
    g.delta += leg.qty * m * lg.delta;
    g.gamma += leg.qty * m * lg.gamma;
    g.theta += leg.qty * m * lg.theta;
    g.vega += leg.qty * m * lg.vega;
    g.rho += leg.qty * m * lg.rho;
  }

  return {
    name: a.name ?? null,
    spot: S0,
    horizon_days: round(T * 365, 1e4),
    underlying_iv: sig,
    max_profit: upsideUnbounded ? null : round(maxProfit, 100),
    max_loss: downsideUnbounded ? null : round(maxLoss, 100),
    max_profit_unbounded: upsideUnbounded,
    max_loss_unbounded: downsideUnbounded,
    roc: roc === null ? null : round(roc, 1e4),
    pop: round(pop, 1e4),
    p50: p50 === null ? null : round(p50, 1e4),
    prob_touch_nearest_be: probTouch === null ? null : round(probTouch, 1e4),
    nearest_breakeven: nearestBe === null ? null : round(nearestBe, 1e4),
    greeks: {
      delta: round(g.delta, 1e4),
      gamma: round(g.gamma, 1e4),
      theta: round(g.theta, 1e4),
      vega: round(g.vega, 1e4),
      rho: round(g.rho, 1e4),
    },
  };
}

export async function analyzeStructureHandler(raw: unknown): Promise<StructureAnalysis> {
  const args = AnalyzeStructureArgs.parse(raw);
  return analyzeStructure(args);
}

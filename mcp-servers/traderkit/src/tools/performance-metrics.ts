import { z } from "zod";
import { round as roundGeneric } from "../utils/math.js";

export const PerformanceMetricsArgs = z.object({
  returns: z.array(z.number()).min(1),
  risk_free_rate: z.number().default(0.05),
  periods_per_year: z.number().positive().default(252),
  min_observations: z.number().positive().default(20),
});

function mean(arr: readonly number[]): number {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function variance(arr: readonly number[], ddof: number): number {
  const m = mean(arr);
  return arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - ddof);
}

function sharpeRatio(returns: readonly number[], rfPerPeriod: number, periodsPerYear: number): number | null {
  const excess = returns.map((r) => r - rfPerPeriod);
  const std = Math.sqrt(variance(excess, 1));
  if (std === 0) return null;
  return (mean(excess) / std) * Math.sqrt(periodsPerYear);
}

function sortinoRatio(returns: readonly number[], rfPerPeriod: number, periodsPerYear: number): number | null {
  const excess = returns.map((r) => r - rfPerPeriod);
  const downside = excess.filter((r) => r < 0);
  if (downside.length === 0) return null;
  const downDev = Math.sqrt(variance(downside, 0));
  if (downDev === 0) return null;
  return (mean(excess) / downDev) * Math.sqrt(periodsPerYear);
}

function maxDrawdown(returns: readonly number[]): { mdd: number; peak_idx: number; trough_idx: number } {
  let peak = 1;
  let cumulative = 1;
  let mdd = 0;
  let peakIdx = 0;
  let troughIdx = 0;
  let currentPeakIdx = 0;

  for (let i = 0; i < returns.length; i++) {
    cumulative *= 1 + returns[i]!;
    if (cumulative > peak) {
      peak = cumulative;
      currentPeakIdx = i;
    }
    const dd = (peak - cumulative) / peak;
    if (dd > mdd) {
      mdd = dd;
      peakIdx = currentPeakIdx;
      troughIdx = i;
    }
  }
  return { mdd, peak_idx: peakIdx, trough_idx: troughIdx };
}

function calmarRatio(returns: readonly number[], periodsPerYear: number): number | null {
  const { mdd } = maxDrawdown(returns);
  if (mdd === 0) return null;
  const annReturn = mean(returns) * periodsPerYear;
  return annReturn / mdd;
}

function winRate(returns: readonly number[]): { rate: number; avg_win: number; avg_loss: number } {
  const wins = returns.filter((r) => r > 0);
  const losses = returns.filter((r) => r < 0);
  return {
    rate: wins.length / returns.length,
    avg_win: wins.length > 0 ? mean(wins) : 0,
    avg_loss: losses.length > 0 ? mean(losses) : 0,
  };
}

export async function performanceMetricsHandler(raw: unknown) {
  const args = PerformanceMetricsArgs.parse(raw);
  const { returns, risk_free_rate, periods_per_year, min_observations } = args;

  if (returns.length < min_observations) {
    return {
      error: `insufficient data: ${returns.length} observations, need ${min_observations}`,
      observations: returns.length,
    };
  }

  const rfPerPeriod = risk_free_rate / periods_per_year;
  const dd = maxDrawdown(returns);
  const wr = winRate(returns);

  return {
    observations: returns.length,
    annualized_return: round(mean(returns) * periods_per_year),
    annualized_volatility: round(Math.sqrt(variance(returns, 1)) * Math.sqrt(periods_per_year)),
    sharpe_ratio: maybeRound(sharpeRatio(returns, rfPerPeriod, periods_per_year)),
    sortino_ratio: maybeRound(sortinoRatio(returns, rfPerPeriod, periods_per_year)),
    max_drawdown: round(dd.mdd),
    max_drawdown_peak_idx: dd.peak_idx,
    max_drawdown_trough_idx: dd.trough_idx,
    calmar_ratio: maybeRound(calmarRatio(returns, periods_per_year)),
    win_rate: round(wr.rate),
    avg_win: round(wr.avg_win),
    avg_loss: round(wr.avg_loss),
    risk_free_rate,
    periods_per_year,
  };
}

function round(n: number): number {
  return roundGeneric(n, 1e6);
}

function maybeRound(n: number | null): number | null {
  return n === null ? null : round(n);
}

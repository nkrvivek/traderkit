import { toMessage } from "../utils/errors.js";
import * as fmpSpend from "./fmp-spend.js";

const FMP_BASE = process.env.FMP_BASE ?? "https://financialmodelingprep.com/stable";

// A zero row at load separates "this process ran and spent nothing" from "this
// consumer has no counter at all". Without it every quiet day reads as a
// finding, and a rail that is never clean stops being read.
fmpSpend.touch();

export interface FmpQuote {
  ticker: string;
  price?: number | undefined;
  change?: number | undefined;
  change_pct?: number | undefined;
  market_cap_usd?: number | undefined;
  volume?: number | undefined;
  day_low?: number | undefined;
  day_high?: number | undefined;
  year_low?: number | undefined;
  year_high?: number | undefined;
  avg50?: number | undefined;
  avg200?: number | undefined;
  exchange?: string | undefined;
}

export interface FmpDcf {
  ticker: string;
  dcf?: number | undefined;
  stock_price?: number | undefined;
  date?: string | undefined;
}

export interface FmpPriceTarget {
  ticker: string;
  target_high?: number | undefined;
  target_low?: number | undefined;
  target_median?: number | undefined;
  target_consensus?: number | undefined;
}

export interface FmpEarnings {
  ticker: string;
  next_earnings_date?: string | undefined;
  timing?: "bmo" | "amc" | "unknown" | undefined;
  eps_estimated?: number | undefined;
  revenue_estimated?: number | undefined;
}

function sanitizeBody(body: string, token: string): string {
  const stripped = token ? body.split(token).join("[redacted]") : body;
  return stripped.slice(0, 200);
}

async function fmpGet(path: string, params: Record<string, string>): Promise<unknown> {
  const key = process.env.FMP_API_KEY;
  if (!key) throw new Error("FMP_API_KEY not set");
  const qs = new URLSearchParams({ ...params, apikey: key });
  const url = `${FMP_BASE}${path}?${qs}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: "application/json" } });
  } catch (e) {
    // Network/TLS/DNS errors: Node may include the URL (w/ apikey) in the message.
    throw new Error(`FMP fetch ${path}: ${sanitizeBody(toMessage(e), key)}`);
  }
  // Weighed before the status checks. A 402 and a 429 both cost bandwidth, and
  // a counter that only counted the calls that worked would understate the
  // exact days the shared key was in trouble.
  fmpSpend.record(fmpSpend.responseBytes(res), res.status === 429);
  if (res.status === 402) {
    throw new Error(`FMP 402 ${path}: restricted — upgrade tier`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`FMP ${res.status} ${path}: ${sanitizeBody(body, key)}`);
  }
  return res.json();
}

function asArray(x: unknown): Record<string, unknown>[] {
  return Array.isArray(x) ? (x as Record<string, unknown>[]) : [];
}

function asNumber(x: unknown): number | undefined {
  if (x === null || x === undefined || x === "") return undefined;
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
}

function asString(x: unknown): string | undefined {
  return typeof x === "string" && x.length > 0 ? x : undefined;
}

function parseTiming(raw: unknown): "bmo" | "amc" | "unknown" {
  const h = String(raw ?? "").toLowerCase();
  if (h === "bmo" || h === "before market open") return "bmo";
  if (h === "amc" || h === "after market close") return "amc";
  return "unknown";
}

export async function fmpQuote(ticker: string): Promise<FmpQuote> {
  const T = ticker.toUpperCase();
  try {
    const rows = asArray(await fmpGet("/quote", { symbol: T }));
    const q = rows[0] ?? {};
    return {
      ticker: T,
      price: asNumber(q.price),
      change: asNumber(q.change),
      change_pct: asNumber(q.changePercentage),
      market_cap_usd: asNumber(q.marketCap),
      volume: asNumber(q.volume),
      day_low: asNumber(q.dayLow),
      day_high: asNumber(q.dayHigh),
      year_low: asNumber(q.yearLow),
      year_high: asNumber(q.yearHigh),
      avg50: asNumber(q.priceAvg50),
      avg200: asNumber(q.priceAvg200),
      exchange: asString(q.exchange),
    };
  } catch (e) {
    process.stderr.write(`traderkit: fmpQuote(${T}) failed: ${toMessage(e)}\n`);
    return { ticker: T };
  }
}

export async function fmpDcf(ticker: string): Promise<FmpDcf> {
  const T = ticker.toUpperCase();
  try {
    const rows = asArray(await fmpGet("/discounted-cash-flow", { symbol: T }));
    const r = rows[0] ?? {};
    return {
      ticker: T,
      dcf: asNumber(r.dcf),
      stock_price: asNumber(r["Stock Price"] ?? r.stockPrice),
      date: asString(r.date),
    };
  } catch (e) {
    process.stderr.write(`traderkit: fmpDcf(${T}) failed: ${toMessage(e)}\n`);
    return { ticker: T };
  }
}

export async function fmpPriceTarget(ticker: string): Promise<FmpPriceTarget> {
  const T = ticker.toUpperCase();
  try {
    const rows = asArray(await fmpGet("/price-target-consensus", { symbol: T }));
    const r = rows[0] ?? {};
    return {
      ticker: T,
      target_high: asNumber(r.targetHigh),
      target_low: asNumber(r.targetLow),
      target_median: asNumber(r.targetMedian),
      target_consensus: asNumber(r.targetConsensus),
    };
  } catch (e) {
    process.stderr.write(`traderkit: fmpPriceTarget(${T}) failed: ${toMessage(e)}\n`);
    return { ticker: T };
  }
}

export interface FmpInstHolder {
  holder_name: string;
  cik?: string | undefined;
  shares?: number | undefined;
  market_value_usd?: number | undefined;
  weight_pct?: number | undefined;
  change_shares?: number | undefined;
  change_pct?: number | undefined;
  report_date?: string | undefined;
}

export interface FmpFundHolding {
  ticker: string;
  shares?: number | undefined;
  market_value_usd?: number | undefined;
  weight_pct?: number | undefined;
  change_shares?: number | undefined;
  change_pct?: number | undefined;
  report_date?: string | undefined;
}

export async function fmpInstHoldersByTicker(ticker: string): Promise<FmpInstHolder[]> {
  const T = ticker.toUpperCase();
  const candidates: [string, Record<string, string>][] = [
    ["/institutional-ownership/symbol-ownership", { symbol: T }],
    ["/institutional-ownership/institutional-holders/symbol-ownership", { symbol: T }],
    ["/institutional-holder", { symbol: T }],
  ];
  for (const [path, params] of candidates) {
    try {
      const rows = asArray(await fmpGet(path, params));
      if (!rows.length) continue;
      return rows.map((r) => ({
        holder_name: String(r.investorName ?? r.holder ?? r.name ?? r.filingManagerName ?? "unknown"),
        cik: asString(r.cik),
        shares: asNumber(r.sharesNumber ?? r.shares),
        market_value_usd: asNumber(r.marketValue ?? r.value ?? r.marketValueUsd),
        weight_pct: asNumber(r.weight ?? r.ownership ?? r.weightPct),
        change_shares: asNumber(r.changeInSharesNumber ?? r.change ?? r.sharesChange),
        change_pct: asNumber(r.changeInSharesNumberPercentage ?? r.changePct),
        report_date: asString(r.date ?? r.reportDate ?? r.filingDate),
      }));
    } catch (e) {
      const msg = toMessage(e);
      if (!/402|404/.test(msg)) {
        process.stderr.write(`traderkit: fmpInstHoldersByTicker(${T}) ${path} failed: ${msg}\n`);
      }
    }
  }
  return [];
}

export async function fmpFundHoldings(cik: string): Promise<FmpFundHolding[]> {
  const C = cik.replace(/^0+/, "").padStart(10, "0");
  const candidates: [string, Record<string, string>][] = [
    ["/institutional-ownership/portfolio-holdings-summary", { cik: C }],
    ["/form-thirteen", { cik: C }],
    ["/institutional-ownership/extract", { cik: C }],
  ];
  for (const [path, params] of candidates) {
    try {
      const rows = asArray(await fmpGet(path, params));
      if (!rows.length) continue;
      return rows.map((r) => ({
        ticker: String(r.symbol ?? r.ticker ?? r.tickercusip ?? "").toUpperCase(),
        shares: asNumber(r.sharesNumber ?? r.shares),
        market_value_usd: asNumber(r.marketValue ?? r.value),
        weight_pct: asNumber(r.weight ?? r.weightPct),
        change_shares: asNumber(r.changeInSharesNumber ?? r.sharesChange),
        change_pct: asNumber(r.changeInSharesNumberPercentage ?? r.changePct),
        report_date: asString(r.date ?? r.reportDate ?? r.filingDate),
      })).filter((h) => h.ticker);
    } catch (e) {
      const msg = toMessage(e);
      if (!/402|404/.test(msg)) {
        process.stderr.write(`traderkit: fmpFundHoldings(${C}) ${path} failed: ${msg}\n`);
      }
    }
  }
  return [];
}

export async function fmpEarnings(ticker: string, fromIso?: string, toIso?: string): Promise<FmpEarnings> {
  const T = ticker.toUpperCase();
  const today = new Date();
  const from = fromIso ?? today.toISOString().slice(0, 10);
  const to = toIso ?? new Date(today.getTime() + 90 * 86_400_000).toISOString().slice(0, 10);
  try {
    const rows = asArray(await fmpGet("/earnings-calendar", { from, to }));
    const match = rows
      .filter((r) => asString(r.symbol)?.toUpperCase() === T)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))[0];
    if (!match) return { ticker: T };
    return {
      ticker: T,
      next_earnings_date: asString(match.date),
      timing: parseTiming(match.time),
      eps_estimated: asNumber(match.epsEstimated),
      revenue_estimated: asNumber(match.revenueEstimated),
    };
  } catch (e) {
    process.stderr.write(`traderkit: fmpEarnings(${T}) failed: ${toMessage(e)}\n`);
    return { ticker: T };
  }
}

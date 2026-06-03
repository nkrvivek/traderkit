import { toMessage } from "../utils/errors.js";

const AV_BASE = process.env.ALPHA_VANTAGE_BASE ?? "https://www.alphavantage.co/query";

export interface AvQuote {
  ticker: string;
  price?: number | undefined;
  change?: number | undefined;
  change_pct?: string | undefined;
  volume?: number | undefined;
  prev_close?: number | undefined;
  latest_trading_day?: string | undefined;
}

function sanitizeBody(body: string, token: string): string {
  const stripped = token ? body.split(token).join("[redacted]") : body;
  return stripped.slice(0, 200);
}

async function avGet(params: Record<string, string>): Promise<unknown> {
  const token = process.env.ALPHA_VANTAGE_API_KEY;
  if (!token) throw new Error("ALPHA_VANTAGE_API_KEY not set");
  const merged = { ...params, apikey: token };
  const qs = new URLSearchParams(merged);
  const url = `${AV_BASE}?${qs}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`AlphaVantage ${res.status}: ${sanitizeBody(body, token)}`);
  }
  return res.json();
}

function asRecord(x: unknown): Record<string, unknown> {
  return x && typeof x === "object" ? (x as Record<string, unknown>) : {};
}

function asNumber(x: unknown): number | undefined {
  if (x === null || x === undefined || x === "") return undefined;
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
}

function asString(x: unknown): string | undefined {
  return typeof x === "string" && x.length > 0 ? x : undefined;
}

export async function avGlobalQuote(ticker: string): Promise<AvQuote> {
  const T = ticker.toUpperCase();
  try {
    const j = asRecord(await avGet({ function: "GLOBAL_QUOTE", symbol: T }));
    const q = asRecord(j["Global Quote"]);
    if (!Object.keys(q).length) {
      const note = asString(j["Note"]) ?? asString(j["Information"]);
      if (note) throw new Error(`AlphaVantage throttled: ${note}`);
    }
    return {
      ticker: T,
      price: asNumber(q["05. price"]),
      change: asNumber(q["09. change"]),
      change_pct: asString(q["10. change percent"]),
      volume: asNumber(q["06. volume"]),
      prev_close: asNumber(q["08. previous close"]),
      latest_trading_day: asString(q["07. latest trading day"]),
    };
  } catch (e) {
    process.stderr.write(`traderkit: avGlobalQuote(${T}) failed: ${toMessage(e)}\n`);
    return { ticker: T };
  }
}

export interface AvSeriesPoint {
  date: string;
  value: number;
}

export async function avMacroSeries(seriesFunction: string): Promise<AvSeriesPoint[]> {
  try {
    const j = asRecord(await avGet({ function: seriesFunction }));
    const raw = j["data"];
    if (!Array.isArray(raw)) {
      const note = asString(j["Note"]) ?? asString(j["Information"]);
      if (note) throw new Error(`AlphaVantage throttled: ${note}`);
      return [];
    }
    const out: AvSeriesPoint[] = [];
    for (const r of raw) {
      const row = asRecord(r);
      const d = asString(row.date);
      const v = asNumber(row.value);
      if (d && v !== undefined) out.push({ date: d, value: v });
    }
    return out;
  } catch (e) {
    process.stderr.write(`traderkit: avMacroSeries(${seriesFunction}) failed: ${toMessage(e)}\n`);
    return [];
  }
}

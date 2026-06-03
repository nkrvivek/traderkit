import { toMessage } from "../utils/errors.js";

const UW_BASE = process.env.UW_BASE ?? "https://api.unusualwhales.com/api";

export interface UWOptionContract {
  option_symbol: string;
  ticker: string;
  type: "call" | "put";
  strike: number;
  expiry: string;
  bid?: number | undefined;
  ask?: number | undefined;
  mid?: number | undefined;
  delta?: number | undefined;
  gamma?: number | undefined;
  theta?: number | undefined;
  vega?: number | undefined;
  iv?: number | undefined;
  open_interest?: number | undefined;
  volume?: number | undefined;
}

export interface UWIvRank {
  ticker: string;
  iv_rank?: number | undefined;
  iv_percentile?: number | undefined;
  iv30?: number | undefined;
}

function sanitizeBody(body: string, token: string): string {
  const stripped = token ? body.split(token).join("[redacted]") : body;
  return stripped.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]").slice(0, 200);
}

async function uwGet(path: string, params: Record<string, string | number | undefined>): Promise<unknown> {
  const token = process.env.UW_TOKEN;
  if (!token) throw new Error("UW_TOKEN not set");
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.set(k, String(v));
  }
  const url = `${UW_BASE}${path}${qs.toString() ? `?${qs}` : ""}`;
  const maxAttempts = 3;
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": "traderkit/0.5 (+https://github.com/nkrvivek/traderkit)",
      },
    });
    const body = await res.text();
    if (!res.ok) {
      if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts - 1) {
        const delay =
          res.status === 429
            ? Number(res.headers.get("Retry-After") ?? 0) * 1000 || 1000 * (attempt + 1)
            : 300 * (attempt + 1);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw new Error(`UW ${res.status} ${path}: ${sanitizeBody(body, token)}`);
    }
    try {
      return JSON.parse(body);
    } catch (err) {
      lastErr = err as Error;
      if (attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
        continue;
      }
    }
  }
  throw new Error(`UW ${path}: schema-text response after ${maxAttempts} attempts (${lastErr?.message})`);
}

function parseOccSymbol(sym: string): { ticker: string; expiry: string; type: "call" | "put"; strike: number } | null {
  const s = sym.trim().replace(/\s+/g, "");
  const m = s.match(/^([A-Z.]{1,6})(\d{6})([CP])(\d{8})$/);
  if (!m || !m[1] || !m[2] || !m[3] || !m[4]) return null;
  const ticker = m[1];
  const yymmdd = m[2];
  const cp = m[3];
  const strikeRaw = m[4];
  const yy = Number(yymmdd.slice(0, 2));
  const year = yy < 70 ? 2000 + yy : 1900 + yy;
  const expiry = `${year}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
  return {
    ticker,
    expiry,
    type: cp === "C" ? "call" : "put",
    strike: Number(strikeRaw) / 1000,
  };
}

function toNum(x: unknown): number | undefined {
  if (x === null || x === undefined || x === "") return undefined;
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
}

function asRecord(x: unknown): Record<string, unknown> {
  return x && typeof x === "object" ? (x as Record<string, unknown>) : {};
}

function dataArray(x: unknown): Record<string, unknown>[] {
  const rec = asRecord(x);
  return Array.isArray(rec.data) ? (rec.data as Record<string, unknown>[]) : [];
}

export async function uwOptionChain(ticker: string, expiry: string): Promise<UWOptionContract[]> {
  const T = ticker.toUpperCase();
  const today = new Date().toISOString().slice(0, 10);
  const [quotesJson, greeksJson] = await Promise.all([
    uwGet(`/stock/${T}/option-contracts`, { expiry }),
    uwGet(`/stock/${T}/greeks`, { expiry, date: today }).catch((e) => {
      process.stderr.write(`traderkit: uw greeks(${T}, ${expiry}) failed: ${toMessage(e)}\n`);
      return { data: [] };
    }),
  ]);

  const greekRows = dataArray(greeksJson);
  const greeksBySym = new Map<string, { side: "call" | "put"; row: Record<string, unknown> }>();
  for (const row of greekRows) {
    if (row.call_option_symbol) greeksBySym.set(String(row.call_option_symbol), { side: "call", row });
    if (row.put_option_symbol) greeksBySym.set(String(row.put_option_symbol), { side: "put", row });
  }

  const quoteRows = dataArray(quotesJson);
  const out: UWOptionContract[] = [];
  for (const q of quoteRows) {
    const sym = String(q.option_symbol ?? "");
    const parsed = parseOccSymbol(sym);
    if (!parsed) continue;
    const g = greeksBySym.get(sym);
    const bid = toNum(q.nbbo_bid);
    const ask = toNum(q.nbbo_ask);
    const mid = bid !== undefined && ask !== undefined ? (bid + ask) / 2 : undefined;
    const delta = g ? toNum(g.side === "call" ? g.row.call_delta : g.row.put_delta) : undefined;
    const gamma = g ? toNum(g.side === "call" ? g.row.call_gamma : g.row.put_gamma) : undefined;
    const theta = g ? toNum(g.side === "call" ? g.row.call_theta : g.row.put_theta) : undefined;
    const vega = g ? toNum(g.side === "call" ? g.row.call_vega : g.row.put_vega) : undefined;
    const iv = toNum(q.implied_volatility) ?? (g ? toNum(g.side === "call" ? g.row.call_volatility : g.row.put_volatility) : undefined);
    out.push({
      option_symbol: sym,
      ticker: T,
      type: parsed.type,
      strike: parsed.strike,
      expiry: parsed.expiry,
      bid,
      ask,
      mid,
      delta,
      gamma,
      theta,
      vega,
      iv,
      open_interest: toNum(q.open_interest),
      volume: toNum(q.volume),
    });
  }
  return out;
}

export async function uwExpiryList(ticker: string): Promise<string[]> {
  const json = await uwGet(`/stock/${ticker.toUpperCase()}/expiry-breakdown`, {});
  return dataArray(json).map((r) => String(r.expires ?? r.expiry ?? "")).filter(Boolean);
}

export async function uwIvRank(ticker: string): Promise<UWIvRank> {
  const T = ticker.toUpperCase();
  try {
    const json = await uwGet(`/stock/${T}/iv-rank`, {});
    const rows = dataArray(json);
    const latest = rows.length ? rows[rows.length - 1]! : {};
    return {
      ticker: T,
      iv_rank: toNum(latest.iv_rank),
      iv_percentile: toNum(latest.iv_percentile),
      iv30: toNum(latest.iv30 ?? latest.iv),
    };
  } catch (e) {
    process.stderr.write(`traderkit: uwIvRank(${T}) failed: ${toMessage(e)}\n`);
    return { ticker: T };
  }
}

export interface UWDarkpoolTrade {
  size: number;
  price: number;
  premium: number;
  nbbo_bid: number;
  nbbo_ask: number;
  canceled: boolean;
  executed_at?: string | undefined;
  market_center?: string | undefined;
  raw: Record<string, unknown>;
}

export async function uwDarkpoolFlow(
  ticker: string,
  opts: { date?: string; minPremium?: number; limit?: number } = {},
): Promise<UWDarkpoolTrade[]> {
  const T = ticker.toUpperCase();
  const params: Record<string, string | number | undefined> = {};
  if (opts.date) params.date = opts.date;
  if (opts.minPremium !== undefined) params.min_premium = opts.minPremium;
  if (opts.limit !== undefined) params.limit = opts.limit;
  try {
    const json = await uwGet(`/darkpool/${T}`, params);
    return dataArray(json).map((r) => ({
      size: toNum(r.size) ?? 0,
      price: toNum(r.price) ?? 0,
      premium: toNum(r.premium) ?? 0,
      nbbo_bid: toNum(r.nbbo_bid) ?? 0,
      nbbo_ask: toNum(r.nbbo_ask) ?? 0,
      canceled: Boolean(r.canceled),
      executed_at: r.executed_at != null ? String(r.executed_at) : undefined,
      market_center: r.market_center != null ? String(r.market_center) : undefined,
      raw: r,
    }));
  } catch (e) {
    process.stderr.write(`traderkit: uwDarkpoolFlow(${T}) failed: ${toMessage(e)}\n`);
    return [];
  }
}

export interface UWFlowAlert {
  ticker: string;
  type: "CALL" | "PUT" | "";
  is_call: boolean;
  premium: number;
  total_premium: number;
  volume: number;
  open_interest: number;
  volume_oi_ratio: number;
  has_sweep: boolean;
  is_floor: boolean;
  is_ask_side: boolean;
  is_bid_side: boolean;
  strike?: number | undefined;
  expiry?: string | undefined;
  underlying_price?: number | undefined;
  marketcap?: number | undefined;
  sector?: string | undefined;
  issue_type?: string | undefined;
  raw: Record<string, unknown>;
}

export async function uwFlowAlerts(opts: {
  ticker?: string;
  minPremium?: number;
  maxPremium?: number;
  isCall?: boolean;
  isPut?: boolean;
  isSweep?: boolean;
  minDte?: number;
  maxDte?: number;
  minVolumeOiRatio?: number;
  limit?: number;
} = {}): Promise<UWFlowAlert[]> {
  const params: Record<string, string | number | undefined> = {};
  if (opts.ticker) params.ticker_symbol = opts.ticker.toUpperCase();
  if (opts.minPremium !== undefined) params.min_premium = opts.minPremium;
  if (opts.maxPremium !== undefined) params.max_premium = opts.maxPremium;
  if (opts.isCall !== undefined) params.is_call = String(opts.isCall);
  if (opts.isPut !== undefined) params.is_put = String(opts.isPut);
  if (opts.isSweep !== undefined) params.is_sweep = String(opts.isSweep);
  if (opts.minDte !== undefined) params.min_dte = opts.minDte;
  if (opts.maxDte !== undefined) params.max_dte = opts.maxDte;
  if (opts.minVolumeOiRatio !== undefined) params.min_volume_oi_ratio = opts.minVolumeOiRatio;
  if (opts.limit !== undefined) params.limit = opts.limit;
  try {
    const json = await uwGet(`/option-trades/flow-alerts`, params);
    return dataArray(json).map((r) => {
      const t = String(r.type ?? "").toUpperCase();
      const type: "CALL" | "PUT" | "" = t === "CALL" || t === "PUT" ? t : "";
      return {
        ticker: String(r.ticker ?? "").toUpperCase(),
        type,
        is_call: type === "CALL" || Boolean(r.is_call),
        premium: toNum(r.premium) ?? 0,
        total_premium: toNum(r.total_premium) ?? toNum(r.premium) ?? 0,
        volume: toNum(r.volume) ?? 0,
        open_interest: toNum(r.open_interest) ?? 0,
        volume_oi_ratio: toNum(r.volume_oi_ratio) ?? 0,
        has_sweep: Boolean(r.has_sweep),
        is_floor: Boolean(r.is_floor),
        is_ask_side: Boolean(r.is_ask_side),
        is_bid_side: Boolean(r.is_bid_side),
        strike: toNum(r.strike),
        expiry: r.expiry != null ? String(r.expiry) : undefined,
        underlying_price: toNum(r.underlying_price),
        marketcap: toNum(r.marketcap),
        sector: r.sector != null ? String(r.sector) : undefined,
        issue_type: r.issue_type != null ? String(r.issue_type) : undefined,
        raw: r,
      };
    });
  } catch (e) {
    process.stderr.write(`traderkit: uwFlowAlerts failed: ${toMessage(e)}\n`);
    return [];
  }
}

export interface UWOiChange {
  option_symbol: string;
  underlying_symbol: string;
  oi_diff_plain: number;
  curr_oi: number;
  prev_oi: number;
  prev_total_premium: number;
  raw: Record<string, unknown>;
}

export async function uwStockOiChange(ticker: string): Promise<UWOiChange[]> {
  const T = ticker.toUpperCase();
  try {
    const json = await uwGet(`/stock/${T}/oi-change`, {});
    return dataArray(json).map(toOiChange);
  } catch (e) {
    process.stderr.write(`traderkit: uwStockOiChange(${T}) failed: ${toMessage(e)}\n`);
    return [];
  }
}

export async function uwMarketOiChange(): Promise<UWOiChange[]> {
  try {
    const json = await uwGet(`/market/oi-change`, {});
    return dataArray(json).map(toOiChange);
  } catch (e) {
    process.stderr.write(`traderkit: uwMarketOiChange failed: ${toMessage(e)}\n`);
    return [];
  }
}

function toOiChange(r: Record<string, unknown>): UWOiChange {
  const sym = String(r.option_symbol ?? "");
  const underlying = String(r.underlying_symbol ?? sym.slice(0, 4));
  return {
    option_symbol: sym,
    underlying_symbol: underlying,
    oi_diff_plain: toNum(r.oi_diff_plain) ?? 0,
    curr_oi: toNum(r.curr_oi) ?? 0,
    prev_oi: toNum(r.prev_oi) ?? 0,
    prev_total_premium: toNum(r.prev_total_premium) ?? 0,
    raw: r,
  };
}

export async function uwStockState(ticker: string): Promise<{ price?: number | undefined; change_pct?: number | undefined }> {
  const T = ticker.toUpperCase();
  try {
    const json = await uwGet(`/stock/${T}/stock-state`, {});
    const d = asRecord(asRecord(json).data);
    const close = toNum(d.close);
    const prev = toNum(d.prev_close);
    return {
      price: close,
      change_pct: close !== undefined && prev !== undefined && prev > 0 ? (close - prev) / prev : undefined,
    };
  } catch (e) {
    process.stderr.write(`traderkit: uwStockState(${T}) failed: ${toMessage(e)}\n`);
    return {};
  }
}

// =============================================================================
// UW passthrough fetchers — replace the (removed) mcp__unusualwhales__* MCP.
// All paths LIVE-VERIFIED against api.unusualwhales.com 2026-06-03 (HTTP 200).
// Ported from trade-refresh src/uw_client.py, path-corrected where the Python
// had stale 404 paths (shorts/seasonality/news/technicals/institutions/alerts).
// Each returns the response `.data` payload (array or object) for agent reading.
// =============================================================================

/** Return the UW envelope's `.data` field (array or object), else the raw json. */
function uwPayload(json: unknown): unknown {
  const rec = asRecord(json);
  return "data" in rec ? rec.data : json;
}

/** Thin GET → `.data`, with structured failure (never throws to the tool layer). */
async function uwFetch(label: string, path: string, params: Record<string, string | number | undefined> = {}): Promise<unknown> {
  try {
    return uwPayload(await uwGet(path, params));
  } catch (e) {
    process.stderr.write(`traderkit: ${label} failed: ${toMessage(e)}\n`);
    return { error: toMessage(e), data: [] };
  }
}

const T = (t: string) => t.toUpperCase();

// --- darkpool ---
export const uwDarkpoolRecentRaw = (limit = 100) => uwFetch("uwDarkpoolRecent", `/darkpool/recent`, { limit });
export const uwDarkpoolTickerRaw = (ticker: string, limit = 500) => uwFetch("uwDarkpoolTicker", `/darkpool/${T(ticker)}`, { limit });

// --- flow ---
export const uwFlowMarketRaw = (limit = 50) => uwFetch("uwFlowMarket", `/option-trades/flow-alerts`, { limit });
export const uwFlowTickerRaw = (ticker: string, limit = 50) => uwFetch("uwFlowTicker", `/stock/${T(ticker)}/flow-alerts`, { limit });

// --- insider ---
export const uwInsiderTransactionsRaw = (ticker: string | undefined, limit = 50) =>
  uwFetch("uwInsiderTransactions", `/insider/transactions`, ticker ? { ticker_symbol: T(ticker), limit } : { limit });
export const uwInsiderBuySellsRaw = (ticker: string) => uwFetch("uwInsiderBuySells", `/stock/${T(ticker)}/insider-buy-sells`, {});

// --- congress ---
export const uwCongressRecentRaw = (limit = 50) => uwFetch("uwCongressRecent", `/congress/recent-trades`, { limit });
export const uwCongressLateRaw = (limit = 50) => uwFetch("uwCongressLate", `/congress/late-reports`, { limit });

// --- shorts ---
export const uwShortsDataRaw = (ticker: string) => uwFetch("uwShortsData", `/shorts/${T(ticker)}/data`, {});
export const uwShortsInterestFloatRaw = (ticker: string) => uwFetch("uwShortsInterestFloat", `/shorts/${T(ticker)}/interest-float`, {});
export const uwShortsVolumeRatioRaw = (ticker: string) => uwFetch("uwShortsVolumeRatio", `/shorts/${T(ticker)}/volume-and-ratio`, {});

// --- institutions ---
export const uwInstitutionsListRaw = (limit = 50) => uwFetch("uwInstitutionsList", `/institutions`, { limit });
export const uwInstitutionOwnershipRaw = (name: string) => uwFetch("uwInstitutionOwnership", `/institution/${encodeURIComponent(name)}/ownership`, {});

// --- seasonality ---
export const uwSeasonalityMonthlyRaw = (ticker: string) => uwFetch("uwSeasonalityMonthly", `/seasonality/${T(ticker)}/monthly`, {});
export const uwSeasonalityYearMonthRaw = (ticker: string) => uwFetch("uwSeasonalityYearMonth", `/seasonality/${T(ticker)}/year-month`, {});
export const uwSeasonalityMarketRaw = () => uwFetch("uwSeasonalityMarket", `/seasonality/market`, {});

// --- news ---
export const uwNewsRaw = (ticker: string | undefined, limit = 25) =>
  uwFetch("uwNews", `/news/headlines`, ticker ? { ticker: T(ticker), limit } : { limit });

// --- technicals (options-positioning bundle) ---
export const uwGreekExposureRaw = (ticker: string) => uwFetch("uwGreekExposure", `/stock/${T(ticker)}/greek-exposure`, {});
// per-strike GEX grid (call_gex/put_gex/call_delta/put_delta by strike) — source for wall computation
export const uwGreekExposureByStrikeRaw = (ticker: string) => uwFetch("uwGreekExposureByStrike", `/stock/${T(ticker)}/greek-exposure/strike`, {});
export const uwSpotExposuresRaw = (ticker: string) => uwFetch("uwSpotExposures", `/stock/${T(ticker)}/spot-exposures`, {});
export const uwRealizedVolRaw = (ticker: string) => uwFetch("uwRealizedVol", `/stock/${T(ticker)}/volatility/realized`, {});

// --- stock info ---
export const uwStockInfoRaw = (ticker: string) => uwFetch("uwStockInfo", `/stock/${T(ticker)}/info`, {});

// --- earnings ---
export const uwEarningsRaw = (ticker: string) => uwFetch("uwEarnings", `/stock/${T(ticker)}/earnings`, {});

// --- financials ---
export const uwBalanceSheetsRaw = (ticker: string, limit = 4) => uwFetch("uwBalanceSheets", `/stock/${T(ticker)}/balance-sheets`, { limit });
export const uwCashFlowsRaw = (ticker: string, limit = 4) => uwFetch("uwCashFlows", `/stock/${T(ticker)}/cash-flows`, { limit });
export const uwIncomeStatementsRaw = (ticker: string, limit = 4) => uwFetch("uwIncomeStatements", `/stock/${T(ticker)}/income-statements`, { limit });

// --- alerts (triggered) ---
export const uwAlertsRaw = (limit = 50) => uwFetch("uwAlerts", `/alerts`, { limit });

// --- etf (note: plural /etfs/ path) ---
export const uwEtfInfoRaw = (ticker: string) => uwFetch("uwEtfInfo", `/etfs/${T(ticker)}/info`, {});
export const uwEtfHoldingsRaw = (ticker: string) => uwFetch("uwEtfHoldings", `/etfs/${T(ticker)}/holdings`, {});
export const uwEtfExposureRaw = (ticker: string) => uwFetch("uwEtfExposure", `/etfs/${T(ticker)}/exposure`, {});

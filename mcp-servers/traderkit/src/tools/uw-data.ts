// UW data passthrough tools — native traderkit replacements for the (removed)
// mcp__unusualwhales__* MCP. Thin wrappers over verified UW REST fetchers in
// clients/uw-client.ts. Each tool mirrors the agent-facing uw_* name so the
// migration is a clean mcp__unusualwhales__uw_X → mcp__traderkit__uw_X swap.
//
// All endpoint paths live-verified 2026-06-03 (HTTP 200). Source of truth for
// the UW data path per user directive: uw_client.py / traderkit ONLY.
import { z } from "zod";
import { TickerSchema } from "../utils/schemas.js";
import { parseStrikeRows, computeGexAnalysis } from "../clients/gex.js";
import {
  uwDarkpoolRecentRaw,
  uwDarkpoolTickerRaw,
  uwFlowMarketRaw,
  uwFlowTickerRaw,
  uwInsiderTransactionsRaw,
  uwInsiderBuySellsRaw,
  uwCongressRecentRaw,
  uwCongressLateRaw,
  uwShortsDataRaw,
  uwShortsInterestFloatRaw,
  uwShortsVolumeRatioRaw,
  uwInstitutionsListRaw,
  uwInstitutionOwnershipRaw,
  uwSeasonalityMonthlyRaw,
  uwSeasonalityYearMonthRaw,
  uwSeasonalityMarketRaw,
  uwNewsRaw,
  uwGreekExposureRaw,
  uwGreekExposureByStrikeRaw,
  uwSpotExposuresRaw,
  uwRealizedVolRaw,
  uwStockInfoRaw,
  uwStockState,
  uwEarningsRaw,
  uwBalanceSheetsRaw,
  uwCashFlowsRaw,
  uwIncomeStatementsRaw,
  uwAlertsRaw,
  uwEtfInfoRaw,
  uwEtfHoldingsRaw,
  uwEtfExposureRaw,
} from "../clients/uw-client.js";

const LimitSchema = z.number().int().positive().max(500).default(50);

// --- uw_darkpool ---
export const UwDarkpoolArgs = z.object({
  command: z.enum(["recent", "ticker"]).default("ticker"),
  ticker: TickerSchema.optional(),
  limit: LimitSchema,
});
export async function uwDarkpoolHandler(raw: unknown): Promise<unknown> {
  const a = UwDarkpoolArgs.parse(raw);
  if (a.command === "recent") return { command: "recent", data: await uwDarkpoolRecentRaw(a.limit) };
  if (!a.ticker) throw new Error("uw_darkpool command=ticker requires a ticker");
  return { command: "ticker", ticker: a.ticker, data: await uwDarkpoolTickerRaw(a.ticker, a.limit) };
}

// --- uw_flow ---
export const UwFlowArgs = z.object({
  command: z.enum(["flow_alerts", "ticker"]).default("flow_alerts"),
  ticker: TickerSchema.optional(),
  limit: LimitSchema,
});
export async function uwFlowHandler(raw: unknown): Promise<unknown> {
  const a = UwFlowArgs.parse(raw);
  if (a.command === "ticker") {
    if (!a.ticker) throw new Error("uw_flow command=ticker requires a ticker");
    return { command: "ticker", ticker: a.ticker, data: await uwFlowTickerRaw(a.ticker, a.limit) };
  }
  return { command: "flow_alerts", ...(a.ticker ? { ticker: a.ticker } : {}), data: await uwFlowMarketRaw(a.limit) };
}

// --- uw_insider ---
export const UwInsiderArgs = z.object({
  command: z.enum(["transactions", "buy_sells"]).default("transactions"),
  ticker: TickerSchema.optional(),
  limit: LimitSchema,
});
export async function uwInsiderHandler(raw: unknown): Promise<unknown> {
  const a = UwInsiderArgs.parse(raw);
  if (a.command === "buy_sells") {
    if (!a.ticker) throw new Error("uw_insider command=buy_sells requires a ticker");
    return { command: "buy_sells", ticker: a.ticker, data: await uwInsiderBuySellsRaw(a.ticker) };
  }
  return { command: "transactions", ...(a.ticker ? { ticker: a.ticker } : {}), data: await uwInsiderTransactionsRaw(a.ticker, a.limit) };
}

// --- uw_congress ---
export const UwCongressArgs = z.object({
  command: z.enum(["recent_trades", "late_reports"]).default("recent_trades"),
  limit: LimitSchema,
});
export async function uwCongressHandler(raw: unknown): Promise<unknown> {
  const a = UwCongressArgs.parse(raw);
  if (a.command === "late_reports") return { command: "late_reports", data: await uwCongressLateRaw(a.limit) };
  return { command: "recent_trades", data: await uwCongressRecentRaw(a.limit) };
}

// --- uw_shorts ---
export const UwShortsArgs = z.object({
  ticker: TickerSchema,
  command: z.enum(["data", "interest_float", "volume_ratio"]).default("data"),
});
export async function uwShortsHandler(raw: unknown): Promise<unknown> {
  const a = UwShortsArgs.parse(raw);
  const data =
    a.command === "interest_float" ? await uwShortsInterestFloatRaw(a.ticker)
    : a.command === "volume_ratio" ? await uwShortsVolumeRatioRaw(a.ticker)
    : await uwShortsDataRaw(a.ticker);
  return { ticker: a.ticker, command: a.command, data };
}

// --- uw_institutions ---
export const UwInstitutionsArgs = z.object({
  command: z.enum(["list", "ownership"]).default("list"),
  name: z.string().min(1).optional(),
  limit: LimitSchema,
});
export async function uwInstitutionsHandler(raw: unknown): Promise<unknown> {
  const a = UwInstitutionsArgs.parse(raw);
  if (a.command === "ownership") {
    if (!a.name) throw new Error("uw_institutions command=ownership requires a name (fund/institution)");
    return { command: "ownership", name: a.name, data: await uwInstitutionOwnershipRaw(a.name) };
  }
  return { command: "list", data: await uwInstitutionsListRaw(a.limit) };
}

// --- uw_seasonality ---
export const UwSeasonalityArgs = z.object({
  command: z.enum(["monthly", "year_month", "market"]).default("monthly"),
  ticker: TickerSchema.optional(),
});
export async function uwSeasonalityHandler(raw: unknown): Promise<unknown> {
  const a = UwSeasonalityArgs.parse(raw);
  if (a.command === "market") return { command: "market", data: await uwSeasonalityMarketRaw() };
  if (!a.ticker) throw new Error(`uw_seasonality command=${a.command} requires a ticker`);
  const data = a.command === "year_month" ? await uwSeasonalityYearMonthRaw(a.ticker) : await uwSeasonalityMonthlyRaw(a.ticker);
  return { command: a.command, ticker: a.ticker, data };
}

// --- uw_news ---
export const UwNewsArgs = z.object({
  ticker: TickerSchema.optional(),
  limit: LimitSchema,
});
export async function uwNewsHandler(raw: unknown): Promise<unknown> {
  const a = UwNewsArgs.parse(raw);
  return { ...(a.ticker ? { ticker: a.ticker } : {}), data: await uwNewsRaw(a.ticker, a.limit) };
}

// --- uw_technicals (options-positioning bundle) ---
export const UwTechnicalsArgs = z.object({
  ticker: TickerSchema,
  command: z.enum(["greek_exposure", "spot_exposures", "realized_vol", "all"]).default("all"),
});
export async function uwTechnicalsHandler(raw: unknown): Promise<unknown> {
  const a = UwTechnicalsArgs.parse(raw);
  if (a.command === "greek_exposure") return { ticker: a.ticker, greek_exposure: await uwGreekExposureRaw(a.ticker) };
  if (a.command === "spot_exposures") return { ticker: a.ticker, spot_exposures: await uwSpotExposuresRaw(a.ticker) };
  if (a.command === "realized_vol") return { ticker: a.ticker, realized_vol: await uwRealizedVolRaw(a.ticker) };
  const [greek, spot, rvol] = await Promise.all([
    uwGreekExposureRaw(a.ticker),
    uwSpotExposuresRaw(a.ticker),
    uwRealizedVolRaw(a.ticker),
  ]);
  return { ticker: a.ticker, greek_exposure: greek, spot_exposures: spot, realized_vol: rvol };
}

// --- uw_gex_levels (per-strike GEX walls — computed, CC-aware) ---
export const UwGexLevelsArgs = z.object({
  ticker: TickerSchema,
  spot: z.number().positive().optional(),
  short_call_strike: z.number().positive().optional(),
  range_pct: z.number().positive().max(0.5).default(0.1),
  atm_iv: z.number().positive().max(5).optional(),
});
export async function uwGexLevelsHandler(raw: unknown): Promise<unknown> {
  const a = UwGexLevelsArgs.parse(raw);
  const [strikePayload, state] = await Promise.all([
    uwGreekExposureByStrikeRaw(a.ticker),
    a.spot === undefined ? uwStockState(a.ticker) : Promise.resolve({ price: a.spot }),
  ]);
  const rawRows = Array.isArray(strikePayload)
    ? (strikePayload as Record<string, unknown>[])
    : [];
  if (!rawRows.length) {
    return { ticker: a.ticker, error: "no per-strike GEX data returned from UW", levels: null, profile: [] };
  }
  const spot = a.spot ?? (state as { price?: number }).price;
  if (spot === undefined) {
    return { ticker: a.ticker, error: "could not determine spot price (pass `spot` explicitly)", levels: null, profile: [] };
  }
  const rows = parseStrikeRows(rawRows);
  return computeGexAnalysis(rows, a.ticker, spot, {
    rangePct: a.range_pct,
    atmIv: a.atm_iv,
    shortCallStrike: a.short_call_strike,
  });
}

// --- uw_stock ---
export const UwStockArgs = z.object({ ticker: TickerSchema });
export async function uwStockHandler(raw: unknown): Promise<unknown> {
  const a = UwStockArgs.parse(raw);
  const [info, state] = await Promise.all([uwStockInfoRaw(a.ticker), uwStockState(a.ticker)]);
  return { ticker: a.ticker, info, state };
}

// --- uw_earnings ---
export const UwEarningsArgs = z.object({ ticker: TickerSchema });
export async function uwEarningsHandler(raw: unknown): Promise<unknown> {
  const a = UwEarningsArgs.parse(raw);
  return { ticker: a.ticker, data: await uwEarningsRaw(a.ticker) };
}

// --- uw_financials ---
export const UwFinancialsArgs = z.object({
  ticker: TickerSchema,
  statement: z.enum(["balance_sheet", "cash_flow", "income", "all"]).default("all"),
  limit: z.number().int().positive().max(12).default(4),
});
export async function uwFinancialsHandler(raw: unknown): Promise<unknown> {
  const a = UwFinancialsArgs.parse(raw);
  if (a.statement === "balance_sheet") return { ticker: a.ticker, balance_sheets: await uwBalanceSheetsRaw(a.ticker, a.limit) };
  if (a.statement === "cash_flow") return { ticker: a.ticker, cash_flows: await uwCashFlowsRaw(a.ticker, a.limit) };
  if (a.statement === "income") return { ticker: a.ticker, income_statements: await uwIncomeStatementsRaw(a.ticker, a.limit) };
  const [bs, cf, inc] = await Promise.all([
    uwBalanceSheetsRaw(a.ticker, a.limit),
    uwCashFlowsRaw(a.ticker, a.limit),
    uwIncomeStatementsRaw(a.ticker, a.limit),
  ]);
  return { ticker: a.ticker, balance_sheets: bs, cash_flows: cf, income_statements: inc };
}

// --- uw_alerts ---
export const UwAlertsArgs = z.object({ limit: LimitSchema });
export async function uwAlertsHandler(raw: unknown): Promise<unknown> {
  const a = UwAlertsArgs.parse(raw);
  return { data: await uwAlertsRaw(a.limit) };
}

// --- uw_etf ---
export const UwEtfArgs = z.object({
  ticker: TickerSchema,
  command: z.enum(["info", "holdings", "exposure", "all"]).default("info"),
});
export async function uwEtfHandler(raw: unknown): Promise<unknown> {
  const a = UwEtfArgs.parse(raw);
  if (a.command === "holdings") return { ticker: a.ticker, holdings: await uwEtfHoldingsRaw(a.ticker) };
  if (a.command === "exposure") return { ticker: a.ticker, exposure: await uwEtfExposureRaw(a.ticker) };
  if (a.command === "info") return { ticker: a.ticker, info: await uwEtfInfoRaw(a.ticker) };
  const [info, holdings, exposure] = await Promise.all([
    uwEtfInfoRaw(a.ticker),
    uwEtfHoldingsRaw(a.ticker),
    uwEtfExposureRaw(a.ticker),
  ]);
  return { ticker: a.ticker, info, holdings, exposure };
}

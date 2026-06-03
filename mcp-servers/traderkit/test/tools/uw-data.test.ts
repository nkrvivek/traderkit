import { describe, expect, it, vi } from "vitest";

// Mock the UW REST client so tests are deterministic + offline. Each fetcher
// returns a sentinel tagged with its name so we can assert correct routing.
vi.mock("../../src/clients/uw-client.js", () => {
  const tag = (name: string) => vi.fn(async (...args: unknown[]) => ({ _fn: name, args }));
  return {
    uwDarkpoolRecentRaw: tag("darkpoolRecent"),
    uwDarkpoolTickerRaw: tag("darkpoolTicker"),
    uwFlowMarketRaw: tag("flowMarket"),
    uwFlowTickerRaw: tag("flowTicker"),
    uwInsiderTransactionsRaw: tag("insiderTx"),
    uwInsiderBuySellsRaw: tag("insiderBuySells"),
    uwCongressRecentRaw: tag("congressRecent"),
    uwCongressLateRaw: tag("congressLate"),
    uwShortsDataRaw: tag("shortsData"),
    uwShortsInterestFloatRaw: tag("shortsFloat"),
    uwShortsVolumeRatioRaw: tag("shortsVol"),
    uwInstitutionsListRaw: tag("instList"),
    uwInstitutionOwnershipRaw: tag("instOwn"),
    uwSeasonalityMonthlyRaw: tag("seasonMonthly"),
    uwSeasonalityYearMonthRaw: tag("seasonYM"),
    uwSeasonalityMarketRaw: tag("seasonMarket"),
    uwNewsRaw: tag("news"),
    uwGreekExposureRaw: tag("greek"),
    uwGreekExposureByStrikeRaw: tag("greekStrike"),
    uwSpotExposuresRaw: tag("spot"),
    uwRealizedVolRaw: tag("rvol"),
    uwStockInfoRaw: tag("stockInfo"),
    uwStockState: tag("stockState"),
    uwEarningsRaw: tag("earnings"),
    uwBalanceSheetsRaw: tag("balance"),
    uwCashFlowsRaw: tag("cash"),
    uwIncomeStatementsRaw: tag("income"),
    uwAlertsRaw: tag("alerts"),
    uwEtfInfoRaw: tag("etfInfo"),
    uwEtfHoldingsRaw: tag("etfHoldings"),
    uwEtfExposureRaw: tag("etfExposure"),
  };
});

import {
  uwDarkpoolHandler, uwFlowHandler, uwInsiderHandler, uwCongressHandler,
  uwShortsHandler, uwInstitutionsHandler, uwSeasonalityHandler, uwNewsHandler,
  uwTechnicalsHandler, uwGexLevelsHandler, uwStockHandler, uwEarningsHandler,
  uwFinancialsHandler, uwAlertsHandler, uwEtfHandler,
} from "../../src/tools/uw-data.js";
import { uwGreekExposureByStrikeRaw } from "../../src/clients/uw-client.js";

const fnOf = (r: unknown) => (r as { _fn: string })._fn;

describe("uw-data command routing", () => {
  it("uw_darkpool: default=ticker, recent, missing-ticker throws", async () => {
    expect(fnOf(await uwDarkpoolHandler({ ticker: "AAPL" }) .then((r: any) => r.data))).toBe("darkpoolTicker");
    expect(fnOf(await uwDarkpoolHandler({ command: "recent" }).then((r: any) => r.data))).toBe("darkpoolRecent");
    await expect(uwDarkpoolHandler({ command: "ticker" })).rejects.toThrow(/requires a ticker/);
  });

  it("uw_flow: default=flow_alerts, ticker, missing-ticker throws", async () => {
    expect(fnOf(await uwFlowHandler({}).then((r: any) => r.data))).toBe("flowMarket");
    expect(fnOf(await uwFlowHandler({ command: "ticker", ticker: "NVDA" }).then((r: any) => r.data))).toBe("flowTicker");
    await expect(uwFlowHandler({ command: "ticker" })).rejects.toThrow(/requires a ticker/);
  });

  it("uw_insider: transactions default + buy_sells needs ticker", async () => {
    expect(fnOf(await uwInsiderHandler({}).then((r: any) => r.data))).toBe("insiderTx");
    expect(fnOf(await uwInsiderHandler({ command: "buy_sells", ticker: "AAPL" }).then((r: any) => r.data))).toBe("insiderBuySells");
    await expect(uwInsiderHandler({ command: "buy_sells" })).rejects.toThrow(/requires a ticker/);
  });

  it("uw_congress: recent default + late_reports", async () => {
    expect(fnOf(await uwCongressHandler({}).then((r: any) => r.data))).toBe("congressRecent");
    expect(fnOf(await uwCongressHandler({ command: "late_reports" }).then((r: any) => r.data))).toBe("congressLate");
  });

  it("uw_shorts: data default + variants", async () => {
    expect(fnOf(await uwShortsHandler({ ticker: "AAPL" }).then((r: any) => r.data))).toBe("shortsData");
    expect(fnOf(await uwShortsHandler({ ticker: "AAPL", command: "interest_float" }).then((r: any) => r.data))).toBe("shortsFloat");
    expect(fnOf(await uwShortsHandler({ ticker: "AAPL", command: "volume_ratio" }).then((r: any) => r.data))).toBe("shortsVol");
  });

  it("uw_institutions: list default + ownership needs name", async () => {
    expect(fnOf(await uwInstitutionsHandler({}).then((r: any) => r.data))).toBe("instList");
    expect(fnOf(await uwInstitutionsHandler({ command: "ownership", name: "Vanguard" }).then((r: any) => r.data))).toBe("instOwn");
    await expect(uwInstitutionsHandler({ command: "ownership" })).rejects.toThrow(/requires a name/);
  });

  it("uw_seasonality: monthly default, market, ym needs ticker", async () => {
    expect(fnOf(await uwSeasonalityHandler({ ticker: "AAPL" }).then((r: any) => r.data))).toBe("seasonMonthly");
    expect(fnOf(await uwSeasonalityHandler({ command: "market" }).then((r: any) => r.data))).toBe("seasonMarket");
    expect(fnOf(await uwSeasonalityHandler({ command: "year_month", ticker: "AAPL" }).then((r: any) => r.data))).toBe("seasonYM");
    await expect(uwSeasonalityHandler({ command: "monthly" })).rejects.toThrow(/requires a ticker/);
  });

  it("uw_news: optional ticker", async () => {
    expect(fnOf(await uwNewsHandler({}).then((r: any) => r.data))).toBe("news");
    expect(fnOf(await uwNewsHandler({ ticker: "AAPL" }).then((r: any) => r.data))).toBe("news");
  });

  it("uw_technicals: all bundles 3, single picks one", async () => {
    const all = await uwTechnicalsHandler({ ticker: "AAPL" }) as any;
    expect(fnOf(all.greek_exposure)).toBe("greek");
    expect(fnOf(all.spot_exposures)).toBe("spot");
    expect(fnOf(all.realized_vol)).toBe("rvol");
    const one = await uwTechnicalsHandler({ ticker: "AAPL", command: "realized_vol" }) as any;
    expect(fnOf(one.realized_vol)).toBe("rvol");
    expect(one.greek_exposure).toBeUndefined();
  });

  it("uw_gex_levels: computes walls + cc_signal from per-strike data (spot passed)", async () => {
    (uwGreekExposureByStrikeRaw as any).mockResolvedValueOnce([
      { strike: 95, call_gex: 1000, put_gex: -5000, call_delta: 0, put_delta: 0 },
      { strike: 100, call_gex: 2000, put_gex: -1000, call_delta: 0, put_delta: 0 },
      { strike: 105, call_gex: 9000, put_gex: -500, call_delta: 0, put_delta: 0 },
    ]);
    const r = await uwGexLevelsHandler({ ticker: "TEST", spot: 100, short_call_strike: 105 }) as any;
    expect(r.levels.call_wall.strike).toBe(105);
    expect(r.levels.put_wall.strike).toBe(95);
    expect(r.cc_signal.vs_wall).toBe("at_wall");
    expect(r.upside_call_walls[0].strike).toBe(105);
  });

  it("uw_gex_levels: empty per-strike data returns error envelope", async () => {
    (uwGreekExposureByStrikeRaw as any).mockResolvedValueOnce({ error: "boom", data: [] });
    const r = await uwGexLevelsHandler({ ticker: "TEST", spot: 100 }) as any;
    expect(r.error).toMatch(/no per-strike/);
    expect(r.levels).toBeNull();
  });

  it("uw_stock: info + state", async () => {
    const r = await uwStockHandler({ ticker: "AAPL" }) as any;
    expect(fnOf(r.info)).toBe("stockInfo");
    expect(fnOf(r.state)).toBe("stockState");
  });

  it("uw_earnings: requires ticker", async () => {
    expect(fnOf(await uwEarningsHandler({ ticker: "AAPL" }).then((r: any) => r.data))).toBe("earnings");
    await expect(uwEarningsHandler({})).rejects.toThrow();
  });

  it("uw_financials: all bundles 3, single picks one", async () => {
    const all = await uwFinancialsHandler({ ticker: "AAPL" }) as any;
    expect(fnOf(all.balance_sheets)).toBe("balance");
    expect(fnOf(all.cash_flows)).toBe("cash");
    expect(fnOf(all.income_statements)).toBe("income");
    const inc = await uwFinancialsHandler({ ticker: "AAPL", statement: "income" }) as any;
    expect(fnOf(inc.income_statements)).toBe("income");
    expect(inc.balance_sheets).toBeUndefined();
  });

  it("uw_alerts: returns data", async () => {
    expect(fnOf(await uwAlertsHandler({}).then((r: any) => r.data))).toBe("alerts");
  });

  it("uw_etf: info default, all bundles 3, single picks one", async () => {
    expect(fnOf(await uwEtfHandler({ ticker: "SPY" }).then((r: any) => r.info))).toBe("etfInfo");
    const all = await uwEtfHandler({ ticker: "SPY", command: "all" }) as any;
    expect(fnOf(all.info)).toBe("etfInfo");
    expect(fnOf(all.holdings)).toBe("etfHoldings");
    expect(fnOf(all.exposure)).toBe("etfExposure");
    const h = await uwEtfHandler({ ticker: "SPY", command: "holdings" }) as any;
    expect(fnOf(h.holdings)).toBe("etfHoldings");
    expect(h.info).toBeUndefined();
  });

  it("invalid ticker is rejected by schema", async () => {
    await expect(uwStockHandler({ ticker: "toolongticker" })).rejects.toThrow();
  });
});

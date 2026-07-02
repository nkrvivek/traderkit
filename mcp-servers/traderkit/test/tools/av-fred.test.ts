import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/clients/alpha-vantage-client.js", () => ({
  avGlobalQuote: vi.fn(async (t: string) => ({ ticker: t, price: 123.45 })),
  avMacroSeries: vi.fn(async () => [{ date: "2026-06-01", value: "3.1" }]),
}));
vi.mock("../../src/clients/fred-client.js", () => ({
  fredLatestObservation: vi.fn(async (id: string) =>
    id === "EMPTY" ? null : { date: "2026-06-01", value: "5.33" }),
  fredMacroSnapshot: vi.fn(async (ids: string[]) =>
    Object.fromEntries(ids.map((i) => [i, { date: "2026-06-01", value: "1" }]))),
}));

import { avQuoteHandler } from "../../src/tools/av-quote.js";
import { fredSeriesHandler } from "../../src/tools/fred-series.js";

describe("avQuoteHandler", () => {
  it("ticker path returns a quote", async () => {
    const r = (await avQuoteHandler({ ticker: "NVDA" })) as any;
    expect(r.quote.ticker).toBe("NVDA");
  });

  it("macro path returns series points", async () => {
    const r = (await avQuoteHandler({ macro_series: "CPI" })) as any;
    expect(r.series).toBe("CPI");
    expect(r.points).toHaveLength(1);
  });

  it("rejects when neither ticker nor macro_series given", async () => {
    await expect(avQuoteHandler({})).rejects.toThrow();
  });
});

describe("fredSeriesHandler", () => {
  it("single series uses latest-observation path", async () => {
    const r = (await fredSeriesHandler({ series_ids: ["DFF"] })) as any;
    expect(r.snapshot.DFF.value).toBe("5.33");
  });

  it("single empty series surfaces an error marker", async () => {
    const r = (await fredSeriesHandler({ series_ids: ["EMPTY"] })) as any;
    expect(r.snapshot.EMPTY).toEqual({ error: "empty" });
  });

  it("multi-series uses snapshot path", async () => {
    const r = (await fredSeriesHandler({ series_ids: ["DFF", "T10Y2Y"] })) as any;
    expect(Object.keys(r.snapshot)).toEqual(["DFF", "T10Y2Y"]);
  });

  it("rejects empty series_ids", async () => {
    await expect(fredSeriesHandler({ series_ids: [] })).rejects.toThrow();
  });
});

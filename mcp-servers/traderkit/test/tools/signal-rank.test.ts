import { describe, expect, it } from "vitest";
import { signalRankHandler } from "../../src/tools/signal-rank.js";

describe("signalRankHandler", () => {
  it("ranks by composite confidence descending", async () => {
    const r = await signalRankHandler({
      signals: [
        { ticker: "AAPL", source: "darkpool", direction: "BULLISH", confidence: 0.6 },
        { ticker: "NVDA", source: "darkpool", direction: "BULLISH", confidence: 0.9 },
      ],
    });

    expect(r.ranked[0]!.ticker).toBe("NVDA");
    expect(r.ranked[1]!.ticker).toBe("AAPL");
  });

  it("boosts confidence on multi-source confirmation", async () => {
    const r = await signalRankHandler({
      signals: [
        { ticker: "AG", source: "darkpool", direction: "BULLISH", confidence: 0.7 },
        { ticker: "AG", source: "flow", direction: "BULLISH", confidence: 0.6 },
        { ticker: "AG", source: "oi_change", direction: "BULLISH", confidence: 0.5 },
      ],
      multi_source_bonus: 0.1,
    });

    expect(r.ranked).toHaveLength(1);
    expect(r.ranked[0]!.ticker).toBe("AG");
    expect(r.ranked[0]!.composite_confidence).toBe(0.9);
    expect(r.ranked[0]!.source_count).toBe(3);
  });

  it("deduplicates by source (keeps highest confidence)", async () => {
    const r = await signalRankHandler({
      signals: [
        { ticker: "SPY", source: "darkpool", direction: "BEARISH", confidence: 0.4 },
        { ticker: "SPY", source: "darkpool", direction: "BEARISH", confidence: 0.8 },
      ],
    });

    expect(r.ranked[0]!.source_count).toBe(1);
    expect(r.ranked[0]!.composite_confidence).toBe(0.8);
  });

  it("filters below min_confidence", async () => {
    const r = await signalRankHandler({
      signals: [
        { ticker: "AAPL", source: "darkpool", direction: "BULLISH", confidence: 0.2 },
        { ticker: "NVDA", source: "darkpool", direction: "BULLISH", confidence: 0.5 },
      ],
      min_confidence: 0.3,
    });

    expect(r.ranked).toHaveLength(1);
    expect(r.ranked[0]!.ticker).toBe("NVDA");
    expect(r.filtered_below_min).toBe(1);
  });

  it("resolves direction by confidence-weighted votes", async () => {
    const r = await signalRankHandler({
      signals: [
        { ticker: "TSLA", source: "darkpool", direction: "BULLISH", confidence: 0.9 },
        { ticker: "TSLA", source: "flow", direction: "BEARISH", confidence: 0.3 },
      ],
    });

    expect(r.ranked[0]!.direction).toBe("BULLISH");
  });

  it("caps composite at 1.0", async () => {
    const r = await signalRankHandler({
      signals: [
        { ticker: "X", source: "a", direction: "BULLISH", confidence: 0.9 },
        { ticker: "X", source: "b", direction: "BULLISH", confidence: 0.8 },
        { ticker: "X", source: "c", direction: "BULLISH", confidence: 0.7 },
        { ticker: "X", source: "d", direction: "BULLISH", confidence: 0.6 },
      ],
      multi_source_bonus: 0.1,
    });

    expect(r.ranked[0]!.composite_confidence).toBe(1.0);
  });

  it("respects max_results", async () => {
    const signals = Array.from({ length: 30 }, (_, i) => ({
      ticker: `T${i}`, source: "flow", direction: "BULLISH" as const, confidence: 0.5,
    }));
    const r = await signalRankHandler({ signals, max_results: 5 });

    expect(r.returned).toBe(5);
    expect(r.unique_tickers).toBe(30);
  });

  it("includes top_detail from highest-confidence signal", async () => {
    const r = await signalRankHandler({
      signals: [
        { ticker: "AG", source: "darkpool", direction: "BULLISH", confidence: 0.9, detail: "large block" },
        { ticker: "AG", source: "flow", direction: "BULLISH", confidence: 0.5, detail: "small sweep" },
      ],
    });

    expect(r.ranked[0]!.top_detail).toBe("large block");
  });

  it("handles empty signals", async () => {
    const r = await signalRankHandler({ signals: [] });
    expect(r.ranked).toHaveLength(0);
    expect(r.total_signals).toBe(0);
  });

  describe("confluence scoring", () => {
    it("AAPL 4-group + thesis = CORE (score 68)", async () => {
      const r = await signalRankHandler({
        signals: [
          { ticker: "AAPL", group: "POSITIONING", source: "uw_darkpool", direction: "BULLISH", confidence: 0.7 },
          { ticker: "AAPL", group: "FLOW", source: "uw_flow", direction: "BULLISH", confidence: 0.6 },
          { ticker: "AAPL", group: "TECHNICAL", source: "uw_technicals", direction: "BULLISH", confidence: 0.6 },
          { ticker: "AAPL", group: "VOLATILITY", source: "iv_rank", direction: "BULLISH", confidence: 0.5 },
          { ticker: "AAPL", group: "THESIS", source: "thesis:aapl-cc-ladder", direction: "BULLISH", confidence: 0.8 },
        ],
      });
      const a = r.ranked[0]!;
      expect(a.ticker).toBe("AAPL");
      expect(a.groups_hit).toBe(5);
      expect(a.channels_hit).toBe(5);
      expect(a.thesis_bonus).toBe(20);
      expect(a.confluence_score).toBe(50 + 10 + 20);
      expect(a.tier).toBe("CORE");
    });

    it("BBAI single source = WATCH (score 12)", async () => {
      const r = await signalRankHandler({
        signals: [
          { ticker: "BBAI", group: "FLOW", source: "uw_flow", direction: "BULLISH", confidence: 0.5 },
        ],
      });
      const a = r.ranked[0]!;
      expect(a.confluence_score).toBe(10 + 2);
      expect(a.tier).toBe("WATCH");
    });

    it("RED tier earnings within 7d applies -15 penalty", async () => {
      const r = await signalRankHandler({
        signals: [
          { ticker: "NVDA", group: "POSITIONING", source: "uw_darkpool", direction: "BULLISH", confidence: 0.7 },
          { ticker: "NVDA", group: "FLOW", source: "uw_flow", direction: "BULLISH", confidence: 0.6 },
          { ticker: "NVDA", group: "TECHNICAL", source: "uw_technicals", direction: "BULLISH", confidence: 0.5 },
          { ticker: "NVDA", group: "VOLATILITY", source: "iv_rank", direction: "BULLISH", confidence: 0.5 },
        ],
        earnings_within_days: { NVDA: 5 },
        iv_tier_by_ticker: { NVDA: "RED" },
      });
      const a = r.ranked[0]!;
      expect(a.earnings_penalty).toBe(15);
      expect(a.confluence_score).toBe(40 + 8 - 15);
      expect(a.tier).toBe("TIER-2");
    });

    it("GREEN tier earnings within 14d applies +10 bonus", async () => {
      const r = await signalRankHandler({
        signals: [
          { ticker: "XLE", group: "POSITIONING", source: "uw_darkpool", direction: "BULLISH", confidence: 0.6 },
          { ticker: "XLE", group: "MACRO", source: "regime", direction: "BULLISH", confidence: 0.5 },
        ],
        earnings_within_days: { XLE: 10 },
        iv_tier_by_ticker: { XLE: "GREEN" },
      });
      const a = r.ranked[0]!;
      expect(a.green_bonus).toBe(10);
      expect(a.confluence_score).toBe(20 + 4 + 10);
      expect(a.tier).toBe("TIER-2");
    });

    it("infers group from source when not supplied", async () => {
      const r = await signalRankHandler({
        signals: [
          { ticker: "AAPL", source: "uw_darkpool", direction: "BULLISH", confidence: 0.7 },
        ],
      });
      expect(r.ranked[0]!.raw_signals[0]!.group).toBe("POSITIONING");
    });

    it("dedupes by group:source (different group = different channel)", async () => {
      const r = await signalRankHandler({
        signals: [
          { ticker: "X", group: "POSITIONING", source: "darkpool", direction: "BULLISH", confidence: 0.7 },
          { ticker: "X", group: "FLOW", source: "darkpool", direction: "BULLISH", confidence: 0.6 },
        ],
      });
      const a = r.ranked[0]!;
      expect(a.channels_hit).toBe(2);
      expect(a.groups_hit).toBe(2);
    });

    it("sorts by confluence_score descending", async () => {
      const r = await signalRankHandler({
        signals: [
          { ticker: "LOW", group: "FLOW", source: "f1", direction: "BULLISH", confidence: 0.9 },
          { ticker: "HIGH", group: "FLOW", source: "f1", direction: "BULLISH", confidence: 0.4 },
          { ticker: "HIGH", group: "POSITIONING", source: "p1", direction: "BULLISH", confidence: 0.4 },
          { ticker: "HIGH", group: "TECHNICAL", source: "t1", direction: "BULLISH", confidence: 0.4 },
        ],
      });
      expect(r.ranked[0]!.ticker).toBe("HIGH");
    });
  });

  describe("IVR gate warnings in signal-rank", () => {
    const BASE_SIGNALS = [
      { ticker: "AAPL", group: "FLOW" as const, source: "uw_flow", direction: "BULLISH" as const, confidence: 0.6 },
    ];

    it("ivr_warnings empty when ivr_rank_by_ticker not supplied", async () => {
      const r = await signalRankHandler({ signals: BASE_SIGNALS });
      expect(r.ranked[0]!.ivr_warnings).toEqual([]);
    });

    it("ivr_warnings empty when ticker not in premium_sell_tickers", async () => {
      const r = await signalRankHandler({
        signals: BASE_SIGNALS,
        ivr_rank_by_ticker: { AAPL: 45 },
        // premium_sell_tickers not set — no annotation
      });
      expect(r.ranked[0]!.ivr_warnings).toEqual([]);
    });

    it("emits PASS warning when IVR=62 and ticker is premium-sell", async () => {
      const r = await signalRankHandler({
        signals: BASE_SIGNALS,
        ivr_rank_by_ticker: { AAPL: 62 },
        premium_sell_tickers: ["AAPL"],
      });
      const w = r.ranked[0]!.ivr_warnings;
      expect(w.length).toBe(1);
      expect(w[0]).toContain("IVR 62");
      expect(w[0]).toContain("PASS");
    });

    it("emits SOFT-FAIL warning when IVR=31 and ticker is premium-sell", async () => {
      const r = await signalRankHandler({
        signals: BASE_SIGNALS,
        ivr_rank_by_ticker: { AAPL: 31 },
        premium_sell_tickers: ["AAPL"],
      });
      const w = r.ranked[0]!.ivr_warnings;
      expect(w.length).toBe(1);
      expect(w[0]).toContain("IVR 31");
      expect(w[0]).toContain("premium rich? NO");
    });

    it("emits UNKNOWN warning when IVR missing for premium-sell ticker", async () => {
      const r = await signalRankHandler({
        signals: BASE_SIGNALS,
        ivr_rank_by_ticker: {}, // AAPL not in map
        premium_sell_tickers: ["AAPL"],
      });
      const w = r.ranked[0]!.ivr_warnings;
      expect(w.length).toBe(1);
      expect(w[0]).toContain("UNKNOWN");
    });

    it("does not affect confluence_score (warning-only, no scoring wiring)", async () => {
      const withIvr = await signalRankHandler({
        signals: BASE_SIGNALS,
        ivr_rank_by_ticker: { AAPL: 75 },
        premium_sell_tickers: ["AAPL"],
      });
      const withoutIvr = await signalRankHandler({ signals: BASE_SIGNALS });
      expect(withIvr.ranked[0]!.confluence_score).toBe(withoutIvr.ranked[0]!.confluence_score);
    });

    it("PASS at boundary IVR=50", async () => {
      const r = await signalRankHandler({
        signals: BASE_SIGNALS,
        ivr_rank_by_ticker: { AAPL: 50 },
        premium_sell_tickers: ["AAPL"],
      });
      expect(r.ranked[0]!.ivr_warnings[0]).toContain("PASS");
    });

    it("SOFT-FAIL at boundary IVR=49", async () => {
      const r = await signalRankHandler({
        signals: BASE_SIGNALS,
        ivr_rank_by_ticker: { AAPL: 49 },
        premium_sell_tickers: ["AAPL"],
      });
      expect(r.ranked[0]!.ivr_warnings[0]).toContain("premium rich? NO");
    });
  });
});

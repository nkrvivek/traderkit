import { describe, expect, it } from "vitest";
import { composeCheckTrade } from "../../src/gates/compose.js";
import { type Profile, PERMISSIVE_RULES, DEFAULT_RULES } from "../../src/profiles/schema.js";

const BILDOF: Profile = {
  name: "bildof", broker: "snaptrade",
  account_id: "11111111-1111-1111-1111-111111111111",
  tax_entity: "llc-bildof",
  caps: { max_order_notional: 5000, max_single_name_pct: 10, forbidden_tools: [], forbidden_leg_shapes: [] },
  rules: PERMISSIVE_RULES,
};

/** Personal-style profile: DEFAULT_RULES (R0_no_stale_data=true, strict_mode=true). */
const PERSONAL: Profile = {
  name: "personal", broker: "tradestation",
  account_id: "22222222-2222-2222-2222-222222222222",
  tax_entity: "personal",
  caps: { max_order_notional: 50000, max_single_name_pct: 40, forbidden_tools: [], forbidden_leg_shapes: [] },
  // No rules override → DEFAULT_RULES apply
};

describe("composeCheckTrade", () => {
  it("passes clean trade", async () => {
    const r = await composeCheckTrade({
      profile: BILDOF,
      allProfiles: [BILDOF],
      trade: {
        tool: "mleg_place", ticker: "AAPL",
        direction: "SELL_TO_OPEN", qty: 1, notional_usd: 3000,
        portfolio_total_usd: 100000, existing_ticker_exposure_usd: 0,
      },
      fetchActivities: async () => [],
    });
    expect(r.pass).toBe(true);
  });

  it("composes caps + wash-sale reasons", async () => {
    const r = await composeCheckTrade({
      profile: BILDOF,
      allProfiles: [BILDOF],
      trade: {
        tool: "equity_force_place", ticker: "AAPL",
        direction: "BUY", qty: 10, notional_usd: 20000,
        portfolio_total_usd: 100000, existing_ticker_exposure_usd: 0,
      },
      fetchActivities: async () => [
        { symbol: "AAPL", action: "SELL", quantity: 10, price: 150, realized_pnl: -500,
          trade_date: new Date().toISOString().slice(0, 10), account_id: BILDOF.account_id },
      ],
    });
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => /notional/.test(x))).toBe(true);
    expect(r.reasons.some((x) => /wash/i.test(x))).toBe(true);
  });

  it("warns but passes when activities fetch fails w/ non-strict permissive profile", async () => {
    const r = await composeCheckTrade({
      profile: BILDOF,
      allProfiles: [BILDOF],
      trade: {
        tool: "equity_force_place", ticker: "AAPL", direction: "BUY",
        qty: 1, notional_usd: 100, portfolio_total_usd: 100000, existing_ticker_exposure_usd: 0,
      },
      fetchActivities: async () => { throw new Error("snaptrade-read down"); },
      requireWashSaleCheck: false,
    });
    expect(r.pass).toBe(true);
    expect(r.warnings.some((x) => /wash-sale activities fetch failed/.test(x))).toBe(true);
  });

  it("rejects when activities fetch fails and require=true (strict override)", async () => {
    const r = await composeCheckTrade({
      profile: BILDOF,
      allProfiles: [BILDOF],
      trade: {
        tool: "equity_force_place", ticker: "AAPL", direction: "BUY",
        qty: 1, notional_usd: 100, portfolio_total_usd: 100000, existing_ticker_exposure_usd: 0,
      },
      fetchActivities: async () => { throw new Error("snaptrade-read down"); },
      requireWashSaleCheck: true,
    });
    expect(r.pass).toBe(false);
    expect(r.reasons[0]).toMatch(/wash-sale activities fetch failed/);
  });

  it("rejects by default (strict_mode) when activities fetch fails", async () => {
    const strictProfile: Profile = { ...BILDOF, rules: undefined };
    const r = await composeCheckTrade({
      profile: strictProfile,
      allProfiles: [strictProfile],
      trade: {
        tool: "equity_force_place", ticker: "AAPL", direction: "BUY",
        qty: 1, notional_usd: 100, portfolio_total_usd: 100000, existing_ticker_exposure_usd: 0,
      },
      fetchActivities: async () => { throw new Error("snaptrade-read down"); },
    });
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => /R0|wash-sale|R7|thesis/.test(x))).toBe(true);
  });
});

// ── R0 freshness gate tests (finding #18) ─────────────────────────────────────
//
// Finding: CheckTradeArgs lacked quote_as_of / regime_as_of fields, making the
// R0 gate permanently unsatisfiable for personal-profile SELL_TO_OPEN under
// DEFAULT_RULES (R0_no_stale_data=true). These tests reproduce the old deadlock
// and confirm the fix: supplying quote_as_of satisfies R0.

describe("R0 freshness gate — DEFAULT_RULES SELL_TO_OPEN (finding #18)", () => {
  const freshNow = new Date("2026-06-10T15:00:00Z");
  // A timestamp 10 seconds ago = well within 60s TTL
  const freshQuoteTs = new Date(freshNow.getTime() - 10_000).toISOString();

  it("SELL_TO_OPEN with DEFAULT_RULES and no quote_as_of fails R0 (reproduces old deadlock)", async () => {
    // This was the unsatisfiable gate: R0_no_stale_data=true, SELL_TO_OPEN requires
    // quote freshness, but quote_as_of was never plumbed through CheckTradeArgs.
    const r = await composeCheckTrade({
      profile: PERSONAL,
      allProfiles: [PERSONAL],
      trade: {
        tool: "snaptrade_trade",
        ticker: "AAPL",
        direction: "SELL_TO_OPEN",
        qty: 1,
        notional_usd: 500,
        portfolio_total_usd: 100000,
        existing_ticker_exposure_usd: 0,
      },
      fetchActivities: async () => [],
      now: freshNow,
      // quote_as_of intentionally omitted — old behavior that caused the deadlock
    });
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => /R0.*quote.*no as_of/i.test(x))).toBe(true);
  });

  it("SELL_TO_OPEN with DEFAULT_RULES and fresh quote_as_of passes R0", async () => {
    // Fix: supply quote_as_of within the TTL window → R0 satisfied
    const r = await composeCheckTrade({
      profile: PERSONAL,
      allProfiles: [PERSONAL],
      trade: {
        tool: "snaptrade_trade",
        ticker: "AAPL",
        direction: "SELL_TO_OPEN",
        qty: 1,
        notional_usd: 500,
        portfolio_total_usd: 100000,
        existing_ticker_exposure_usd: 0,
      },
      fetchActivities: async () => [],
      now: freshNow,
      quote_as_of: freshQuoteTs,
      regime_as_of: freshQuoteTs,
      portfolio_total_as_of: freshQuoteTs,
      activities_as_of: freshQuoteTs,
    });
    // R0 should now pass; other gates (R7 thesis, R2 strike-grid) may still fail
    // in strict mode — but the R0 deadlock must not be the block.
    expect(r.reasons.every((x) => !/R0.*quote.*no as_of/i.test(x))).toBe(true);
  });

  it("SELL_TO_OPEN with stale quote_as_of (>60s) still fails R0", async () => {
    const staleTs = new Date(freshNow.getTime() - 120_000).toISOString(); // 2m ago
    const r = await composeCheckTrade({
      profile: PERSONAL,
      allProfiles: [PERSONAL],
      trade: {
        tool: "snaptrade_trade",
        ticker: "AAPL",
        direction: "SELL_TO_OPEN",
        qty: 1,
        notional_usd: 500,
        portfolio_total_usd: 100000,
        existing_ticker_exposure_usd: 0,
      },
      fetchActivities: async () => [],
      now: freshNow,
      quote_as_of: staleTs,  // older than 60s TTL → R0 should reject
    });
    expect(r.pass).toBe(false);
    // freshness.ts format: "quote: {ageSec}s old > ttl {ttlSec}s"
    expect(r.reasons.some((x) => /R0.*quote.*old.*ttl/i.test(x))).toBe(true);
  });

  it("BUY with DEFAULT_RULES and no quote_as_of passes R0 (not a short open)", async () => {
    // R0 requireQuote=true only for isShortOpen; BUY should not be blocked by missing quote ts
    const r = await composeCheckTrade({
      profile: PERSONAL,
      allProfiles: [PERSONAL],
      trade: {
        tool: "snaptrade_trade",
        ticker: "AAPL",
        direction: "BUY",
        qty: 1,
        notional_usd: 500,
        portfolio_total_usd: 100000,
        existing_ticker_exposure_usd: 0,
      },
      fetchActivities: async () => [],
      now: freshNow,
      // quote_as_of omitted — must not trigger R0 for BUY
    });
    expect(r.reasons.every((x) => !/R0.*quote.*no as_of/i.test(x))).toBe(true);
  });
});

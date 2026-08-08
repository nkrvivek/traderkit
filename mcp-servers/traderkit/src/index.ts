#!/usr/bin/env node
// Load traderkit/.env. Node 20.12+ has built-in process.loadEnvFile — no dotenv dep.
// Silently skip if file missing (env may already be exported in shell).
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
try {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/index.js → ../../../.env points to traderkit repo root .env
  process.loadEnvFile(resolve(here, "../../../.env"));
} catch {
  // .env optional
}
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodObject, type ZodRawShape } from "zod";
import { loadAllProfiles } from "./profiles/loader.js";
import { PROFILES_DIR } from "./config.js";
import { connectSnaptradeRead, type SnaptradeReadClient } from "./mcp/snaptrade-read-client.js";
import { CheckTradeArgs, checkTradeHandler } from "./tools/check-trade.js";
import { CheckWashSaleArgs, checkWashSaleHandler } from "./tools/check-wash-sale.js";
import { listProfilesHandler } from "./tools/list-profiles.js";
import { SetProfileArgs, setProfileHandler } from "./tools/set-profile.js";
import { ScanTlhArgs, scanTlhHandler } from "./tools/scan-tlh-handler.js";
import { CheckConcentrationArgs, checkConcentrationHandler } from "./tools/check-concentration.js";
import { RegimeGateArgs, regimeGateHandler } from "./tools/regime-gate.js";
import { ProposeTradeArgs, proposeTradeHandler } from "./tools/propose-trade.js";
import { TrackTaxArgs, trackTaxHandler } from "./tools/track-tax.js";
import { TriggerCheckArgs, triggerCheckHandler } from "./tools/trigger-check.js";
import { SignalRankArgs, signalRankHandler } from "./tools/signal-rank.js";
import { ClassifyHoldingArgs, classifyHoldingHandler } from "./tools/classify-holding.js";
import { TradingCalendarArgs, tradingCalendarHandler } from "./tools/trading-calendar.js";
import { PerformanceMetricsArgs, performanceMetricsHandler } from "./tools/performance-metrics.js";
import { ThesisFitArgs, thesisFitHandler } from "./tools/thesis-fit.js";
import { SessionWriteArgs, sessionWriteHandler } from "./tools/session-write.js";
import { BrokerRouteArgs, brokerRouteHandler } from "./tools/broker-route.js";
import { ScreenOptionsArgs, screenOptionsHandler } from "./tools/screen-options.js";
import { CalcRollArgs, calcRollHandler } from "./tools/calc-roll.js";
import { FmpFundamentalsArgs, fmpFundamentalsHandler } from "./tools/fmp-fundamentals.js";
import { CalcMaxPainArgs, calcMaxPainHandler } from "./tools/calc-max-pain.js";
import { InstHoldingsArgs, instHoldingsHandler } from "./tools/inst-holdings.js";
import { TrackActivistsArgs, trackActivistsHandler } from "./tools/track-activists.js";
import { ExplainPayoffArgs, explainPayoffHandler } from "./tools/explain-payoff.js";
import { AnalyzeStructureArgs, analyzeStructureHandler } from "./tools/analyze-structure.js";
import { SqueezeScoreArgs, squeezeScoreHandler } from "./tools/squeeze-score.js";
import { ReportTradesArgs, reportTradesHandler } from "./tools/report-trades.js";
import { VerifyFillArgs, verifyFillHandler } from "./tools/verify-fill.js";
import { RepricingCheckArgs, repricingCheckHandler } from "./tools/repricing-check.js";
import { ComboFillabilityArgs, comboFillabilityHandler } from "./tools/combo-fillability.js";
import { ReconcileReminderArgs, reconcileReminderHandler } from "./tools/reconcile-reminder.js";
import { ExpiryPriorityArgs, expiryPriorityHandler } from "./tools/expiry-priority.js";
import { EarningsCalendarArgs, earningsCalendarHandler } from "./tools/earnings-calendar.js";
import { RviGapArgs, rviGapHandler } from "./tools/rvi-gap.js";
import { ClassifyTradeOutcomeArgs, classifyTradeOutcomeHandler } from "./tools/classify-trade-outcome.js";
import { MacroOverlayArgs, macroOverlayHandler } from "./tools/macro-overlay.js";
import { BacktestSignalsArgs, backtestSignalsHandler } from "./tools/backtest-signals.js";
import { MonitorPositionArgs, monitorPositionHandler } from "./tools/monitor-position.js";
import { FetchFlowArgs, fetchFlowHandler } from "./tools/fetch-flow.js";
import { FetchOiChangesArgs, fetchOiChangesHandler } from "./tools/fetch-oi-changes.js";
import { FlowAnalysisArgs, flowAnalysisHandler } from "./tools/flow-analysis.js";
import { DiscoverFlowArgs, discoverFlowHandler } from "./tools/discover-flow.js";
import { AggregateAnalystReportsArgs, aggregateAnalystReportsHandler } from "./tools/aggregate-analyst-reports.js";
import { SynthesizeDebateArgs, synthesizeDebateHandler } from "./tools/synthesize-debate.js";
import { RiskDebate3StanceArgs, riskDebate3StanceHandler } from "./tools/risk-debate-3stance.js";
import { ReflectTradesArgs, reflectTradesHandler } from "./tools/reflect-trades.js";
import { LlmCouncilArgs, llmCouncilHandler } from "./tools/llm-council.js";
import { FredSeriesArgs, fredSeriesHandler } from "./tools/fred-series.js";
import { AvQuoteArgs, avQuoteHandler } from "./tools/av-quote.js";
import { CheckAiBottLayerArgs, checkAiBottLayerHandler } from "./tools/check-ai-bott-layer.js";
import { WorldmonitorSignalsArgs, worldmonitorSignalsHandler } from "./tools/worldmonitor-signals.js";
import {
  UwDarkpoolArgs, uwDarkpoolHandler,
  UwFlowArgs, uwFlowHandler,
  UwInsiderArgs, uwInsiderHandler,
  UwCongressArgs, uwCongressHandler,
  UwShortsArgs, uwShortsHandler,
  UwInstitutionsArgs, uwInstitutionsHandler,
  UwSeasonalityArgs, uwSeasonalityHandler,
  UwNewsArgs, uwNewsHandler,
  UwTechnicalsArgs, uwTechnicalsHandler,
  UwGexLevelsArgs, uwGexLevelsHandler,
  UwStockArgs, uwStockHandler,
  UwEarningsArgs, uwEarningsHandler,
  UwFinancialsArgs, uwFinancialsHandler,
  UwAlertsArgs, uwAlertsHandler,
  UwEtfArgs, uwEtfHandler,
} from "./tools/uw-data.js";
import { redact } from "./redact.js";

function toolInput<S extends ZodRawShape>(
  schema: ZodObject<S>,
  _required: readonly (keyof S & string)[],
) {
  const js = z.toJSONSchema(schema, {
    io: "input",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  delete js["$schema"];
  if (js["additionalProperties"] === undefined) {
    js["additionalProperties"] = false;
  }
  return js;
}

const EMPTY_INPUT = {
  type: "object" as const,
  additionalProperties: false as const,
  properties: {},
  required: [] as string[],
};

const TOOLS = [
  { name: "check_trade", description: "Gate a proposed trade (caps + wash-sale).",
    inputSchema: toolInput(CheckTradeArgs, ["profile", "tool", "ticker", "direction", "qty", "notional_usd"]) },
  { name: "check_wash_sale", description: "Check wash-sale status for a ticker + action.",
    inputSchema: toolInput(CheckWashSaleArgs, ["ticker", "action", "tax_entity"]) },
  { name: "list_profiles", description: "List available trading profiles.",
    inputSchema: EMPTY_INPUT },
  { name: "set_profile", description: "Set the active profile in session state.",
    inputSchema: toolInput(SetProfileArgs, ["name"]) },
  { name: "scan_tlh", description: "Scan positions for tax-loss harvesting candidates (wash-sale-clean).",
    inputSchema: toolInput(ScanTlhArgs, ["tax_entity", "positions"]) },
  { name: "check_concentration", description: "Analyze portfolio concentration vs profile caps. Returns per-position labels (HEADROOM/NEAR-CAP/AT-CAP/OVER-CAP) and HHI.",
    inputSchema: toolInput(CheckConcentrationArgs, ["profile", "positions", "portfolio_total_usd"]) },
  { name: "check_ai_bott_layer", description: "Analyze portfolio exposure across AI-Bottlenecks physical chokepoint layers (I-XV). Source: vault watchlist wiki/trading/watchlists/ai-bottlenecks.md (114 tickers across 15 layers). Default cap 4% NAV per layer. Returns per-layer HEADROOM/NEAR-CAP/AT-CAP/OVER-CAP labels — catches cross-name macro-driver concentration that single-name check_concentration misses (e.g. INTC+AMD+NVDA all under Layer V).",
    inputSchema: toolInput(CheckAiBottLayerArgs, ["positions", "portfolio_total_usd"]) },
  { name: "worldmonitor_signals", description: "Read WorldMonitor readings (energy disruptions, chokepoints, gas storage, trade barriers, macro/stress composites, energy prices) from the vault ledger wiki/trading/worldmonitor-signals.md — never calls worldmonitor.sibt.ai itself; trade-refresh's puller owns the fetch so every figure keeps one freshness story. Last row per signal; usable only when status ok and pulled inside the 6h bound, otherwise flagged with the reason. Context for regime work, never an order trigger.",
    inputSchema: toolInput(WorldmonitorSignalsArgs, []) },
  { name: "regime_gate", description: "Check if a trade is allowed under the current market regime. Returns adjusted sizing, blocked actions, and preferred structures.",
    inputSchema: toolInput(RegimeGateArgs, ["regime_tier", "direction", "notional_usd"]) },
  { name: "propose_trade", description: "Assemble a sized trade proposal with concentration headroom, regime adjustment, and cap check.",
    inputSchema: toolInput(ProposeTradeArgs, ["profile", "ticker", "direction", "current_price", "portfolio_total_usd"]) },
  { name: "track_tax", description: "Compute running STCG/LTCG tax exposure from realized trades. Returns per-trade breakdown and reserve amounts.",
    inputSchema: toolInput(TrackTaxArgs, ["trades"]) },
  { name: "trigger_check", description: "Check for triggered events: NAV moves, regime shifts, concentration breaches. Returns severity-sorted event list.",
    inputSchema: toolInput(TriggerCheckArgs, ["current_nav", "previous_nav", "current_regime_tier"]) },
  { name: "signal_rank", description: "Rank trading signals by composite confidence. Multi-source confirmation boosts score. Deduplicates by (ticker, source).",
    inputSchema: toolInput(SignalRankArgs, ["signals"]) },
  { name: "classify_holding", description: "Classify holdings into tiers (CORE/OPPORTUNISTIC/SPECULATIVE/PURE_SPECULATIVE) based on NAV weight, thesis, and program membership.",
    inputSchema: toolInput(ClassifyHoldingArgs, ["holdings", "portfolio_total_usd"]) },
  { name: "trading_calendar", description: "NYSE trading calendar: check trading days, find next/prev trading day, last trading day of month, count trading days between dates.",
    inputSchema: toolInput(TradingCalendarArgs, ["action", "date"]) },
  { name: "performance_metrics", description: "Compute portfolio performance metrics: Sharpe, Sortino, max drawdown, Calmar ratio, win rate from a returns series.",
    inputSchema: toolInput(PerformanceMetricsArgs, ["returns"]) },
  { name: "thesis_fit", description: "Score how well a trade fits active theses (IN_THESIS/PARTIAL/OFF_THESIS/NO_THESIS_REF). Supports single and batch scoring.",
    inputSchema: toolInput(ThesisFitArgs, ["action", "theses"]) },
  { name: "session_write", description: "Format session sections (executed/deferred/no-trade/index row) OR save a full session locally. action=save writes JSON+MD to $TRADERKIT_HOME/sessions/<date>/<profile>-<mode>-<HHMMSS>.{json,md} (default ~/.traderkit/sessions). Always call at end of every run — dry-run, interactive, scheduled — for historical record + replay.",
    inputSchema: toolInput(SessionWriteArgs, ["action"]) },
  { name: "broker_route", description: "Classify broker routing: SNAPTRADE/TRADESTATION/MANUAL/DEFERRED based on broker name and deferred tags.",
    inputSchema: toolInput(BrokerRouteArgs, ["broker", "direction"]) },
  { name: "screen_options", description: "Screen option-selling candidates (CSP/CC/PCS/CCS) by IV rank, delta, DTE, credit, YoR, OI, earnings window. Returns ranked candidates w/ fundamentals (mkt cap, sector) + option Greeks from UW + Finnhub.",
    inputSchema: toolInput(ScreenOptionsArgs, ["tickers"]) },
  { name: "calc_roll", description: "Find roll candidates for an existing short option. Credit-first: filters strikes/expiries where STO_credit − BTC_cost >= min_net_credit. Ranks by (net_credit / DTE_ext) × new_POP.",
    inputSchema: toolInput(CalcRollArgs, ["ticker", "option_type", "current_strike", "current_expiry"]) },
  { name: "fmp_fundamentals", description: "FMP fundamentals per ticker — quote (spot, mkt cap), DCF, analyst price target (high/low/median/consensus), and next earnings date + timing (bmo/amc) + consensus EPS. Free tier: 250 calls/day; each ticker uses up to 4 calls. Use for thesis validation + earnings-blackout checks.",
    inputSchema: toolInput(FmpFundamentalsArgs, ["tickers"]) },
  { name: "calc_max_pain", description: "Compute Max Pain strike + OI walls for a ticker/expiry. Returns pain curve, put/call walls (support/resistance), P/C OI ratio, and interpretive notes (pin drift, wall strike candidates for CSP/CC). Uses UW option chain + stock state.",
    inputSchema: toolInput(CalcMaxPainArgs, ["ticker"]) },
  { name: "inst_holdings", description: "Institutional holdings tracker (13F). Modes: by_ticker (top 13F filers holding a stock, matched vs known funds like Citadel/BlackRock/Berkshire), by_fund (top positions of a named fund by key or CIK), list_funds (curated CIK map). Returns shares/market-value/weight + build/trim deltas w/ smart-money bias interpretation. FMP source — tier-dependent.",
    inputSchema: toolInput(InstHoldingsArgs, ["mode"]) },
  { name: "track_activists", description: "Activist/event-driven filings tracker via SEC EDGAR full-text search. Modes: by_ticker (who is filing 13D/13G on this stock?), by_fund (recent Pershing/Icahn/Elliott/Starboard filings), recent (market-wide activist scan), list_activists (curated activist CIKs: Ackman, Icahn, Elliott, Starboard, Loeb, Peltz, ValueAct, JANA, etc.). Surfaces 13D (hard intent), 13D/A (amendment), 13G (passive >5%), DEF 14A (proxy). Fresh 13D = priority.",
    inputSchema: toolInput(TrackActivistsArgs, ["mode"]) },
  { name: "explain_payoff", description: "Plain-English payoff narration for a proposed trade. Supports covered_call, cash_secured_put, put_credit_spread, call_credit_spread, long_stock. Returns narrative + scenarios (win/partial/worst), breakeven, max profit/loss in dollars. Use in Phase 4 alongside propose_trade so users see 'if X happens you make $Y' before approving. Demystifies options for new traders.",
    inputSchema: toolInput(ExplainPayoffArgs, ["ticker", "structure", "spot"]) },
  { name: "analyze_structure", description: "Desk metrics for an arbitrary multi-leg options structure (any mix of call/put/stock legs, signed qty +long/-short). Black-Scholes engine returns POP (risk-neutral prob of profit), P50 (prob of >=50% of max profit), max profit/loss, ROC, prob-of-touch of the nearest breakeven, and net position Greeks (delta/gamma, theta per day, vega/rho per 0.01). Unbounded sides report null + *_unbounded=true. Each option leg: {right, qty (signed), strike, T (years), iv (decimal), entry_price}. Verified against the options-analyzer golden vectors. Use in Phase 4 for any structure explain_payoff's fixed templates don't cover.",
    inputSchema: toolInput(AnalyzeStructureArgs, ["spot", "legs"]) },
  { name: "squeeze_score", description: "0-100 short-squeeze composite: crowded-short × aggressive-call-buying × gamma-load. Sub-scores: short_component (0-40, from uw_shorts short-interest %float + days-to-cover), flow_component (0-40, from uw_flow net ask-side call premium + call/put skew), gamma_component (0-20, from uw_gex_levels spot proximity to a gamma wall/flip). Caller passes the three input blocks sourced from those uw_* tools; pure/deterministic. Never a bare number — returns sub-scores + the raw inputs behind each so it is auditable.",
    inputSchema: toolInput(SqueezeScoreArgs, ["ticker", "short_interest_pct_float", "days_to_cover", "net_call_premium_usd", "gamma_proximity"]) },
  { name: "report_trades", description: "Weekly/monthly trade scoreboard. Reads $TRADERKIT_HOME/sessions/**/*.json (from session_write action=save) and aggregates: trades executed, premium collected, realized P&L, win rate, breakdown by structure/ticker/regime. Defaults to last 7 days, live modes only (include_dry_run=true to include paper trades). Answers 'how did my covered-call ladder actually perform?' without a vault.",
    inputSchema: toolInput(ReportTradesArgs, []) },
  { name: "verify_fill", description: "R4 fill verification. Compare intended vs filled quantities per leg and coerce session status label ('executed' | 'partial-fill (N/M)' | 'submitted-unverified' | 'failed'). Required before any session_write status=executed. Source tag required (ib-gateway | ib-flex | snaptrade-list-orders | tradestation | manual). Origin: BBAI 2026-04-17 ×25 SP submitted / 1 filled while session marked executed → 2-day vault drift.",
    inputSchema: toolInput(VerifyFillArgs, ["source", "legs"]) },
  { name: "repricing_check", description: "R3 DAY LMT repricing check. Flags stale orders: if age ≥ stale_minutes AND underlying moved ≥ adverse_move_pct, returns REPRICE action. Origin: BBAI $3 May-15 SP × 25 @ $0.10 LMT DAY stayed unfilled 2+h while stock rallied 8.2% → only 1/25 filled.",
    inputSchema: toolInput(RepricingCheckArgs, ["ticker", "direction", "limit_price", "submitted_at", "underlying_price_at_submit", "underlying_price_now", "intended_qty"]) },
  { name: "reconcile_reminder", description: "R5 Flex reconcile reminder. IBKR multi-leg sessions must be reconciled against IB Flex within 24h — otherwise vault drifts. Returns shell command w/ configured query_id.",
    inputSchema: toolInput(ReconcileReminderArgs, ["broker", "order_count", "session_at"]) },
  { name: "expiry_priority", description: "R8 expiry-day priority stack. Orders expiring legs ITM→ATM→OTM, then new-cycle writes. Flags violations when ITM/ATM legs present alongside new-cycle writes (must process rolls/closes first).",
    inputSchema: toolInput(ExpiryPriorityArgs, []) },
  { name: "backtest_signals", description: "Backtest harness for signal-rank tier framework. Takes historical entries (ticker + tier_at_entry + realized_pnl_usd, optional realized_return_pct, predicted/realized direction) → per-tier hit rate, win/loss count, total + avg P&L, avg return %, direction accuracy. Computes tier-gate impact (P&L savings from skipping WATCH/NOISE). Emits calibration_warnings when lower tiers outperform higher tiers (monotonic check). Use to validate tier scoring formula on real history.",
    inputSchema: toolInput(BacktestSignalsArgs, ["history"]) },
  { name: "macro_overlay", description: "Macro regime overlay: DXY trend (vs 50/200 dma) + HYG/LQD spread direction (vs 20 dma) → BULL/NEUTRAL/BEAR macro bias + tail-risk flag (NONE/ELEVATED/EXTREME from VIX spot + term-structure inversion + credit widening) + size modifier (1.0 BULL / 0.75 NEUTRAL / 0.5 BEAR, capped further by tail risk). Sector overlay surfaces commodity/EM/credit/small-cap biases. Returns signal_for_confluence ready to feed signal_rank's MACRO channel.",
    inputSchema: toolInput(MacroOverlayArgs, ["dxy_spot", "dxy_50dma", "dxy_200dma", "hyg_lqd_ratio", "hyg_lqd_20dma"]) },
  { name: "classify_trade_outcome", description: "Auto-classifier on closed trades. Parses entry/exit/structure/pnl + optional exit_reason → outcome bucket (WIN_MANAGED / WIN_EXPIRED / LOSS_STOPPED / LOSS_ASSIGNED / LOSS_ROLLED / BREAKEVEN / UNCATEGORIZED) + edge attribution per trade (theta-decay capture, managed-at-50pct discipline, assignment risk, revenge-roll pattern). Returns per-trade classification + portfolio-level summary (win rate, total P&L, bucket counts, avg hold). Fuel for backtest harness + post-mortem reviews.",
    inputSchema: toolInput(ClassifyTradeOutcomeArgs, ["trades"]) },
  { name: "rvi_gap", description: "Realized-vs-implied volatility gap. Computes IV-HV gap, ratio, and z-score vs IV history (when supplied). Emits action (SELL_PREMIUM if z≥+1.2σ → premium-rich / BUY_PREMIUM if z≤−1.2σ → premium-cheap / NEUTRAL between). Fallback ratio mode (no history): ratio≥1.5 → SELL, ≤0.8 → BUY. Returns signal_for_confluence object ready to feed signal_rank's VOLATILITY channel.",
    inputSchema: toolInput(RviGapArgs, ["ticker", "iv_30d", "hv_30d"]) },
  { name: "earnings_calendar", description: "Earnings calendar preload for held + watchlist tickers. Filters to tickers of interest, computes days_until + earnings_window (TODAY/WITHIN_2D/WITHIN_7D/WITHIN_14D), surfaces conflicting open option legs, and emits flags (R1 held-into-earnings, RED-tier IV crush warning, GREEN-tier candidate, SHORT-leg-thru-earnings). Returns earnings_within_days_map + iv_tier_map ready to feed signal_rank for confluence scoring.",
    inputSchema: toolInput(EarningsCalendarArgs, ["as_of"]) },
  { name: "combo_fillability", description: "R14 BAG (multi-leg combo) fillability score. Rule-based heuristic: near-leg DTE/OI, underlying ADV, spot-to-near-strike distance, minutes-to-close, leg-width, net-price-vs-combo-mid. Returns HIGH/MEDIUM/LOW + suggestion (SUBMIT/REPRICE_MID/LEG_OUT/CANCEL) + leg_out_plan (BTC near @ ask + STO far @ bid) when LOW. Origin: BBAI 2026-04-23 $4P Apr-24/May-01 calendar roll (permId 2061124997) — 3 reprices $0.10→$0.05→$0.00 zero fill → canceled → forced assignment. Fix: leg out at T-60, not reprice down.",
    inputSchema: toolInput(ComboFillabilityArgs, ["ticker", "legs", "net_price"]) },
  { name: "monitor_position", description: "Classify a short-options position into GREEN/YELLOW/ORANGE/RED/CRITICAL tier from current spot+|delta| vs thresholds (worst-of spot tier and delta tier). Defaults supplied for short_call/covered_call and short_put/cash_secured_put; override via thresholds arg. Returns action enum (hold/flag/alarm/urgent/stop_everything), alert message template (🟢/🟡/🟠/🔴/🚨), deltas vs fill (spot/Δ/IV/buffer), buffer_otm, dte, next_review_dte gate (14/7/3/1), warnings (ITM, ≤1 DTE non-GREEN, expiry-day). Caller fetches current spot/Δ via UW MCP or TS option-quotes. Origin: AAPL 295C 5/22 cron monitor flow.",
    inputSchema: toolInput(MonitorPositionArgs, ["position_id", "ticker", "structure", "strike", "expiry", "contracts", "fill_price", "current_spot", "current_delta"]) },
  { name: "fetch_flow", description: "Dark-pool + options flow analysis for a ticker via Unusual Whales. Fetches per-day darkpool prints over N trading days (always includes today if trading day, even intraday). Classifies trades by NBBO mid → buy/sell volume → ACCUMULATION/DISTRIBUTION/NEUTRAL/UNKNOWN/NO_DATA + 0-100 strength. Aggregates options flow alerts → BULLISH/BEARISH/NEUTRAL bias from call/put premium. INTRADAY INTERPOLATION: when run during market hours, today's partial data is volume-weighted projected to full-day estimate (HIGH/MEDIUM/LOW/VERY_LOW confidence based on % of day elapsed). Combined signal: STRONG_BULLISH_CONFLUENCE / STRONG_BEARISH_CONFLUENCE / DP_*_ONLY / OPTIONS_*_ONLY / NO_SIGNAL. Source: ported from radon scripts/fetch_flow.py.",
    inputSchema: toolInput(FetchFlowArgs, ["ticker"]) },
  { name: "fetch_oi_changes", description: "Fetch open-interest changes from Unusual Whales (per-ticker or market-wide). Categorizes each OI change row into MASSIVE (≥$10M premium) / LARGE (≥$5M) / SIGNIFICANT (≥$1M) / MODERATE, BULLISH/BEARISH (call vs put inferred from OCC symbol), CLOSING-prefixed when oi_diff<0, LEAP flag when expiry year is 2027/2028. Returns total_count, total_oi_change, total_premium, massive_count, plus categorized data[]. Use to surface institutional positioning that flow-alerts may miss. Source: ported from radon scripts/fetch_oi_changes.py.",
    inputSchema: toolInput(FetchOiChangesArgs, []) },
  { name: "flow_analysis", description: "Broker-agnostic per-position flow classification. Takes positions[] (ticker, direction LONG/SHORT/BUY/SELL/DEBIT/CREDIT, structure label) → fetches darkpool flow per ticker → analyzes signal (score, sustained_days, recent vs aggregate direction conflict, options conflict, num_prints adequacy) → categorizes each position into supports / against / watch / neutral. Returns analysis_time, supports[], against[], watch[], neutral[], errors[] all sorted by strength desc. Source: ported from radon scripts/flow_analysis.py + scanner.py analyze_signal — broker-agnostic (no portfolio.json dependency).",
    inputSchema: toolInput(FlowAnalysisArgs, ["positions"]) },
  { name: "discover_flow", description: "Discover edge candidates via dark-pool + options-flow confluence (UW). Modes: market (fetch market-wide flow alerts ≥ min_premium → aggregate per ticker → DP-validate top tickers) or targeted (per-ticker flow + DP scan over a fixed list). Score 0-100 weighted: dp_strength 30 + dp_sustained 20 + confluence 20 + vol_oi 15 + sweeps 15. Vol/OI tiers: ≤1.0→0, 1-2→0-50, 2-4→50-100, >4→100. Sweep tiers: 0/1/≥2 → 0/50/100. Excludes indices (SPX/NDX/RUT/VIX/DJX/OEX/XSP) by default + caller-supplied excluded_tickers. Returns ranked candidates[] w/ score breakdown, dp metrics, options bias, sustained days. Source: ported from radon scripts/discover.py.",
    inputSchema: toolInput(DiscoverFlowArgs, []) },
  { name: "aggregate_analyst_reports", description: "Combine 4 analyst markdown reports (fundamentals/market/news/sentiment) into one structured signal feed. Returns signal_score 0-100, net_bias [-1,1], confluence_summary (STRONG_CONFLUENCE/WEAK/MIXED/INSUFFICIENT_DATA), conflict_points (cross-source disagreements), top_catalysts (extracted from news+fundamentals), top_risks (from sentiment+fundamentals). Deterministic — no LLM. Use to roll up Phase 3 analyst Tasks into one ranking input for Phase 4. Ported from TauricResearch/TradingAgents graph state aggregation.",
    inputSchema: toolInput(AggregateAnalystReportsArgs, ["ticker"]) },
  { name: "synthesize_debate", description: "Synthesize bull/bear researcher arguments into a structured verdict. Returns rating (Buy/Overweight/Hold/Underweight/Sell) + verdict (BUY/HOLD/SELL) + conviction 1-5 + key_risks[] + thesis_summary + position_sizing_notes. Scores each side by counting evidence markers (numeric claims, % changes, dates, R-rule citations, rebuttals). Respects context (HALT regime caps at Hold; sub-TIER-1 signal caps at Hold; r_violations force Hold). Deterministic. Ported from TauricResearch/TradingAgents research_manager (v0.2.4 ResearchPlan structured-output).",
    inputSchema: toolInput(SynthesizeDebateArgs, ["ticker"]) },
  { name: "risk_debate_3stance", description: "Run 3-stance risk debate (aggressive/conservative/neutral) over a candidate proposal. Returns each stance's {verdict, size_multiplier, argument, citations} plus consensus_verdict (APPROVE/MODIFY/BLOCK) + final size_multiplier. Hard blocks: R-violations, margin debit, over-cap concentration, HALT-regime opening buy, sub-TIER-1 signal score. Replaces TradingAgents 3-agent ping-pong w/ one deterministic call. Ported from TauricResearch/TradingAgents risk_mgmt/{aggressive,conservative,neutral}_debator.",
    inputSchema: toolInput(RiskDebate3StanceArgs, ["proposal"]) },
  { name: "reflect_trades", description: "Reflection harness over closed trades. Aggregates win-rate, P&L, R-rule breaches w/ counts + examples, revenge-roll patterns (≥2 rolls then LOSS), pattern-drift alerts (degrading win-rate, ticker concentration in losses, structure repeatedly losing, HALT-regime bypasses). Emits structured lessons[] w/ category + severity + evidence. Deterministic — caller passes closed-trades array (from session_write JSONs or vault journal). Ported from TauricResearch/TradingAgents graph/reflection.py + memory.py.",
    inputSchema: toolInput(ReflectTradesArgs, []) },
  { name: "fred_series", description: "FRED (St. Louis Fed) latest-observation lookup for one or more macro series (e.g. VIXCLS, T10Y2Y, DFF, UNRATE, CPIAUCSL, DGS10). Returns {series_id: {date, value}} or {error} per series. Free tier, key required (FRED_API_KEY).",
    inputSchema: toolInput(FredSeriesArgs, ["series_ids"]) },
  { name: "av_quote", description: "Alpha Vantage GLOBAL_QUOTE for one ticker OR macro series (REAL_GDP, TREASURY_YIELD, FEDERAL_FUNDS_RATE, CPI, INFLATION, UNEMPLOYMENT, NONFARM_PAYROLL, RETAIL_SALES, DURABLES, REAL_GDP_PER_CAPITA). Free tier 25/day, 5/min — use as FMP/Finnhub fallback. Key required (ALPHA_VANTAGE_API_KEY).",
    inputSchema: toolInput(AvQuoteArgs, []) },
  { name: "llm_council", description: "LLM Trading Council — model-diverse 3-stage debate (Karpathy llm-council pattern + Tensor-Trade Skeptic + DisagreementPoint extensions). Stage 1: 6 seats (Anthropic + OpenAI + Google mix, w/ permanent Skeptic) opine on candidate via structured envelope (thesis/supporting_points/risks/verdict/confidence). Stage 2: anonymized cross-rank by analytical quality. Stage 3: Gemini chair synthesizes final structured JSON (verdict/conviction/pros/cons/recommendation/sizing_note/disagreement_points/model_rankings) w/ consensus-threshold gating (DEFER if <N voices align). Eligibility gate: skips under HALT regime, skips rolls (R1-R9 deterministic gates suffice), TIER-1 only (signal_rank≥40). Requires ANTHROPIC_API_KEY + OPENAI_API_KEY + GEMINI_API_KEY. Cost ~$0.75-3/proposal. Direct provider routing — no OpenRouter dependency. Feeds Phase 4 research-manager T2 alongside bull/bear T1.",
    inputSchema: toolInput(LlmCouncilArgs, ["candidate"]) },
  { name: "uw_darkpool", description: "UnusualWhales darkpool prints (direct REST, replaces mcp__unusualwhales__uw_darkpool). command=ticker (default, requires ticker) → block prints for one name; command=recent → market-wide recent prints. Filter via limit.",
    inputSchema: toolInput(UwDarkpoolArgs, []) },
  { name: "uw_flow", description: "UnusualWhales options flow alerts (direct REST, replaces mcp__unusualwhales__uw_flow). command=flow_alerts (default, market-wide smart-money premium) or command=ticker (per-name flow). Filter via limit.",
    inputSchema: toolInput(UwFlowArgs, []) },
  { name: "uw_insider", description: "UnusualWhales insider trading (direct REST, replaces mcp__unusualwhales__uw_insider). command=transactions (default; optional ticker filter) → recent insider buys/sells; command=buy_sells (requires ticker) → aggregated buy/sell summary for a name.",
    inputSchema: toolInput(UwInsiderArgs, []) },
  { name: "uw_congress", description: "UnusualWhales congressional trading (direct REST, replaces mcp__unusualwhales__uw_congress + uw_politicians). command=recent_trades (default) or command=late_reports.",
    inputSchema: toolInput(UwCongressArgs, []) },
  { name: "uw_shorts", description: "UnusualWhales short interest (direct REST, replaces mcp__unusualwhales__uw_shorts). command=data (default; SI/days-to-cover), interest_float, or volume_ratio. Requires ticker.",
    inputSchema: toolInput(UwShortsArgs, ["ticker"]) },
  { name: "uw_institutions", description: "UnusualWhales institutional ownership (direct REST, replaces mcp__unusualwhales__uw_institutions). command=list (default; top institutions) or command=ownership (requires name → that fund's holdings). For ticker-level 13F use traderkit inst_holdings.",
    inputSchema: toolInput(UwInstitutionsArgs, []) },
  { name: "uw_seasonality", description: "UnusualWhales seasonality (direct REST, replaces mcp__unusualwhales__uw_seasonality). command=monthly (default, requires ticker), year_month (requires ticker), or market.",
    inputSchema: toolInput(UwSeasonalityArgs, []) },
  { name: "uw_news", description: "UnusualWhales news headlines (direct REST, replaces mcp__unusualwhales__uw_news). Optional ticker filter (omit for market-wide). Filter via limit.",
    inputSchema: toolInput(UwNewsArgs, []) },
  { name: "uw_technicals", description: "UnusualWhales options-positioning technicals (direct REST, replaces mcp__unusualwhales__uw_technicals). Requires ticker. command=all (default) bundles greek_exposure + spot_exposures + realized_vol; or pick one.",
    inputSchema: toolInput(UwTechnicalsArgs, ["ticker"]) },
  { name: "uw_gex_levels", description: "Per-strike dealer gamma-exposure (GEX) walls for ANY single name (not just SPX/SPY). Fetches UW greek-exposure/strike, buckets it (~0.5% of spot for equities), and computes call wall, put wall, GEX flip, max/second magnet, max accelerator, and CC-relevant upside call walls (resistance ceilings above spot). Pass short_call_strike to get a covered-call signal (above_wall_safe / at_wall / below_wall_risk) for roll/strike selection; pass atm_iv (decimal) for a 1-day expected range. Source: ported from radon gex_scan.py, generalized to equities + CC ladder.",
    inputSchema: toolInput(UwGexLevelsArgs, ["ticker"]) },
  { name: "uw_stock", description: "UnusualWhales stock info + live state (direct REST, replaces mcp__unusualwhales__uw_stock). Requires ticker. Returns sector/market-cap/issue-type info + close/prev-close/intraday-change.",
    inputSchema: toolInput(UwStockArgs, ["ticker"]) },
  { name: "uw_earnings", description: "UnusualWhales earnings (direct REST, replaces mcp__unusualwhales__uw_earnings + get_earnings_history). Requires ticker. Returns upcoming + historical earnings prints.",
    inputSchema: toolInput(UwEarningsArgs, ["ticker"]) },
  { name: "uw_financials", description: "UnusualWhales financial statements (direct REST, replaces mcp__unusualwhales__get_balance_sheets/get_cash_flows/get_income_statements). Requires ticker. statement=all (default) | balance_sheet | cash_flow | income. limit = number of periods.",
    inputSchema: toolInput(UwFinancialsArgs, ["ticker"]) },
  { name: "uw_alerts", description: "UnusualWhales triggered alerts (direct REST, replaces mcp__unusualwhales__uw_alerts). Returns recently triggered alerts from configured rules. Filter via limit.",
    inputSchema: toolInput(UwAlertsArgs, []) },
  { name: "uw_etf", description: "UnusualWhales ETF data (direct REST, replaces mcp__unusualwhales__uw_etf). Requires ticker. command=info (default; name/aum/expense-ratio — also the ETF-vs-equity classification probe), holdings, exposure, or all. A 200 with ETF fields ⇒ ticker is an ETF.",
    inputSchema: toolInput(UwEtfArgs, ["ticker"]) },
];

const SECRETS = [
  process.env.SNAPTRADE_CONSUMER_KEY, process.env.SNAPTRADE_USER_SECRET,
  process.env.SNAPTRADE_USER_ID, process.env.SNAPTRADE_CLIENT_ID,
  process.env.UW_TOKEN, process.env.FINNHUB_API_KEY,
  process.env.FMP_API_KEY, process.env.FRED_API_KEY,
  process.env.ALPHA_VANTAGE_API_KEY,
].filter((x): x is string => !!x);

const SNAPTRADE_READ_ALLOWED_ENV = [
  "SNAPTRADE_CONSUMER_KEY",
  "SNAPTRADE_USER_SECRET",
  "SNAPTRADE_USER_ID",
  "SNAPTRADE_CLIENT_ID",
  "PATH",
  "HOME",
] as const;

function allowedEnv(allowlist: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of allowlist) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

async function main() {
  const allProfiles = await loadAllProfiles(PROFILES_DIR).catch(() => []);
  let snaptradeRead: SnaptradeReadClient | null = null;
  if (process.env.SNAPTRADE_READ_COMMAND) {
    try {
      snaptradeRead = await connectSnaptradeRead({
        command: process.env.SNAPTRADE_READ_COMMAND,
        args: (process.env.SNAPTRADE_READ_ARGS ?? "").split(" ").filter(Boolean),
        env: allowedEnv(SNAPTRADE_READ_ALLOWED_ENV),
      });
    } catch (e) {
      process.stderr.write(`traderkit: could not start snaptrade-read: ${(e as Error).message}\n`);
    }
  }

  const server = new Server({ name: "traderkit", version: "0.5.1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const deps = { allProfiles, snaptradeRead };
    try {
      let result: unknown;
      switch (req.params.name) {
        case "check_trade":     result = await checkTradeHandler(req.params.arguments, deps); break;
        case "check_wash_sale": result = await checkWashSaleHandler(req.params.arguments, deps); break;
        case "list_profiles":   result = await listProfilesHandler(req.params.arguments, deps); break;
        case "set_profile":     result = await setProfileHandler(req.params.arguments, deps); break;
        case "scan_tlh":        result = await scanTlhHandler(req.params.arguments, deps); break;
        case "check_concentration": result = await checkConcentrationHandler(req.params.arguments, deps); break;
        case "check_ai_bott_layer": result = await checkAiBottLayerHandler(req.params.arguments); break;
        case "worldmonitor_signals": result = await worldmonitorSignalsHandler(req.params.arguments); break;
        case "regime_gate":     result = await regimeGateHandler(req.params.arguments); break;
        case "propose_trade":  result = await proposeTradeHandler(req.params.arguments, deps); break;
        case "track_tax":      result = await trackTaxHandler(req.params.arguments); break;
        case "trigger_check":  result = await triggerCheckHandler(req.params.arguments); break;
        case "signal_rank":    result = await signalRankHandler(req.params.arguments); break;
        case "classify_holding": result = await classifyHoldingHandler(req.params.arguments); break;
        case "trading_calendar": result = await tradingCalendarHandler(req.params.arguments); break;
        case "performance_metrics": result = await performanceMetricsHandler(req.params.arguments); break;
        case "thesis_fit":     result = await thesisFitHandler(req.params.arguments); break;
        case "session_write":  result = await sessionWriteHandler(req.params.arguments); break;
        case "broker_route":   result = await brokerRouteHandler(req.params.arguments); break;
        case "screen_options": result = await screenOptionsHandler(req.params.arguments); break;
        case "calc_roll":      result = await calcRollHandler(req.params.arguments); break;
        case "fmp_fundamentals": result = await fmpFundamentalsHandler(req.params.arguments); break;
        case "calc_max_pain":  result = await calcMaxPainHandler(req.params.arguments); break;
        case "inst_holdings":  result = await instHoldingsHandler(req.params.arguments); break;
        case "track_activists": result = await trackActivistsHandler(req.params.arguments); break;
        case "explain_payoff": result = await explainPayoffHandler(req.params.arguments); break;
        case "analyze_structure": result = await analyzeStructureHandler(req.params.arguments); break;
        case "squeeze_score":  result = await squeezeScoreHandler(req.params.arguments); break;
        case "report_trades":  result = await reportTradesHandler(req.params.arguments); break;
        case "verify_fill":    result = await verifyFillHandler(req.params.arguments); break;
        case "repricing_check": result = await repricingCheckHandler(req.params.arguments); break;
        case "reconcile_reminder": result = await reconcileReminderHandler(req.params.arguments); break;
        case "expiry_priority": result = await expiryPriorityHandler(req.params.arguments); break;
        case "combo_fillability": result = await comboFillabilityHandler(req.params.arguments); break;
        case "earnings_calendar": result = await earningsCalendarHandler(req.params.arguments); break;
        case "rvi_gap": result = await rviGapHandler(req.params.arguments); break;
        case "classify_trade_outcome": result = await classifyTradeOutcomeHandler(req.params.arguments); break;
        case "macro_overlay": result = await macroOverlayHandler(req.params.arguments); break;
        case "backtest_signals": result = await backtestSignalsHandler(req.params.arguments); break;
        case "monitor_position": result = await monitorPositionHandler(req.params.arguments); break;
        case "fetch_flow":       result = await fetchFlowHandler(req.params.arguments); break;
        case "fetch_oi_changes": result = await fetchOiChangesHandler(req.params.arguments); break;
        case "flow_analysis":    result = await flowAnalysisHandler(req.params.arguments); break;
        case "discover_flow":    result = await discoverFlowHandler(req.params.arguments); break;
        case "aggregate_analyst_reports": result = await aggregateAnalystReportsHandler(req.params.arguments); break;
        case "synthesize_debate":         result = await synthesizeDebateHandler(req.params.arguments); break;
        case "risk_debate_3stance":       result = await riskDebate3StanceHandler(req.params.arguments); break;
        case "reflect_trades":            result = await reflectTradesHandler(req.params.arguments); break;
        case "fred_series":     result = await fredSeriesHandler(req.params.arguments); break;
        case "av_quote":        result = await avQuoteHandler(req.params.arguments); break;
        case "llm_council":     result = await llmCouncilHandler(req.params.arguments); break;
        case "uw_darkpool":     result = await uwDarkpoolHandler(req.params.arguments); break;
        case "uw_flow":         result = await uwFlowHandler(req.params.arguments); break;
        case "uw_insider":      result = await uwInsiderHandler(req.params.arguments); break;
        case "uw_congress":     result = await uwCongressHandler(req.params.arguments); break;
        case "uw_shorts":       result = await uwShortsHandler(req.params.arguments); break;
        case "uw_institutions": result = await uwInstitutionsHandler(req.params.arguments); break;
        case "uw_seasonality":  result = await uwSeasonalityHandler(req.params.arguments); break;
        case "uw_news":         result = await uwNewsHandler(req.params.arguments); break;
        case "uw_technicals":   result = await uwTechnicalsHandler(req.params.arguments); break;
        case "uw_gex_levels":   result = await uwGexLevelsHandler(req.params.arguments); break;
        case "uw_stock":        result = await uwStockHandler(req.params.arguments); break;
        case "uw_earnings":     result = await uwEarningsHandler(req.params.arguments); break;
        case "uw_financials":   result = await uwFinancialsHandler(req.params.arguments); break;
        case "uw_alerts":       result = await uwAlertsHandler(req.params.arguments); break;
        case "uw_etf":          result = await uwEtfHandler(req.params.arguments); break;
        default: throw new Error(`unknown tool: ${req.params.name}`);
      }
      const safe = redact(result, SECRETS);
      return { content: [{ type: "text", text: JSON.stringify(safe, null, 2) }] };
    } catch (e) {
      const msg = (e as Error).message;
      const safeMsg = String(redact(msg, SECRETS));
      return { content: [{ type: "text", text: `error: ${safeMsg}` }], isError: true };
    }
  });
  await server.connect(new StdioServerTransport());
  process.stderr.write(`traderkit: ready (profiles=${allProfiles.length})\n`);
}

main().catch((e) => { process.stderr.write(`traderkit fatal: ${e?.message}\n`); process.exit(1); });

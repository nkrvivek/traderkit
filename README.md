# traderkit

[![npm](https://img.shields.io/npm/v/traderkit)](https://www.npmjs.com/package/traderkit)
[![CI](https://github.com/nkrvivek/traderkit/actions/workflows/ci.yml/badge.svg)](https://github.com/nkrvivek/traderkit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Risk-gate MCP server for AI-assisted trading. 33 tools that enforce caps, wash-sale rules, regime-based sizing, execution-discipline rules (R0–R8, R14), portfolio analysis, and darkpool / options-flow signals — plus options screening, 13F smart-money tracking, activist-filing surveillance, and a model-diverse LLM council (Anthropic + OpenAI + Google) that synthesizes a multi-provider verdict on TIER-1 candidates — before any order hits your broker.

Built for [Claude Code](https://claude.ai/claude-code). Works with any MCP client.

## Quick install

**Zero-env**:
```bash
curl -fsSL https://raw.githubusercontent.com/nkrvivek/traderkit/main/scripts/bootstrap.sh | bash
```

**Manual** (Node 20+ + Claude Code CLI already installed):
```bash
npx -y traderkit                    # risk gate MCP (this repo)
npx -y snaptrade-trade-mcp          # unified reads + trade execution
```

Both packages are required. `traderkit` declares `snaptrade-trade-mcp` as a peerDependency. `snaptrade-trade-mcp@0.2.0+` covers both read endpoints (accounts, balances, positions, holdings, activities) and trading (equity + multi-leg options) — no separate read server needed.

## What it does

```
AI Assistant ──PreToolUse hook──► traderkit MCP (23 tools)
                                     │
                                     ├─ caps + wash-sale gate
                                     ├─ regime sizing (CLEAR → HALT)
                                     ├─ concentration analysis + HHI
                                     ├─ proposal assembly + tax tracking
                                     ├─ thesis fit scoring
                                     ├─ performance metrics
                                     │
                                     ▼
                               pass/block decision
```

| Category | Tools |
|----------|-------|
| **Pre-trade gates** | `check_trade` (R0/R1/R2/R7 + caps + wash-sale), `check_wash_sale`, `regime_gate` |
| **Execution discipline** | `verify_fill` (R4), `repricing_check` (R3), `reconcile_reminder` (R5), `expiry_priority` (R8), `combo_fillability` (R14) |
| **Portfolio analysis** | `check_concentration`, `scan_tlh`, `classify_holding`, `trigger_check`, `performance_metrics` |
| **Options screening + rolls** | `screen_options`, `calc_roll`, `calc_max_pain` |
| **Fundamentals + smart-money** | `fmp_fundamentals`, `inst_holdings`, `track_activists` |
| **Proposal + tax** | `propose_trade`, `track_tax`, `signal_rank`, `thesis_fit`, `broker_route`, `explain_payoff` |
| **Flow signals (radon port)** | `fetch_flow`, `fetch_oi_changes`, `flow_analysis`, `discover_flow` |
| **TradingAgents (debate synthesis)** | `aggregate_analyst_reports`, `synthesize_debate`, `risk_debate_3stance`, `reflect_trades` |
| **LLM Trading Council (model-diverse synthesis)** | `llm_council` |
| **Session management** | `list_profiles`, `set_profile`, `trading_calendar`, `session_write`, `report_trades` |

## Execution discipline rules (R0–R8, R14)

Codified from real incidents (see [BBAI Apr-17 post-mortem](https://github.com/nkrvivek/traderkit/blob/main/docs/postmortems/bbai-apr17.md) + [combo-fillability RFC](docs/fillability-rfc.md)). `check_trade` composes R0/R1/R2/R7 as pre-submit gates; R3/R4/R5/R8/R14 are standalone tools used around the order lifecycle.

| Rule | Gate/Tool | Enforcement |
|------|-----------|-------------|
| **R0** | `check_trade` (freshness) | **Fail-closed on any stale/missing `as_of` timestamp.** No trade ever proceeds on stale data. Per-field TTLs (quotes 60s, regime 15m, portfolio 4h, activities 24h) configurable per profile. |
| **R1** | `check_trade` (expiry-day-window) | No new short legs on expiry-day during first 60 min (13:30–14:30Z default). Origin: BBAI 14:07Z rewrite @ $0.10 when 10:30Z would have been 2.5× better. |
| **R2** | `check_trade` (strike-grid) | ≥3 adjacent strikes required; rejects selection materially worse (>25%) than best theta-per-Δ. Origin: BBAI chose $3 @ $0.10 when $3.5 @ $0.25 was available. |
| **R3** | `repricing_check` | Flags DAY LMT orders stale > 30min AND underlying moved > 2% → REPRICE. Origin: BBAI 1/25 filled while stock rallied 8.2% on stale limit. |
| **R4** | `verify_fill` | Coerces session status: `executed` / `partial-fill (N/M)` / `submitted-unverified`. Required before `session_write status=executed`. Origin: BBAI session marked executed while only 1/25 filled → 2-day vault drift. |
| **R5** | `reconcile_reminder` | IBKR multi-leg sessions must reconcile vs IB Flex within 24h. Returns ready-to-run shell command w/ configured query_id. |
| **R6** | (approval model) | Every order requires explicit in-turn user approval. Existing hard rule. |
| **R7** | `check_trade` (thesis-required) | Every trade must tie to an active thesis (or declare discretionary_event + ≥10-char rationale). |
| **R8** | `expiry_priority` | Expiry-day ordering: ITM→ATM→OTM→new-cycle. Violations flagged when new-cycle writes planned before ITM/ATM resolutions. |
| **R14** | `combo_fillability` | Multi-leg BAG fillability score (HIGH/MEDIUM/LOW) from near-leg DTE/OI, ADV, spot-to-strike, minutes-to-close, leg-width, net-vs-mid. On LOW → emits leg-out plan (BTC near @ ask + STO far @ bid) instead of repricing combo down to zero. Origin: BBAI 2026-04-23 $4P Apr-24/May-01 calendar roll (permId 2061124997) — 3 reprices $0.10→$0.05→$0.00 zero fill → canceled → forced assignment. Also wired into `calc_roll` warnings + `propose_trade` `roll_context` + `repricing_check` BAG path. |

## Never on stale data

`R0` is **on by default** and **not opt-outable per-request**. Every input to `check_trade` that requires live data must carry an `as_of` ISO timestamp ≤ its TTL. No timestamp = reject. Stale timestamp = reject. This costs real money and is not configurable via inline override — disable only by editing the profile's `rules.R0_no_stale_data: false` (not recommended).

Every gate run writes an append-only audit line to `$TRADERKIT_HOME/gate_audit/YYYY-MM-DD.jsonl` with a sha256 hash chain (each row contains prev row's hash) — tampering is detectable.

See the [npm package README](mcp-servers/traderkit/README.md) for detailed documentation of each tool.

## TradingAgents tools

Four deterministic Zod-schema transforms ported from [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents) v0.2.4 patterns. These are pure-data tools — no LLM call inside the MCP. The "synthesis intelligence" lives in the agent that consumes the structured slot (see the [trade-refresh](https://github.com/nkrvivek/trade-refresh) agent layer); the tool just enforces the schema and validates inputs.

| Tool | Input | Output |
|---|---|---|
| `aggregate_analyst_reports` | 4 markdown reports (fundamentals/market/news/sentiment) | `{signal_score 0-100, conflict_points[], confluence_summary, top_catalysts[], top_risks[]}` |
| `synthesize_debate` | bull + bear arguments + ticker + context | `{verdict: BUY\|HOLD\|SELL, conviction 1-5, key_risks[], thesis_summary, position_sizing_notes}` |
| `risk_debate_3stance` | proposal + portfolio_state + regime_tier + rules_text | `{aggressive, conservative, neutral} × {verdict, sizing} + consensus_verdict + size_multiplier` |
| `reflect_trades` | `{lookback_days, book}` over closed trades | `{lessons[], r_rule_breaches[], pattern_drift_alerts[], revenge_roll_count}` |

CI exercises `reflect_trades` against a representative weekly fixture (`test/fixtures/reflect-week.json` — 10 trades w/ R7 breaches, HALT-regime entry, 2-roll TECK, TLH loss) via the existing [`ci.yml`](.github/workflows/ci.yml) — 6 fixture assertions inside the 401-test suite.

## LLM Trading Council

`llm_council` ports the [karpathy/llm-council](https://github.com/karpathy/llm-council) 3-stage pattern (collect → cross-rank → chair synthesize) and combines it with the Tensor-Trade permanent-Skeptic-seat overlay. Provides **model diversity** (Anthropic + OpenAI + Google) orthogonal to TradingAgents' role diversity (bull/bear/PM).

| Stage | What runs |
|---|---|
| **1. Independent analysis** | N seats in parallel produce structured `{thesis, supporting_points[], risks[], verdict, confidence}` envelopes. Failed seats silently dropped (Karpathy pattern). |
| **2. Cross-ranking** | N seats rank Stage-1 outputs anonymized as "Response A/B/C/…" by analytical quality. Acts as orthogonal quality signal. |
| **3. Chair synthesis** | Chair model returns structured JSON: `{verdict, conviction, consensus_met, agreement_score, pros[], cons[], recommendation, sizing_note, disagreement_points[], model_rankings, stage1_voices, stage1_verdict_tally, council_size}`. |

**Stage-0 eligibility gates** (skip with no LLM cost): `regime_tier="halt"` (`skip_reason: regime_halt`), `is_roll=true` (`skip_rolls`), `signal_rank < 40` (`below_tier1`).

**Consensus-threshold gating:** chair sets `verdict = "DEFER"` when fewer than `consensus_threshold` Stage-1 voices align on the same verdict at HIGH/MED confidence. DEFER preserves the verdict pipeline — downstream debate continues, PM may still APPROVE/REJECT, but with explicit "council DEFER" flag.

**Recommended 6-seat config** (5 neutral + 1 Skeptic, 3 providers, Gemini chair):

```yaml
seats:
  - {model: "claude-opus-4-7",      provider: "anthropic", stance: "neutral"}
  - {model: "claude-sonnet-4-6",    provider: "anthropic", stance: "neutral"}
  - {model: "gpt-5.1",              provider: "openai",    stance: "neutral"}
  - {model: "gpt-4o",               provider: "openai",    stance: "neutral"}
  - {model: "gemini-3-pro-preview", provider: "google",    stance: "neutral"}
  - {model: "claude-sonnet-4-6",    provider: "anthropic", stance: "skeptic"}
chairman_model: "gemini-3-pro-preview"
chairman_provider: "google"
consensus_threshold: 4   # >50% of 6
```

**Cost / latency** (validated 2026-05-05 on NTNX + AAPL synthetic): **~$0.15–0.50 per proposal** at 6 seats × 3 stages × ~3K tokens, **~25–30s wall time**. Cache TTL 4h at `cache/council-verdicts/{date}/{ticker}.json`. Per-run cap `max_council_runs: 5`.

**Required env vars:** `ANTHROPIC_API_KEY` (Claude seats), `OPENAI_API_KEY` (GPT seats), `GEMINI_API_KEY` (Gemini seat / chair).

See [npm package README](mcp-servers/traderkit/README.md#llm_council) for full input schema, output shape, and failure-handling matrix.

## Slash-command skills

`./scripts/setup.sh` also symlinks two Claude Code skills into `~/.claude/skills/`:

| Skill | Command | Purpose |
|---|---|---|
| `trade` | `/trade <profile> [flags]` | 5-phase portfolio refresh + trade proposal + risk gate |
| `review` | `/review <profile> <scope>` | Monthly / quarterly / YTD retrospective analytics |

After setup, you can run `/trade main --mode dry-run` in a Claude session to exercise the full pipeline. Skills are opinion-free — no hard-coded paths, no bundled theses, no Python dependency. See [skills/README.md](skills/README.md).

## Full setup

Clone, run setup, trade:

```bash
git clone https://github.com/nkrvivek/traderkit
cd traderkit
npm install
./scripts/setup.sh
# edit ~/.traderkit/.env with credentials
# edit ~/.traderkit/profiles/*.md with your account_ids
./scripts/doctor.sh
cd vault && claude
```

See [SETUP.md](SETUP.md) for the full walkthrough.

### What `setup.sh` creates

```
~/.traderkit/
├── .env                     # broker credentials
├── profiles/                # trading profile YAML frontmatter
│   ├── personal.md
│   └── llc.md
├── scripts/
│   └── pre-tool-use.js      # PreToolUse hook (auto-gates trades)
└── vault/                   # Obsidian-style trading wiki
    ├── dashboard.md
    ├── market-regime.md
    ├── theses/
    ├── sessions/
    └── ...
```

### Profile example

```yaml
---
name: personal
broker: snaptrade
account_id: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
tax_entity: personal
caps:
  max_order_notional: 10000
  max_single_name_pct: 25
  forbidden_tools: []
  forbidden_leg_shapes: [naked_put, naked_call]
rules:
  strict_mode: true          # default true — fail-closed on missing data
  R0_no_stale_data: true     # reject on any stale/missing as_of
  R1_expiry_day_window: true # no new short legs first 60min of expiry
  R2_strike_grid: true       # require ≥3 adjacent strikes w/ theta-per-Δ
  R7_thesis_required: true   # every trade must cite active thesis
  quote_ttl_sec: 60
  regime_ttl_sec: 900
  portfolio_total_ttl_sec: 14400
  activities_ttl_sec: 86400
---
```

### PreToolUse hook

The hook calls `check_trade` + `regime_gate` automatically before any destructive broker tool fires. Add to `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "mcp__snaptrade-trade__equity_force_place|mcp__snaptrade-trade__mleg_place",
        "command": "node ~/.traderkit/scripts/pre-tool-use.js"
      }
    ]
  }
}
```

## Key design decisions

- **Fail-closed by default.** If traderkit can't evaluate a trade, it blocks.
- **Read-only risk gate.** Traderkit checks and sizes — it never places orders. Order execution stays with the broker MCP (SnapTrade, TradeStation).
- **Credential redaction.** All tool responses are scrubbed — any env secret substring (8+ chars) is replaced with `<REDACTED>`.
- **Tax-entity pooling.** Wash-sale checks span all accounts with the same `tax_entity`. Personal brokerage + IRA = one pool. LLC = separate pool.

## Supported brokers

Works with any broker connected via [SnapTrade](https://snaptrade.com/):

- Fidelity (read + write)
- E-Trade (read + write)
- IBKR (read + write)
- Schwab (read + write)
- Robinhood (read-only)
- TradeStation (via traderkit native `ts_*` tools — `ts_balances`, `ts_positions`, `ts_quotes`, `ts_orders`, `ts_place_order`)
- Ally, Morgan Stanley — manual execution only

## Disclaimer

This software places real orders against real brokerage accounts. The authors disclaim all liability for losses, tax consequences, broker-side errors, model hallucinations, or any other outcome of its use. **Not financial advice.** You are responsible for every order approved in the REPL. Test on paper/sandbox accounts first. Do not disable the PreToolUse hook. Do not remove the risk gates.

## License

MIT. See [LICENSE](LICENSE).

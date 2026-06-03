# Phase 2 — REFRESH (broker data)

**Inputs:** profile, regime tier
**Outputs:** NAV, positions, delta since last-session

## Primary source — SnapTrade

Run in parallel:

```
mcp__snaptrade-trade__check_status()
mcp__snaptrade-trade__list_accounts()
mcp__snaptrade-trade__get_balance(account_id="<from-profile>")
mcp__snaptrade-trade__get_positions(account_id="<from-profile>")
```

Capture:
- total_equity, cash_balance, buying_power
- positions[] with { symbol, quantity, market_value, unrealized_pl, cost_basis }

## Optional — TradeStation (if configured)

Only if profile `broker: tradestation`. Use traderkit native `ts_*` tools (no external MCP needed):

```
mcp__traderkit__ts_balances(account_id="<ts-account-id>")
mcp__traderkit__ts_positions(account_id="<ts-account-id>")
```

Merge into unified positions list.

## Compute

```
mcp__traderkit__check_concentration(
  positions=<positions>,
  total_equity=<nav>,
  profile="<name>"
)
```

Flags: HEADROOM | AT-CAP | NEAR-CAP | OVER-CAP per position + HHI.

```
mcp__traderkit__classify_holding(
  positions=<positions>,
  theses=[],  // empty if no theses
  thresholds={ core: 5, opportunistic: 2.5, speculative: 1 }
)
```

Tags each: CORE | OPPORTUNISTIC | SPECULATIVE | PURE_SPECULATIVE.

## Held-position flow scan (UW — radon port)

Skip if `UW_TOKEN` unset → emit `[DEGRADED] UW_TOKEN missing · flow scan skipped`.

Position-aware classifier across all held tickers in one call:

```
mcp__traderkit__flow_analysis(
  positions=<from-snaptrade-positions>,    # [{ticker, direction, structure}]
  lookback_trading_days=5
)
```

Returns 4 buckets: `supports[]` / `against[]` / `watch[]` / `neutral[]`.

- **`against[]`** → surface as 🔴 in dashboard ("flow contradicts position direction"). Phase 4 may flag for defensive review.
- **`watch[]`** → MODERATE flow w/ recent-day conflict OR WEAK w/ conflict. Surface as 🟡 ("flow flipping").
- **`supports[]`** → ✅ thesis tailwind. Carry confluence into Phase 4 boost.
- **`neutral[]`** → no actionable flow. Silent.

## Freshness

If last session doc in vault <4h old AND no `--force-fresh`, skip full refresh; reuse cached NAV.

## Emit

```
Data: NAV $<nav> · δ $<delta> since <last-session-time> · <n-positions> positions
Concentration: <n-at-cap> AT-CAP · HHI <score>
  OVER-CAP: <ticker1> (<pct>% vs <cap>%), <ticker2> (...)   ← if any
Flow: <n-supports> ✅ · <n-watch> 🟡 · <n-against> 🔴 · <n-neutral> ─
  🔴 against: <ticker> <signal> <flow_dir> — <note>           ← if any
  🟡 watch:   <ticker> <signal> <flow_dir>↔<recent_dir>       ← if any
```

## Failure modes

- SnapTrade unreachable → `[DEGRADED] snaptrade offline · using last cached snapshot`
- No profile account_id → exit "set account_id in profile"
- Position symbol normalization fails → continue, flag individual positions

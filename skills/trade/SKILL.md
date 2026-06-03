---
name: trade
description: Portfolio refresh + trade proposal + risk gate pipeline powered by traderkit MCP tools. Invoked via /trade <profile> [flags]. Works with any broker connected via SnapTrade or TradeStation.
---

# /trade — traderkit orchestrator

5-phase pipeline that uses traderkit MCP tools to gate and size trades. Generic — no hard-coded paths, no opinionated book structure. Customize via `~/.traderkit/profiles/<name>.md` + optional vault at `TRADERKIT_VAULT`.

## Usage

```
/trade <profile> [--mode interactive|dry-run|scheduled] [--skip signals,discovery] [--force-fresh] [--trigger pre-open|midday|close|monthly]
```

- `<profile>` — name of profile file in `~/.traderkit/profiles/<profile>.md` (created by `./scripts/setup.sh`).
- Default `--mode interactive`. `dry-run` builds proposals without executing.

## Architecture

```
Phase 1: BOOT       profile load + regime gate
Phase 2: REFRESH    broker data (SnapTrade + traderkit ts_* tools) + risk read + held-position flow scan
Phase 3: DISCOVER   FMP earnings + SEC activists + 13F smart-money + UW darkpool/options-flow (radon port)
Phase 4: PROPOSE    traderkit tools assemble + size + flow-confluence tag + check
Phase 5: PERSIST    session doc write (vault optional)
```

## Phase files

| Phase | File |
|---|---|
| 1 BOOT | `@~/.claude/skills/trade/phases/01-boot.md` |
| 2 REFRESH | `@~/.claude/skills/trade/phases/02-refresh.md` |
| 3 DISCOVER | `@~/.claude/skills/trade/phases/03-discover.md` |
| 4 PROPOSE | `@~/.claude/skills/trade/phases/04-propose.md` |
| 5 PERSIST | `@~/.claude/skills/trade/phases/05-persist.md` |

## Required MCP servers

- **traderkit** (this repo) — 32 risk + sizing + flow-signal tools
- **snaptrade-trade-mcp** — portfolio reads (Fidelity, Robinhood, E-Trade, IBKR, Schwab)
- **snaptrade-trade-mcp** — broker execution (optional, only for `--mode interactive`)

Optional:
- **exa** — qualitative catalysts (Phase 3)

TradeStation: native `ts_*` tools are bundled in traderkit (no separate MCP needed).

## Required env vars

| Var | Purpose |
|---|---|
| `TRADERKIT_ROOT` | Config + profiles dir (default `~/.traderkit`) |
| `TRADERKIT_VAULT` | Optional notes vault for session docs |
| `SNAPTRADE_*` | SnapTrade credentials (see main README) |
| `FMP_API_KEY` | For Phase 3 earnings + fundamentals |
| `SEC_USER_AGENT` | For Phase 3 activist filings (`"your-app contact: you@example.com"`) |
| `UW_TOKEN` | For Phase 2 held-position flow scan + Phase 3 darkpool/options-flow discovery (UnusualWhales) |

## Profile schema

`~/.traderkit/profiles/<name>.md`:

```yaml
---
name: main
broker: snaptrade
account_id: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
tax_entity: personal
caps:
  max_order_notional: 10000
  max_single_name_pct: 25
  forbidden_leg_shapes: [naked_put, naked_call]
---
```

## End-of-run summary

```
[OK] /trade <profile> complete
  Mode:      <mode>
  Session:   <id>
  NAV:       $<nav>
  Regime:    <tier>
  Proposals: <n> candidates · <m> no-trade
  Executed:  <x> · Deferred: <y>
  Session doc: <path-if-vault-configured>
```

## What this skill deliberately does NOT do

- No Python orchestration (see trade-refresh repo for heavier pipeline)
- No launchd scheduling (wire your own if wanted — `scripts/` has examples)
- No opinionated thesis management (use any markdown format in your vault)
- No proprietary signal sources beyond what traderkit tools + SnapTrade MCP provide

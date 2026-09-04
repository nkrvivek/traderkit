# TradeStation

TradeStation supplies its own MCP server (install separately). Typical env:

- `TS_CLIENT_ID`, `TS_CLIENT_SECRET`, `TS_REFRESH_TOKEN`
- Standard tools: quotes, option chains, place/cancel orders, account balances.

Register under `mcpServers.tradestation` in `.claude/settings.json`.

## Risk gates

Since 2026-09-03 the traderkit hook matcher in `templates/claude-settings.json`
covers TradeStation's write path by default:

- `mcp__tradestation__place_order`
- `mcp__tradestation__cancel_order`
- `mcp__tradestation__replace_order`

Before that it covered SnapTrade only, and this page told you to add
`place_order` by hand. That made the gate opt-in on the most dangerous tool in
the stack, and only a reader who found this one line would ever have known a
live broker was running ungated.

**If you already have a `.claude/settings.json`, the template does not update it
for you.** Copy the `matcher` string across, or confirm yours contains the three
tool names above. A settings file written before this date almost certainly does
not.

Quote and chain reads are deliberately not matched, and neither are dry-run
impact tools: they place nothing, and gating them only trains you to click
through the gate.

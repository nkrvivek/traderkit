# traderkit skills

Claude Code slash-command skills that orchestrate the 23 traderkit MCP tools into opinion-free pipelines. Symlinked into `~/.claude/skills/` by `./scripts/setup.sh`.

## Skills

| Skill | Command | Purpose |
|---|---|---|
| `trade` | `/trade <profile> [flags]` | 5-phase portfolio refresh + trade proposal + risk gate |
| `review` | `/review <profile> <scope>` | Retrospective analytics (monthly / quarterly / YTD / ad-hoc) |

## Design goals

- **Zero hard-coded paths** — all state in `~/.traderkit/` + optional vault at `$TRADERKIT_VAULT`
- **No Python dependency** — pure MCP tool orchestration
- **Graceful degradation** — each phase tolerates missing env vars / MCP servers
- **Opinion-free** — no bundled theses, book names, or broker assumptions

## Quick start

```bash
git clone https://github.com/nkrvivek/traderkit && cd traderkit
./scripts/setup.sh       # installs skills, creates ~/.traderkit/, prompts for vault path
# edit ~/.traderkit/profiles/main.md with your account_id
# edit ~/.traderkit/.env with API keys
cd <vault-path>
claude
# type: /trade main --mode dry-run
```

## What this is not

A drop-in replacement for `trade-refresh`. That repo has heavier orchestration (Python scaffolding, launchd scheduling, NAV timeline, memory replay, multi-book rules, thesis management). These skills are the **portable 80%** — everything that works without opinionated infra.

## Customizing

Each phase file (`trade/phases/0X-*.md`) is independently readable. Edit in place or fork. The orchestrator skill (`trade/SKILL.md`) declares phase order but phases don't call each other directly — they're read by Claude in sequence.

## Required MCP servers

- `traderkit` (this repo)
- `snaptrade-trade-mcp` (portfolio reads)
- `snaptrade-trade-mcp` (execution, interactive mode only)

Optional:
- `exa` (qualitative catalysts in Phase 3)
- `memory` (persistent trade journal in Phase 5)

TradeStation: native `ts_*` tools are bundled in traderkit (no separate MCP needed).

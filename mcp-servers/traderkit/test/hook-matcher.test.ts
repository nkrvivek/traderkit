/**
 * Every broker write tool must be intercepted by the risk-gate hook.
 *
 * Until 2026-09-03 the matcher in templates/claude-settings.json covered
 * SnapTrade only, and docs/tradestation.md told the reader to add
 * `mcp__tradestation__place_order` by hand "if you use TS write tools". That
 * made the gate opt-in on the single most dangerous tool in the stack, and only
 * a reader who found that one line would have known a live broker was running
 * ungated.
 *
 * The asymmetry that shapes this test: listing a tool name that does not exist
 * costs nothing, because it simply never matches. Omitting one that does exist
 * costs an ungated real-money order. So the list errs toward covering more, and
 * this test errs toward failing loudly when a known write verb is absent.
 *
 * Dry-run/impact tools are deliberately NOT required: they place nothing, and
 * gating them would train the operator to click through the gate.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SETTINGS = join(__dirname, "..", "..", "..", "templates", "claude-settings.json");

function matcher(): string {
  const raw = JSON.parse(readFileSync(SETTINGS, "utf8"));
  const hooks = raw?.hooks?.PreToolUse;
  expect(Array.isArray(hooks), "PreToolUse must be an array").toBe(true);
  expect(hooks.length, "at least one PreToolUse hook must exist").toBeGreaterThan(0);
  return hooks[0].matcher as string;
}

// Write verbs per broker. TradeStation's come from broker_tradestation.py in
// autopilot-experiment, which is the code that actually drives that broker.
const MUST_INTERCEPT = [
  "mcp__snaptrade-trade__equity_force_place",
  "mcp__snaptrade-trade__equity_confirm",
  "mcp__snaptrade-trade__mleg_place",
  "mcp__snaptrade-trade__cancel_order",
  "mcp__tradestation__place_order",
  "mcp__tradestation__cancel_order",
  "mcp__tradestation__replace_order",
];

// Read-only or dry-run: gating these is friction without safety.
const MUST_NOT_INTERCEPT = [
  "mcp__snaptrade-trade__equity_impact",
  "mcp__snaptrade-trade__mleg_impact",
];

describe("risk-gate hook matcher", () => {
  it("parses and points at the gate script", () => {
    const raw = JSON.parse(readFileSync(SETTINGS, "utf8"));
    const hook = raw.hooks.PreToolUse[0];
    expect(hook.command).toContain("pre-tool-use.js");
    expect(typeof hook.matcher).toBe("string");
  });

  it.each(MUST_INTERCEPT)("intercepts %s", (tool) => {
    const re = new RegExp(matcher());
    expect(
      re.test(tool),
      `${tool} writes to a real broker and is not covered by the hook matcher. ` +
        `Add it to templates/claude-settings.json.`,
    ).toBe(true);
  });

  it.each(MUST_NOT_INTERCEPT)("does not gate the dry-run tool %s", (tool) => {
    const re = new RegExp(matcher());
    expect(re.test(tool)).toBe(false);
  });

  it("covers both brokers, not just the one that shipped first", () => {
    const m = matcher();
    expect(m).toContain("snaptrade-trade");
    expect(m).toContain("tradestation");
  });
});

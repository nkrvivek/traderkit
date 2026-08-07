// check_trade no longer takes the operator's word for the denominator.
//
// The 2026-08-07 failure in one line: the caller sent $162,951.25 for a book of
// about $763,553, and the gate refused a roll at "31.5% post-trade single-name
// against a 15% cap". Every part of that sentence is precise and the conclusion
// is wrong. On the real book it reads 6.7% and passes.
//
// So the gate reads the aggregate the profile already points at through
// `vault_link` — a field that had been in the schema, unread, the whole time.

import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { checkTradeHandler } from "../../src/tools/check-trade.js";
import { PERMISSIVE_RULES, type Profile } from "../../src/profiles/schema.js";

const LINK = "wiki/trading/portfolio-master.md";
const NOW = "2026-08-07T17:30:00Z";

function vault(total: string, updated = "2026-08-05"): string {
  const root = mkdtempSync(join(tmpdir(), "tk-ct-"));
  const path = join(root, LINK);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `---\nupdated: ${updated}\n---\n\n| **Total equity ex-transit** | **≈ ${total}** (legs) |\n`,
    "utf8"
  );
  return root;
}

const PERSONAL: Profile = {
  name: "personal",
  broker: "tradestation",
  account_id: "22222222-2222-2222-2222-222222222222",
  tax_entity: "personal",
  caps: {
    max_order_notional: 25000,
    max_single_name_pct: 15,
    forbidden_tools: [],
    forbidden_leg_shapes: ["naked_call"],
  },
  rules: PERMISSIVE_RULES,
  vault_link: LINK,
};

// The NVDA roll as it was actually checked, minus the denominator.
const ROLL = {
  profile: "personal",
  tool: "ts_place_spread",
  ticker: "NVDA",
  direction: "SELL_TO_OPEN" as const,
  qty: 1,
  notional_usd: 22500,
  existing_ticker_exposure_usd: 28800,
  now: NOW,
};

const deps = (vaultRoot: string) => ({
  allProfiles: [PERSONAL],
  snaptradeRead: null,
  vaultRoot,
});

describe("check_trade reads the denominator rather than accepting it", () => {
  it("passes the roll that a partial book wrongly refused", async () => {
    const root = vault("$763,553");

    const out = await checkTradeHandler(
      { ...ROLL, portfolio_total_usd: 162951.25 },
      deps(root)
    );

    // 28,800 + 22,500 = 51,300 on 763,553 = 6.7%, under the 15% cap.
    expect(out.reasons.join(" ")).not.toMatch(/single-name/);
    expect(out.pass).toBe(true);
  });

  it("still refuses a name that is genuinely over the cap", async () => {
    const root = vault("$763,553");

    const out = await checkTradeHandler(
      { ...ROLL, notional_usd: 24000, existing_ticker_exposure_usd: 120000 },
      deps(root)
    );

    expect(out.pass).toBe(false);
    expect(out.reasons.join(" ")).toMatch(/single-name/);
  });

  it("says so when the caller's number disagrees with the aggregate", async () => {
    const root = vault("$763,553");

    const out = await checkTradeHandler(
      { ...ROLL, portfolio_total_usd: 162951.25 },
      deps(root)
    );

    // The diagnostic that would have caught 2026-08-07 while it was happening.
    expect(out.warnings.join(" ")).toMatch(/162,951/);
    expect(out.warnings.join(" ")).toMatch(/763,553/);
  });

  it("stays quiet when the caller's number agrees", async () => {
    const root = vault("$763,553");

    const out = await checkTradeHandler(
      { ...ROLL, portfolio_total_usd: 763553 },
      deps(root)
    );

    expect(out.warnings.join(" ")).not.toMatch(/disagrees/);
  });

  it("refuses outright when the aggregate is too old to use", async () => {
    const root = vault("$763,553", "2026-06-01");

    const out = await checkTradeHandler(
      { ...ROLL, portfolio_total_usd: 763553 },
      deps(root)
    );

    expect(out.pass).toBe(false);
    expect(out.reasons.join(" ")).toMatch(/stale/);
    expect(out.reasons.join(" ")).toMatch(/2026-06-01/);
  });

  it("refuses outright when the aggregate cannot be read", async () => {
    const root = mkdtempSync(join(tmpdir(), "tk-empty-"));

    const out = await checkTradeHandler(
      { ...ROLL, portfolio_total_usd: 763553 },
      deps(root)
    );

    expect(out.pass).toBe(false);
    expect(out.reasons.join(" ")).toMatch(/cannot read the aggregate/);
  });

  it("names the gap when a profile points at no aggregate at all", async () => {
    const root = vault("$763,553");
    const noLink = { ...PERSONAL, vault_link: undefined };

    const out = await checkTradeHandler(
      { ...ROLL, portfolio_total_usd: 162951.25 },
      { allProfiles: [noLink], snaptradeRead: null, vaultRoot: root }
    );

    // Falls back to the caller's number, but never silently.
    expect(out.warnings.join(" ")).toMatch(/cannot verify/i);
  });
});

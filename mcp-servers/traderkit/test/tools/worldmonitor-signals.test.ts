import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { worldmonitorSignalsHandler } from "../../src/tools/worldmonitor-signals.js";

const DOC_REL = "wiki/trading/worldmonitor-signals.md";

function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function makeVault(rows: string[]): string {
  const vault = mkdtempSync(join(tmpdir(), "wm-vault-"));
  mkdirSync(join(vault, "wiki/trading"), { recursive: true });
  const doc = [
    "---",
    "doc: worldmonitor-signals",
    "---",
    "",
    "## Data",
    "",
    "| pulled_at | signal | value | detail | as_of | status |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
  writeFileSync(join(vault, DOC_REL), doc);
  return vault;
}

describe("worldmonitorSignalsHandler", () => {
  it("refuses with a reason when the doc is missing, never degrades to empty", async () => {
    const vault = mkdtempSync(join(tmpdir(), "wm-empty-"));
    const r = await worldmonitorSignalsHandler({ vault_path: vault });
    expect(r.available).toBe(false);
    expect(r.reason).toContain(DOC_REL);
    expect(r.signals).toEqual([]);
  });

  it("reads the last row per signal — the ledger is append-only", async () => {
    const older = isoHoursAgo(2);
    const newer = isoHoursAgo(1);
    const vault = makeVault([
      `| ${older} | eu-gas-storage | 57.87 | pct full, injecting | 2026-08-04 | ok |`,
      `| ${newer} | eu-gas-storage | 58.32 | pct full, injecting | 2026-08-06 | ok |`,
    ]);
    const r = await worldmonitorSignalsHandler({ vault_path: vault });
    expect(r.available).toBe(true);
    expect(r.signals).toHaveLength(1);
    expect(r.signals[0]).toMatchObject({
      signal: "eu-gas-storage",
      value: "58.32",
      as_of: "2026-08-06",
      usable: true,
    });
  });

  it("marks a row past the 6-hour bound stale with the age in the reason", async () => {
    const vault = makeVault([
      `| ${isoHoursAgo(9)} | crude-inventories | 711796 | stocksMb, wow -362 | 2026-07-31 | ok |`,
    ]);
    const r = await worldmonitorSignalsHandler({ vault_path: vault });
    const row = r.signals[0]!;
    expect(row.usable).toBe(false);
    expect(row.reason).toMatch(/stale/);
    expect(row.reason).toContain("6h");
    // the figure still rides along, flagged — never silently dropped
    expect(row.value).toBe("711796");
  });

  it("honors a caller-set max_age_hours", async () => {
    const vault = makeVault([
      `| ${isoHoursAgo(9)} | crude-inventories | 711796 | stocksMb | 2026-07-31 | ok |`,
    ]);
    const r = await worldmonitorSignalsHandler({ vault_path: vault, max_age_hours: 12 });
    expect(r.signals[0]!.usable).toBe(true);
  });

  it("a row whose status is not ok is not a measurement", async () => {
    const vault = makeVault([
      `| ${isoHoursAgo(1)} | trade-barriers | ? | WTO unreachable, upstreamUnavailable | ? | error |`,
    ]);
    const r = await worldmonitorSignalsHandler({ vault_path: vault });
    const row = r.signals[0]!;
    expect(row.usable).toBe(false);
    expect(row.reason).toContain("error");
  });

  it("returns only requested signals, and names the ones with no row", async () => {
    const vault = makeVault([
      `| ${isoHoursAgo(1)} | macro-signals | 2 | bullish of 6 (BTC/QQQ composite); verdict CASH | 2026-08-08T09:00:44Z | ok |`,
      `| ${isoHoursAgo(1)} | eu-gas-storage | 58.32 | pct full | 2026-08-06 | ok |`,
    ]);
    const r = await worldmonitorSignalsHandler({
      vault_path: vault,
      signals: ["macro-signals", "shipping-stress"],
    });
    expect(r.signals.map((s) => s.signal)).toEqual(["macro-signals", "shipping-stress"]);
    expect(r.signals[0]!.usable).toBe(true);
    expect(r.signals[1]!.usable).toBe(false);
    expect(r.signals[1]!.reason).toContain("no row");
  });

  it("summary counts usable over total and the payload says context, not trigger", async () => {
    const vault = makeVault([
      `| ${isoHoursAgo(1)} | macro-signals | 2 | bullish of 6 (BTC/QQQ composite) | 2026-08-08T09:00:44Z | ok |`,
      `| ${isoHoursAgo(9)} | crude-inventories | 711796 | stocksMb | 2026-07-31 | ok |`,
    ]);
    const r = await worldmonitorSignalsHandler({ vault_path: vault });
    expect(r.summary_one_line).toContain("[WORLDMONITOR] 1/2 usable");
    expect(r.note).toMatch(/context, n(ot|ever) a trigger/);
  });
});

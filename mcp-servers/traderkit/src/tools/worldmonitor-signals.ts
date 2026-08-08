/**
 * worldmonitor_signals — read the WorldMonitor ledger the vault already holds.
 *
 * Source of truth: `wiki/trading/worldmonitor-signals.md`, written by
 * trade-refresh's `src.worldmonitor_pull`. This tool NEVER calls
 * worldmonitor.sibt.ai — one puller, one document, many readers, so every
 * figure keeps a single freshness story. A second caller would mint a second
 * one.
 *
 * The ledger is append-only; the last row per signal is the reading. A row is
 * usable only when its status is `ok` AND its pull is inside the freshness
 * bound (6 hours — the doc's own, not R21's; nothing here moves at quote
 * speed). Anything else is returned with `usable: false` and the reason,
 * figure still attached: a stale number gets flagged, never silently dropped,
 * and a missing one is named, never rendered as zero.
 *
 * These are context inputs for regime work. Never a trigger for an order.
 */
import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_VAULT = process.env.OBSIDIAN_VAULT ??
  join(homedir(), "Library/Mobile Documents/iCloud~md~obsidian/Documents/obsidian");
const DOC_REL = "wiki/trading/worldmonitor-signals.md";
const DEFAULT_MAX_AGE_HOURS = 6;
const CONTEXT_NOTE =
  "WorldMonitor readings are context, not a trigger — never quote one in an order decision.";

export const WorldmonitorSignalsArgs = z.object({
  signals: z.array(z.string().min(1)).optional(),
  max_age_hours: z.number().positive().optional(),
  vault_path: z.string().optional(),
});

export interface WorldmonitorSignalRow {
  signal: string;
  value: string;
  detail: string;
  as_of: string;
  pulled_at: string;
  age_hours: number | null;
  usable: boolean;
  reason?: string;
}

const ROW_RE =
  /^\|\s*(\d{4}-\d{2}-\d{2}T[\d:]+Z)\s*\|\s*([a-z0-9-]+)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*(ok|empty|error)\s*\|\s*$/;

function parseLedger(text: string): Map<string, WorldmonitorSignalRow> {
  const last = new Map<string, WorldmonitorSignalRow>();
  for (const line of text.split("\n")) {
    const m = ROW_RE.exec(line);
    if (!m) continue;
    const [, pulledAt, signal, value, detail, asOf, status] = m;
    if (!pulledAt || !signal || !status) continue;
    // later rows overwrite earlier ones — append-only ledger, last row wins
    const row: WorldmonitorSignalRow = {
      signal,
      value: (value ?? "").trim(),
      detail: (detail ?? "").trim(),
      as_of: (asOf ?? "").trim(),
      pulled_at: pulledAt,
      age_hours: null,
      usable: status === "ok",
    };
    if (status !== "ok") row.reason = `last pull reported ${status}`;
    last.set(signal, row);
  }
  return last;
}

function withFreshness(
  row: WorldmonitorSignalRow,
  maxAgeHours: number,
  now: number,
): WorldmonitorSignalRow {
  const pulled = Date.parse(row.pulled_at);
  if (Number.isNaN(pulled)) {
    return { ...row, usable: false, reason: `unreadable pulled_at "${row.pulled_at}"` };
  }
  const ageHours = Math.round(((now - pulled) / 3600_000) * 100) / 100;
  if (!row.usable) return { ...row, age_hours: ageHours };
  if (ageHours > maxAgeHours) {
    return {
      ...row,
      age_hours: ageHours,
      usable: false,
      reason: `stale — pulled ${ageHours}h ago, bound is ${maxAgeHours}h; re-run src.worldmonitor_pull in trade-refresh`,
    };
  }
  return { ...row, age_hours: ageHours };
}

function missingRow(signal: string): WorldmonitorSignalRow {
  return {
    signal,
    value: "?",
    detail: "",
    as_of: "?",
    pulled_at: "?",
    age_hours: null,
    usable: false,
    reason: "no row in the ledger — the puller has never written this signal",
  };
}

export async function worldmonitorSignalsHandler(raw: unknown) {
  const args = WorldmonitorSignalsArgs.parse(raw);
  const vault = args.vault_path ?? DEFAULT_VAULT;
  const maxAge = args.max_age_hours ?? DEFAULT_MAX_AGE_HOURS;
  const docPath = join(vault, DOC_REL);

  if (!existsSync(docPath)) {
    return {
      available: false,
      reason: `ledger not found at ${vault}/${DOC_REL} — trade-refresh's src.worldmonitor_pull writes it`,
      signals: [] as WorldmonitorSignalRow[],
      note: CONTEXT_NOTE,
    };
  }

  const now = Date.now();
  const ledger = parseLedger(readFileSync(docPath, "utf-8"));
  const wanted = args.signals ?? [...ledger.keys()];
  const rows = wanted.map((signal) => {
    const row = ledger.get(signal);
    return row ? withFreshness(row, maxAge, now) : missingRow(signal);
  });

  const usable = rows.filter((r) => r.usable).length;
  const unusable = rows.filter((r) => !r.usable).map((r) => `${r.signal} (${r.reason})`);
  return {
    available: true,
    max_age_hours: maxAge,
    signals: rows,
    summary_one_line:
      `[WORLDMONITOR] ${usable}/${rows.length} usable` +
      (unusable.length ? ` · unusable: ${unusable.join("; ")}` : ""),
    note: CONTEXT_NOTE,
  };
}

/**
 * On-disk byte counter for the shared FMP key.
 *
 * Five processes hold one key and none of them can see the others. A counter
 * that only lives in memory answers `unmeasured` every time the rail asks.
 *
 * So each process writes its own running total to a file nobody else writes to:
 *
 *     ~/.fmp-spend/<YYYY-MM-DD>/<consumer>.<pid>.json
 *
 * One writer per file means no locking and no lost updates, and the rail sums
 * the day's directory without asking anyone to pipe anything. The format is the
 * shared thing here, not this code: `trade-refresh`, `autopilot-experiment` and
 * `ai-hedge-fund` each write the same shape from their own repo. trade-refresh
 * owns the rail that reads it (`src.fmp_quota`).
 *
 * Bytes, not calls. FMP's Starter plan caps a trailing 30 days of bandwidth at
 * 20GB and does not cap calls per day at all.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SCHEMA = 1;
export const CONSUMER = "traderkit";

interface Total {
  schema: number;
  consumer: string;
  day: string;
  pid: number;
  calls: number;
  bytes: number;
  unsized_calls: number;
  limit_hit: boolean;
  updated?: string;
}

// One entry per day in this process. Cumulative, so the file it writes is a
// whole total and never a delta that could be applied twice.
const totals = new Map<string, Total>();
let warned = false;

function spendRoot(): string {
  return process.env.FMP_SPEND_DIR ?? join(homedir(), ".fmp-spend");
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function fresh(day: string): Total {
  return {
    schema: SCHEMA,
    consumer: CONSUMER,
    day,
    pid: process.pid,
    calls: 0,
    bytes: 0,
    unsized_calls: 0,
    limit_hit: false,
  };
}

function flush(total: Total): void {
  // A counter must never break the call it is counting, and must never go
  // quiet about failing either.
  try {
    const dir = join(spendRoot(), total.day);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${CONSUMER}.${process.pid}.json`), JSON.stringify(total));
  } catch (e) {
    if (!warned) {
      warned = true;
      console.error(`[fmp-spend] cannot write the counter (${String(e)}); spend is unmeasured`);
    }
  }
}

/**
 * Add one response to this process's running total.
 *
 * `bytes` is null when the response carried no content-length. That counts as
 * a call with unknown size rather than as zero bytes, and the rail reports the
 * unknown count so the total reads as the floor it is.
 */
export function record(bytes: number | null, limitHit = false): void {
  const day = today();
  const prev = totals.get(day) ?? fresh(day);
  const sized = typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0;
  const next: Total = {
    ...prev,
    calls: prev.calls + 1,
    bytes: prev.bytes + (sized ? bytes : 0),
    unsized_calls: prev.unsized_calls + (sized ? 0 : 1),
    limit_hit: prev.limit_hit || limitHit,
    updated: new Date().toISOString(),
  };
  totals.set(day, next);
  flush(next);
}

/**
 * Write a zero row so a quiet process is measured rather than missing.
 *
 * Without it there is no way to tell a consumer that ran and made no calls from
 * a consumer whose counter was never installed, and a rail that reports a
 * finding on every quiet day teaches the reader to skip it.
 */
export function touch(): void {
  const day = today();
  if (totals.has(day)) return;
  const total = { ...fresh(day), updated: new Date().toISOString() };
  totals.set(day, total);
  flush(total);
}

/** Bytes on the wire for one response, or null when the size cannot be read. */
export function responseBytes(res: Response): number | null {
  const raw = res.headers.get("content-length");
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

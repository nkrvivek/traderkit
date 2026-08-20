/**
 * On-disk request counter for the shared Unusual Whales token.
 *
 * One token, one 80,000-request day, four consumers, and none of them can see
 * the others. traderkit was the only one with no counter anywhere in its
 * source, so `uw-consumers.json` recorded it as `counter: none` and the rail
 * reported it `unmeasured` on every run. On 2026-08-20 the token read 75,197 of
 * 80,000 by midday and roughly 4,600 requests had no owner at all, which is a
 * measurement failure before it is a spending failure.
 *
 * Same shape as `fmp-spend.ts`, one file per process per day:
 *
 *     ~/.uw-spend/<YYYY-MM-DD>/<consumer>.<pid>.json
 *
 * One writer per file means no locking and no lost updates, and trade-refresh's
 * `src.uw_quota` sums the day's directory off disk without anyone piping
 * anything by hand.
 *
 * Requests, not bytes. UW caps requests a day; FMP caps trailing bandwidth.
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
  by_path: Record<string, number>;
  limit_hit: boolean;
  updated?: string;
}

// One entry per day in this process. Cumulative, so the file it writes is a
// whole total and never a delta that could be applied twice.
const totals = new Map<string, Total>();
let warned = false;

function spendRoot(): string {
  return process.env.UW_SPEND_DIR ?? join(homedir(), ".uw-spend");
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Collapse the ticker out of a path.
 *
 * `by_path` is written to disk on every request, so a key per ticker would
 * grow the file without bound and say nothing extra: what matters is which
 * endpoint carried the spend, not which symbol. A segment is a ticker when it
 * is short and upper-case, which is what every UW path uses.
 */
export function normalizePath(path: string): string {
  return path
    .split("/")
    .map((seg) => (/^[A-Z][A-Z.]{0,5}$/.test(seg) ? "{ticker}" : seg))
    .join("/");
}

function fresh(day: string): Total {
  return {
    schema: SCHEMA,
    consumer: CONSUMER,
    day,
    pid: process.pid,
    calls: 0,
    by_path: {},
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
      console.error(`[uw-spend] cannot write the counter (${String(e)}); spend is unmeasured`);
    }
  }
}

/**
 * Add one request to this process's running total.
 *
 * Call this for every request that left the machine, including the ones that
 * came back 429 or 500. A refused request has already been counted by UW, and
 * the retry loop issues a fresh one per attempt, so counting only successes
 * would understate the day in the one direction a shared cap must not be wrong
 * in.
 */
export function record(path: string, limitHit = false): void {
  const day = today();
  const prev = totals.get(day) ?? fresh(day);
  const key = normalizePath(path);
  const next: Total = {
    ...prev,
    calls: prev.calls + 1,
    by_path: { ...prev.by_path, [key]: (prev.by_path[key] ?? 0) + 1 },
    limit_hit: prev.limit_hit || limitHit,
    updated: new Date().toISOString(),
  };
  totals.set(day, next);
  flush(next);
}

/**
 * Write a zero row so a quiet process is measured rather than missing.
 *
 * Without it there is no way to tell a session that held the token and called
 * nothing from one whose counter was never installed. Absent is never zero, so
 * the rail has to be able to see the difference.
 */
export function touch(): void {
  const day = today();
  if (totals.has(day)) return;
  const total = { ...fresh(day), updated: new Date().toISOString() };
  totals.set(day, total);
  flush(total);
}

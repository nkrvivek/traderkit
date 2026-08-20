/**
 * traderkit was the one consumer of the shared UW token with no counter at all.
 *
 * One token, one 80,000-request day, four consumers. On 2026-08-20 the token
 * read 75,197 of 80,000 by midday and roughly 4,600 requests had no owner,
 * because this process holds the token and nothing here could say what it had
 * spent. `uw-consumers.json` recorded that as `counter: none`, which meant the
 * rail reported `unmeasured` every single run and the gap could only ever be
 * inferred by subtraction.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;

async function freshModule() {
  // Each case needs its own in-memory total, so the module cache is dropped.
  vi.resetModules();
  return await import("../../src/clients/uw-spend.js");
}

function readRows(day: string): Array<Record<string, unknown>> {
  return readdirSync(join(dir, day)).map(
    (f) => JSON.parse(readFileSync(join(dir, day, f), "utf8")) as Record<string, unknown>,
  );
}

const today = () => new Date().toISOString().slice(0, 10);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "uw-spend-test-"));
  process.env.UW_SPEND_DIR = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("uw-spend", () => {
  it("counts requests, because UW caps requests a day and not bytes", async () => {
    const s = await freshModule();
    s.record("/darkpool/recent", 200);
    s.record("/darkpool/recent", 200);
    const [row] = readRows(today());
    expect(row.calls).toBe(2);
    expect(row.consumer).toBe("traderkit");
    expect(row.by_path).toEqual({ "/darkpool/recent": 2 });
  });

  it("collapses the ticker out of a path so by_path stays bounded", async () => {
    const s = await freshModule();
    s.record("/stock/AAPL/flow-alerts", 200);
    s.record("/stock/NVDA/flow-alerts", 200);
    s.record("/shorts/TSLA/data", 200);
    const [row] = readRows(today());
    expect(row.by_path).toEqual({
      "/stock/{ticker}/flow-alerts": 2,
      "/shorts/{ticker}/data": 1,
    });
    expect(row.calls).toBe(3);
  });

  it("does not charge a 429 to the ration, because UW does not", async () => {
    // UW's own cap message: "Only requests with a 200 status code count toward
    // your limit. 4XX and 5XX responses do not." Counting a refusal as spend
    // walks this counter past 80,000 on exactly the day it is read hardest.
    const s = await freshModule();
    s.record("/darkpool/recent", 429);
    const [row] = readRows(today());
    expect(row.calls).toBe(0);
    expect(row.refused).toBe(1);
    expect(row.limit_hit).toBe(true);
  });

  it("records a 500 as an attempt without charging it", async () => {
    // A retry storm is a finding in its own right, so a refusal is never
    // dropped. It just is not spend.
    const s = await freshModule();
    s.record("/darkpool/recent", 500);
    const [row] = readRows(today());
    expect(row.calls).toBe(0);
    expect(row.refused).toBe(1);
    expect(row.limit_hit).toBe(false);
  });

  it("charges the whole 2xx band, because over-counting is the safe direction", async () => {
    // UW names 200. Anything else in the 2xx band is a served response we
    // cannot prove was free, and understating a shared cap is the one
    // direction this must never be wrong in.
    const s = await freshModule();
    s.record("/darkpool/recent", 204);
    const [row] = readRows(today());
    expect(row.calls).toBe(1);
    expect(row.refused).toBe(0);
  });

  it("keeps a refusal out of by_path, which is the map of what spent the day", async () => {
    const s = await freshModule();
    s.record("/darkpool/recent", 200);
    s.record("/darkpool/recent", 429);
    const [row] = readRows(today());
    expect(row.by_path).toEqual({ "/darkpool/recent": 1 });
    expect(row.refused).toBe(1);
  });

  it("writes a zero row on touch, so a quiet process is measured not missing", async () => {
    const s = await freshModule();
    s.touch();
    const [row] = readRows(today());
    expect(row.calls).toBe(0);
    expect(row.refused).toBe(0);
    expect(row.limit_hit).toBe(false);
  });

  it("keeps one file per process, so two writers never lose an update", async () => {
    const s = await freshModule();
    s.record("/darkpool/recent", 200);
    const files = readdirSync(join(dir, today()));
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(`traderkit.${process.pid}.json`);
  });

  it("writes a whole total and never a delta", async () => {
    const s = await freshModule();
    s.record("/darkpool/recent", 200);
    s.record("/institutions", 200);
    const [row] = readRows(today());
    // Cumulative: applying the file twice must not be able to double a day.
    expect(row.calls).toBe(2);
  });

  it("never throws out of record, because a counter must not break the call", async () => {
    const s = await freshModule();
    process.env.UW_SPEND_DIR = "/proc/nonexistent-and-unwritable";
    expect(() => s.record("/darkpool/recent")).not.toThrow();
    process.env.UW_SPEND_DIR = dir;
  });
});

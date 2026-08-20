import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The counter keeps a per-day total in module state, so each case needs a fresh
// module as well as a fresh directory.
async function freshModule() {
  vi.resetModules();
  return await import("../../src/clients/fmp-spend.js");
}

let root: string;
let prior: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fmp-spend-"));
  prior = process.env.FMP_SPEND_DIR;
  process.env.FMP_SPEND_DIR = root;
});

afterEach(() => {
  if (prior === undefined) delete process.env.FMP_SPEND_DIR;
  else process.env.FMP_SPEND_DIR = prior;
  rmSync(root, { recursive: true, force: true });
});

function onlyRow(): Record<string, unknown> {
  const days = readdirSync(root);
  expect(days).toHaveLength(1);
  const dir = join(root, days[0]!);
  const files = readdirSync(dir);
  expect(files).toHaveLength(1);
  return JSON.parse(readFileSync(join(dir, files[0]!), "utf8"));
}

describe("fmp-spend", () => {
  it("sums bytes across calls so the rail reads one total per process", async () => {
    const spend = await freshModule();
    spend.record(1000);
    spend.record(2500);
    const row = onlyRow();
    expect(row.calls).toBe(2);
    expect(row.bytes).toBe(3500);
    expect(row.unsized_calls).toBe(0);
    expect(row.consumer).toBe("traderkit");
  });

  it("counts a response of unknown size as a call, never as zero bytes", async () => {
    const spend = await freshModule();
    spend.record(null);
    const row = onlyRow();
    expect(row.calls).toBe(1);
    expect(row.bytes).toBe(0);
    // The point of the field: the total is a floor, and the reader can see it.
    expect(row.unsized_calls).toBe(1);
  });

  it("writes a zero row on touch so a quiet process is measured, not missing", async () => {
    const spend = await freshModule();
    spend.touch();
    const row = onlyRow();
    expect(row.calls).toBe(0);
    expect(row.bytes).toBe(0);
  });

  it("does not overwrite a running total when touch is called after a call", async () => {
    const spend = await freshModule();
    spend.record(4096);
    spend.touch();
    expect(onlyRow().bytes).toBe(4096);
  });

  it("remembers a 429 for the day", async () => {
    const spend = await freshModule();
    spend.record(200, true);
    spend.record(900);
    expect(onlyRow().limit_hit).toBe(true);
  });

  it("reads content-length and refuses a header it cannot parse", async () => {
    const spend = await freshModule();
    const sized = new Response("x", { headers: { "content-length": "812" } });
    expect(spend.responseBytes(sized)).toBe(812);
    const junk = new Response("x", { headers: { "content-length": "not-a-number" } });
    expect(spend.responseBytes(junk)).toBeNull();
  });
});

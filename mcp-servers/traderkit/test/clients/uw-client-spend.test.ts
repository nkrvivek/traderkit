/**
 * Every request uw-client puts on the wire reaches the counter.
 *
 * The counter existing is not the same as the client using it. `uwGet` retries
 * a 429 up to three times and each attempt is a request UW has already charged
 * for, so counting only the successful return would understate a rate-limited
 * afternoon by exactly the requests that caused it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
const day = () => new Date().toISOString().slice(0, 10);

function row(): Record<string, unknown> | null {
  const d = join(dir, day());
  if (!existsSync(d)) return null;
  const files = readdirSync(d);
  if (files.length === 0) return null;
  return JSON.parse(readFileSync(join(d, files[0]!), "utf8")) as Record<string, unknown>;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "uw-client-spend-"));
  process.env.UW_SPEND_DIR = dir;
  process.env.UW_TOKEN = "test-token";
  vi.resetModules();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe("uw-client spend accounting", () => {
  it("records a request that succeeded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })),
    );
    const c = await import("../../src/clients/uw-client.js");
    await c.uwDarkpoolRecentRaw(10);
    expect(row()?.calls).toBe(1);
  });

  it("records every attempt of a retried 429 without charging any of them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("rate limited", { status: 429 })),
    );
    const c = await import("../../src/clients/uw-client.js");
    await c.uwDarkpoolRecentRaw(10);
    const r = row();
    // uwGet attempts three times. UW charged for none of them, and a counter
    // that charged all three would climb fastest once the ration was already
    // gone, which is when it is read hardest.
    expect(r?.calls).toBe(0);
    expect(r?.refused).toBe(3);
    expect(r?.limit_hit).toBe(true);
  });

  it("writes a zero row on import, so a session that called nothing is measured", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await import("../../src/clients/uw-client.js");
    expect(row()?.calls).toBe(0);
  });
});

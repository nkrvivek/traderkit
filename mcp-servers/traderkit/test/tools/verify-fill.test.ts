import { describe, expect, it } from "vitest";
import { verifyFillHandler } from "../../src/tools/verify-fill.js";

const leg = (over: Record<string, unknown> = {}) => ({
  leg_id: "L1",
  intended_qty: 5,
  filled_qty: 5,
  ...over,
});

describe("verifyFillHandler", () => {
  it("all legs filled → executed, safe to mark", async () => {
    const r = await verifyFillHandler({
      source: "tradestation",
      legs: [leg(), leg({ leg_id: "L2" })],
    });
    expect(r.overall_status).toBe("executed");
    expect(r.safe_to_mark_executed).toBe(true);
    expect(r.coerced_status_label).toBe("executed");
    expect(r.total_intended).toBe(10);
    expect(r.total_filled).toBe(10);
    expect(r.legs[0]!.fill_pct).toBe(100);
  });

  it("partial leg → partial-fill w/ leg warning, NOT safe to mark", async () => {
    const r = await verifyFillHandler({
      source: "manual",
      legs: [leg(), leg({ leg_id: "L2", filled_qty: 2 })],
    });
    expect(r.overall_status).toBe("partial-fill");
    expect(r.safe_to_mark_executed).toBe(false);
    expect(r.coerced_status_label).toBe("partial-fill (7/10)");
    expect(r.warnings.some((w) => w.includes("L2 2/5"))).toBe(true);
    expect(r.legs[1]!.status).toBe("PARTIAL");
    expect(r.legs[1]!.fill_pct).toBe(40);
  });

  it("zero-filled leg w/o status → submitted-unverified", async () => {
    const r = await verifyFillHandler({
      source: "manual",
      legs: [leg({ filled_qty: 0 })],
    });
    expect(r.overall_status).toBe("submitted-unverified");
    expect(r.coerced_status_label).toBe("submitted-unverified");
    expect(r.legs[0]!.status).toBe("SUBMITTED");
    expect(r.safe_to_mark_executed).toBe(false);
  });

  it("cancelled/rejected zero-fills → failed", async () => {
    const r = await verifyFillHandler({
      source: "snaptrade-list-orders",
      legs: [
        leg({ filled_qty: 0, status: "CANCELLED" }),
        leg({ leg_id: "L2", filled_qty: 0, status: "REJECTED" }),
      ],
    });
    expect(r.overall_status).toBe("failed");
    expect(r.coerced_status_label).toBe("failed");
    expect(r.safe_to_mark_executed).toBe(false);
  });

  it("explicit status wins over qty inference", async () => {
    // filled_qty == intended_qty but broker says PARTIAL → not executed
    const r = await verifyFillHandler({
      source: "manual",
      legs: [leg({ status: "PARTIAL" })],
    });
    expect(r.overall_status).toBe("partial-fill");
  });

  it("ib-gateway source always carries the R5 flex cross-check warning", async () => {
    const r = await verifyFillHandler({ source: "ib-gateway", legs: [leg()] });
    expect(r.warnings.some((w) => w.includes("ib-flex"))).toBe(true);
  });

  it("threads source_ref + verified_at through; defaults verified_at when absent", async () => {
    const r = await verifyFillHandler({
      source: "ib-flex",
      source_ref: "flex-1448871",
      verified_at: "2026-07-01T21:00:00Z",
      legs: [leg()],
    });
    expect(r.source_ref).toBe("flex-1448871");
    expect(r.verified_at).toBe("2026-07-01T21:00:00Z");
    const r2 = await verifyFillHandler({ source: "ib-flex", legs: [leg()] });
    expect(r2.source_ref).toBeUndefined();
    expect(typeof r2.verified_at).toBe("string");
    expect(r2.verified_at.length).toBeGreaterThan(0);
  });

  it("rejects empty legs / negative fills via schema", async () => {
    await expect(verifyFillHandler({ source: "manual", legs: [] })).rejects.toThrow();
    await expect(
      verifyFillHandler({ source: "manual", legs: [leg({ filled_qty: -1 })] }),
    ).rejects.toThrow();
  });
});

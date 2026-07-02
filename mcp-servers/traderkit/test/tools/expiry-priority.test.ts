import { describe, expect, it } from "vitest";
import { expiryPriorityHandler } from "../../src/tools/expiry-priority.js";

const leg = (over: Record<string, unknown> = {}) => ({
  leg_id: "E1",
  ticker: "NVDA",
  option_type: "CALL" as const,
  strike: 100,
  side: "SHORT" as const,
  expiry_date: "2026-07-17",
  underlying_price: 110,
  ...over,
});

describe("expiryPriorityHandler", () => {
  it("orders ITM before ATM before OTM before NEW_CYCLE", async () => {
    const r = await expiryPriorityHandler({
      expiring_legs: [
        leg({ leg_id: "otm", underlying_price: 90 }),
        leg({ leg_id: "atm", underlying_price: 100.1 }),
        leg({ leg_id: "itm", underlying_price: 120 }),
      ],
      new_cycle_legs: [{ leg_id: "n1", ticker: "AAPL", intent: "STO Jul 230C" }],
    });
    expect(r.ordered.map((o) => o.leg_id)).toEqual(["itm", "atm", "otm", "n1"]);
    expect(r.ordered.map((o) => o.phase)).toEqual([
      "EXPIRING_ITM", "EXPIRING_ATM", "EXPIRING_OTM", "NEW_CYCLE",
    ]);
    expect(r.ordered[0]!.step).toBe(1);
    expect(r.summary).toEqual({ itm: 1, atm: 1, otm: 1, new_cycle: 1 });
  });

  it("ATM pin band is max(0.25, 1% of strike)", async () => {
    // strike 100 → band $1; underlying 100.9 is ATM, 101.5 is ITM (short call)
    const atm = await expiryPriorityHandler({ expiring_legs: [leg({ underlying_price: 100.9 })] });
    expect(atm.summary.atm).toBe(1);
    const itm = await expiryPriorityHandler({ expiring_legs: [leg({ underlying_price: 101.5 })] });
    expect(itm.summary.itm).toBe(1);
    // low-priced strike 10 → band floors at $0.25
    const low = await expiryPriorityHandler({
      expiring_legs: [leg({ strike: 10, underlying_price: 10.2 })],
    });
    expect(low.summary.atm).toBe(1);
  });

  it("puts: underlying below strike = ITM, above = OTM", async () => {
    const r = await expiryPriorityHandler({
      expiring_legs: [
        leg({ leg_id: "p-itm", option_type: "PUT", strike: 100, underlying_price: 90 }),
        leg({ leg_id: "p-otm", option_type: "PUT", strike: 100, underlying_price: 115 }),
      ],
    });
    expect(r.summary).toEqual({ itm: 1, atm: 0, otm: 1, new_cycle: 0 });
  });

  it("R8 violations fire when ITM/ATM legs coexist with new-cycle writes", async () => {
    const r = await expiryPriorityHandler({
      expiring_legs: [
        leg({ leg_id: "itm", underlying_price: 130 }),
        leg({ leg_id: "atm", underlying_price: 100 }),
      ],
      new_cycle_legs: [{ leg_id: "n1", ticker: "MO", intent: "STO CSP" }],
    });
    expect(r.violations).toHaveLength(2);
    expect(r.violations[0]).toContain("ITM");
    expect(r.violations[1]).toContain("pin-risk");
  });

  it("no violations without new-cycle legs; empty input is valid", async () => {
    const withItm = await expiryPriorityHandler({
      expiring_legs: [leg({ underlying_price: 130 })],
    });
    expect(withItm.violations).toEqual([]);
    const empty = await expiryPriorityHandler({});
    expect(empty.ordered).toEqual([]);
    expect(empty.summary.new_cycle).toBe(0);
  });
});

// The gate reads the portfolio total itself.
//
// 2026-08-07: a roll was refused at 31.5% post-trade single-name against a 15%
// cap. The cap was right; the denominator was not. The caller had summed five
// brokers — $162,951.25 — and the book is about $763,553. The gate divided by
// what it was handed, found 31.5%, and wrote a hash-chained refusal that is
// indistinguishable from a real one. Nothing in a bare number says which
// brokers went into it, so nothing could catch that.
//
// The repair: no caller supplies the denominator. The gate reads the aggregate
// the profile already points at, and refuses when that file cannot be read,
// cannot be parsed, or is older than the bound.

import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readPortfolioTotal,
  PortfolioTotalError,
} from "../../src/gates/portfolio-total.js";

const NOW = new Date("2026-08-07T17:30:00Z");

function vaultWith(body: string, rel = "wiki/trading/portfolio-master.md"): string {
  const root = mkdtempSync(join(tmpdir(), "tk-vault-"));
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
  return root;
}

const MASTER = `---
title: Portfolio Master — Cross-Broker Aggregate
updated: 2026-08-05
---

| Metric | Personal |
|---|---:|
| **Total equity ex-transit** | **≈ $763,553** (Ally $470,552.41 · IBKR $107,131.89) |
`;

describe("readPortfolioTotal", () => {
  it("reads the total and its stamp out of the aggregate doc", () => {
    const root = vaultWith(MASTER);

    const total = readPortfolioTotal(root, "wiki/trading/portfolio-master.md", {
      now: NOW,
      maxAgeDays: 4,
    });

    expect(total.usd).toBe(763553);
    expect(total.asOf).toBe("2026-08-05");
    expect(total.source).toContain("portfolio-master.md");
  });

  it("reads a total written with decimals", () => {
    const root = vaultWith(MASTER.replace("$763,553", "$763,552.57"));

    const total = readPortfolioTotal(root, "wiki/trading/portfolio-master.md", {
      now: NOW,
      maxAgeDays: 4,
    });

    expect(total.usd).toBeCloseTo(763552.57, 2);
  });

  it("refuses when the file is not there", () => {
    const root = vaultWith(MASTER);

    expect(() =>
      readPortfolioTotal(root, "wiki/trading/nope.md", { now: NOW, maxAgeDays: 4 })
    ).toThrow(PortfolioTotalError);
  });

  it("refuses when the doc carries no total", () => {
    const root = vaultWith(`---\nupdated: 2026-08-05\n---\n\nno figure here\n`);

    expect(() =>
      readPortfolioTotal(root, "wiki/trading/portfolio-master.md", {
        now: NOW,
        maxAgeDays: 4,
      })
    ).toThrow(/no total/i);
  });

  it("refuses when the doc carries no updated stamp", () => {
    const root = vaultWith(MASTER.replace("updated: 2026-08-05\n", ""));

    expect(() =>
      readPortfolioTotal(root, "wiki/trading/portfolio-master.md", {
        now: NOW,
        maxAgeDays: 4,
      })
    ).toThrow(/stamp/i);
  });

  it("refuses a stale aggregate and names its age", () => {
    const root = vaultWith(MASTER);

    // updated 2026-08-05, now 2026-08-07 -> 2 days, bound 1
    expect(() =>
      readPortfolioTotal(root, "wiki/trading/portfolio-master.md", {
        now: NOW,
        maxAgeDays: 1,
      })
    ).toThrow(/2 days/);
  });

  it("takes the total, not an earlier leg that happens to say NAV", () => {
    // The real portfolio-master says "IBKR (radon OAuth sync, NAV $107,131.89)"
    // six lines above the total. Reading that gives $107,131.89 for a $763,553
    // book — a denominator seven times too small, which is this module's whole
    // subject. Caught against the live doc, not the fixtures.
    const root = vaultWith(
      `---\nupdated: 2026-08-05\n---\n\n` +
        `Live this session: IBKR (radon OAuth sync, NAV $107,131.89) · TS $25,182.66\n\n` +
        `| **Total equity ex-transit** | **≈ $763,553** (Ally $470,552.41) |\n`
    );

    const total = readPortfolioTotal(root, "wiki/trading/portfolio-master.md", {
      now: NOW,
      maxAgeDays: 4,
    });

    expect(total.usd).toBe(763553);
  });

  it("ignores the word NAV in prose when no total is labelled", () => {
    const root = vaultWith(
      `---\nupdated: 2026-08-05\n---\n\nNot pulled: EquityZen, not in liquid NAV $4,266.77.\n`
    );

    expect(() =>
      readPortfolioTotal(root, "wiki/trading/portfolio-master.md", {
        now: NOW,
        maxAgeDays: 4,
      })
    ).toThrow(/no total/i);
  });

  it("reads a book that states a NAV rather than a total equity line", () => {
    // bildof/index.md writes `**NAV**: **$32,793.59**` — same claim, other word.
    const root = vaultWith(
      `---\nupdated: 2026-08-05\n---\n\n**NAV**: **$32,793.59** · **Settled Cash**: **$15,702.25**\n`
    );

    const total = readPortfolioTotal(root, "wiki/trading/portfolio-master.md", {
      now: NOW,
      maxAgeDays: 4,
    });

    expect(total.usd).toBeCloseTo(32793.59, 2);
  });

  it("refuses a total of zero rather than reading it as absent", () => {
    // A zero total silently disables the concentration check downstream, which
    // is the failure mode this whole module exists to close.
    const root = vaultWith(MASTER.replace("≈ $763,553", "$0"));

    expect(() =>
      readPortfolioTotal(root, "wiki/trading/portfolio-master.md", {
        now: NOW,
        maxAgeDays: 4,
      })
    ).toThrow(/no total/i);
  });
});

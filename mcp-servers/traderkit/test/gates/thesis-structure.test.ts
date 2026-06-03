import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkThesisStructure, parseThesisStructureLadder } from "../../src/gates/thesis-structure.js";
import { type Profile, DEFAULT_RULES, PERMISSIVE_RULES } from "../../src/profiles/schema.js";

const BASE: Profile = {
  name: "p", broker: "snaptrade",
  account_id: "11111111-1111-1111-1111-111111111111",
  tax_entity: "personal",
  caps: { max_order_notional: 5000, max_single_name_pct: 10, forbidden_tools: [], forbidden_leg_shapes: [] },
  rules: DEFAULT_RULES,
};

const FN_THESIS = `---
title: "FN — AI Optical Interconnect"
status: active
---

# FN

**Preferred:** CSP at meaningfully OTM strike → harvest premium.

**Alternative ladder (in priority order):**
1. CSP 30-45 DTE OTM Δ ~0.20-0.25 — entry-discounted, premium harvest
2. PCS (put credit spread) — if IV rich enough to make spread economical
3. Equity add small w/ immediate CC overlay — only if spot pulls back >10%
4. Long stock (no overlay) — REJECTED for now (CAUTION-flavored sizing despite bull regime)

## Entry plan
- foo
`;

const FRONTMATTER_THESIS = `---
title: "T1"
structure:
  preferred:
    - csp
    - pcs
  rejected:
    - long_stock
    - long_call
---
# T1
body
`;

function sha(md: string): string {
  return createHash("sha256").update(md, "utf-8").digest("hex");
}

function makeThesisFile(content: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "thesis-test-"));
  const path = join(dir, "fn.md");
  writeFileSync(path, content, "utf-8");
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("parseThesisStructureLadder", () => {
  it("parses body-form Preferred + Alternative ladder + REJECTED", () => {
    const r = parseThesisStructureLadder(FN_THESIS);
    expect(r.preferred.length).toBeGreaterThanOrEqual(3);
    expect(r.preferred.some((p) => /CSP/i.test(p))).toBe(true);
    expect(r.preferred.some((p) => /PCS/i.test(p))).toBe(true);
    expect(r.rejected.length).toBe(1);
    expect(r.rejected[0]).toMatch(/Long stock/);
  });

  it("parses frontmatter structure: block", () => {
    const r = parseThesisStructureLadder(FRONTMATTER_THESIS);
    expect(r.preferred).toEqual(["csp", "pcs"]);
    expect(r.rejected).toEqual(["long_stock", "long_call"]);
  });
});

describe("checkThesisStructure R17", () => {
  it("rejects stock_buy when thesis says Long stock REJECTED (FN today's bug)", () => {
    const f = makeThesisFile(FN_THESIS);
    try {
      const r = checkThesisStructure({
        profile: BASE,
        ticker: "FN",
        proposed_structure: "stock_buy",
        thesis_md_path: f.path,
        thesis_md_sha256: sha(FN_THESIS),
      });
      expect(r.pass).toBe(false);
      expect(r.reasons[0]).toMatch(/REJECTED/i);
    } finally {
      f.cleanup();
    }
  });

  it("accepts csp when thesis Preferred is CSP", () => {
    const f = makeThesisFile(FN_THESIS);
    try {
      const r = checkThesisStructure({
        profile: BASE,
        ticker: "FN",
        proposed_structure: "csp",
        thesis_md_path: f.path,
        thesis_md_sha256: sha(FN_THESIS),
      });
      expect(r.pass).toBe(true);
    } finally {
      f.cleanup();
    }
  });

  it("rejects on sha mismatch (file changed since read)", () => {
    const f = makeThesisFile(FN_THESIS);
    try {
      const r = checkThesisStructure({
        profile: BASE,
        ticker: "FN",
        proposed_structure: "csp",
        thesis_md_path: f.path,
        thesis_md_sha256: sha("different content"),
      });
      expect(r.pass).toBe(false);
      expect(r.reasons[0]).toMatch(/sha256 mismatch/i);
    } finally {
      f.cleanup();
    }
  });

  it("rejects when thesis_md_path missing", () => {
    const r = checkThesisStructure({
      profile: BASE,
      ticker: "FN",
      proposed_structure: "csp",
      thesis_md_sha256: "a".repeat(64),
    });
    expect(r.pass).toBe(false);
    expect(r.reasons[0]).toMatch(/thesis_md_path required/);
  });

  it("rejects when sha format invalid", () => {
    const f = makeThesisFile(FN_THESIS);
    try {
      const r = checkThesisStructure({
        profile: BASE,
        ticker: "FN",
        proposed_structure: "csp",
        thesis_md_path: f.path,
        thesis_md_sha256: "tooshort",
      });
      expect(r.pass).toBe(false);
      expect(r.reasons[0]).toMatch(/sha256 required/);
    } finally {
      f.cleanup();
    }
  });

  it("rejects when proposed_structure missing", () => {
    const r = checkThesisStructure({
      profile: BASE,
      ticker: "FN",
      thesis_md_path: "/any",
      thesis_md_sha256: "a".repeat(64),
    });
    expect(r.pass).toBe(false);
    expect(r.reasons[0]).toMatch(/proposed_structure required/);
  });

  it("frontmatter rejected list blocks long_stock", () => {
    const f = makeThesisFile(FRONTMATTER_THESIS);
    try {
      const r = checkThesisStructure({
        profile: BASE,
        ticker: "FN",
        proposed_structure: "stock_buy",
        thesis_md_path: f.path,
        thesis_md_sha256: sha(FRONTMATTER_THESIS),
      });
      expect(r.pass).toBe(false);
      expect(r.reasons[0]).toMatch(/REJECTED/i);
    } finally {
      f.cleanup();
    }
  });

  it("frontmatter preferred list permits csp", () => {
    const f = makeThesisFile(FRONTMATTER_THESIS);
    try {
      const r = checkThesisStructure({
        profile: BASE,
        ticker: "FN",
        proposed_structure: "csp",
        thesis_md_path: f.path,
        thesis_md_sha256: sha(FRONTMATTER_THESIS),
      });
      expect(r.pass).toBe(true);
    } finally {
      f.cleanup();
    }
  });

  it("warns (not fails) when thesis has no structure ladder", () => {
    const empty = `---\ntitle: T\n---\n# T\nno ladder here\n`;
    const f = makeThesisFile(empty);
    try {
      const r = checkThesisStructure({
        profile: BASE,
        ticker: "FN",
        proposed_structure: "csp",
        thesis_md_path: f.path,
        thesis_md_sha256: sha(empty),
      });
      expect(r.pass).toBe(true);
      expect(r.warnings[0]).toMatch(/no structure ladder/i);
    } finally {
      f.cleanup();
    }
  });

  it("discretionary_event bypasses (close on invalidation, etc.)", () => {
    const r = checkThesisStructure({
      profile: BASE,
      ticker: "FN",
      proposed_structure: "stock_buy",
      discretionary_event: true,
    });
    expect(r.pass).toBe(true);
  });

  it("skips when R17 toggle off (permissive mode)", () => {
    const p = { ...BASE, rules: PERMISSIVE_RULES };
    const r = checkThesisStructure({ profile: p, ticker: "FN" });
    expect(r.pass).toBe(true);
  });
});

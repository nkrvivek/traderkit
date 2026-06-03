import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { type Profile, DEFAULT_RULES } from "../profiles/schema.js";
import type { GateResult } from "./caps.js";

export interface ThesisStructureInput {
  profile: Profile;
  ticker: string;
  proposed_structure?: string | undefined;
  thesis_md_path?: string | undefined;
  thesis_md_sha256?: string | undefined;
  discretionary_event?: boolean | undefined;
}

interface ParsedStructureLadder {
  preferred: string[];
  rejected: string[];
  raw_lines: string[];
}

const STRUCTURE_ALIASES: Record<string, string[]> = {
  stock_buy: ["long stock", "stock", "shares", "equity", "buy stock"],
  csp: ["cash-secured put", "cash secured put", "csp", "short put cash"],
  short_put_naked: ["naked put", "short put naked", "short put"],
  pcs: ["pcs", "put credit spread", "bull put spread"],
  ccs: ["ccs", "call credit spread", "bear call spread"],
  covered_call: ["covered call", "cc", "stock + cc", "equity add small w/ immediate cc overlay", "stock+cc"],
  long_call: ["long call", "long_call", "buy call"],
  long_put: ["long put", "buy put"],
  debit_spread: ["debit spread", "bull call spread", "bear put spread"],
  iron_condor: ["iron condor", "ic"],
  calendar: ["calendar", "calendar spread"],
  diagonal: ["diagonal", "diagonal spread"],
  roll_cc: ["roll cc", "roll covered call"],
  roll_sp: ["roll sp", "roll short put"],
  btc_close: ["btc close", "btc", "buy to close", "close position"],
};

function normalizeStructureName(input: string): string {
  return input.toLowerCase().trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function matchesCanonical(canonical: string, line: string): boolean {
  const normalized = normalizeStructureName(line);
  const aliases = STRUCTURE_ALIASES[canonical] ?? [canonical.replace(/_/g, " ")];
  return aliases.some((alias) => normalized.includes(normalizeStructureName(alias)));
}

function canonicalToHuman(canonical: string): string {
  const aliases = STRUCTURE_ALIASES[canonical];
  return aliases?.[0] ?? canonical.replace(/_/g, " ");
}

export function parseThesisStructureLadder(md: string): ParsedStructureLadder {
  const preferred: string[] = [];
  const rejected: string[] = [];
  const raw_lines: string[] = [];

  // Strategy 1: structured frontmatter `structure:` block
  const fmMatch = md.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const fm = fmMatch[1] ?? "";
    const structureBlock = fm.match(/^structure:\s*\n((?:\s{2,}.*\n?)+)/m);
    if (structureBlock) {
      const block = structureBlock[1] ?? "";
      const prefMatch = block.match(/preferred:\s*\n((?:\s+-\s+.*\n?)+)/);
      const rejMatch = block.match(/rejected:\s*\n((?:\s+-\s+.*\n?)+)/);
      if (prefMatch) {
        const items = (prefMatch[1] ?? "").split("\n")
          .map((l) => l.replace(/^\s+-\s+/, "").trim())
          .filter((l) => l.length > 0);
        preferred.push(...items);
        raw_lines.push(...items.map((i) => `[FM:preferred] ${i}`));
      }
      if (rejMatch) {
        const items = (rejMatch[1] ?? "").split("\n")
          .map((l) => l.replace(/^\s+-\s+/, "").trim())
          .filter((l) => l.length > 0);
        rejected.push(...items);
        raw_lines.push(...items.map((i) => `[FM:rejected] ${i}`));
      }
    }
  }

  // Strategy 2: body parsing — "**Preferred:**" + "**Alternative ladder...**" + "REJECTED" markers
  const lines = md.split("\n");
  let inLadder = false;
  for (const line of lines) {
    const t = line.trim();
    if (/^\*\*Preferred:\*\*/i.test(t) || /^Preferred:/i.test(t)) {
      const rest = t.replace(/^\*\*Preferred:\*\*\s*/i, "").replace(/^Preferred:\s*/i, "");
      if (rest.length > 0) {
        preferred.push(rest);
        raw_lines.push(`[BODY:Preferred] ${rest}`);
      }
      continue;
    }
    if (/^\*\*Alternative ladder/i.test(t) || /^Alternative ladder/i.test(t) || /priority order\)/i.test(t)) {
      inLadder = true;
      continue;
    }
    if (inLadder) {
      // Numbered list item OR blank → exit ladder
      const m = t.match(/^\d+\.\s+(.+)$/);
      if (m) {
        const item = m[1] ?? "";
        if (/REJECTED/i.test(item)) {
          rejected.push(item);
          raw_lines.push(`[BODY:LADDER:REJECTED] ${item}`);
        } else {
          preferred.push(item);
          raw_lines.push(`[BODY:LADDER:preferred] ${item}`);
        }
      } else if (t.length === 0 || t.startsWith("##") || t.startsWith("**")) {
        inLadder = false;
      }
    }
  }

  return { preferred, rejected, raw_lines };
}

export function checkThesisStructure(input: ThesisStructureInput): GateResult {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const rules = input.profile.rules ?? DEFAULT_RULES;

  if (!rules.R17_thesis_structure_match) return { pass: true, reasons, warnings };

  // Discretionary events (close on invalidation, exit-on-stop) bypass — but rationale already gated by R7
  if (input.discretionary_event) return { pass: true, reasons, warnings };

  if (!input.proposed_structure) {
    reasons.push("R17: proposed_structure required (e.g., csp, stock_buy, covered_call)");
    return { pass: false, reasons, warnings };
  }

  if (!input.thesis_md_path) {
    reasons.push("R17: thesis_md_path required — full path to thesis md file in vault");
    return { pass: false, reasons, warnings };
  }

  if (!input.thesis_md_sha256 || !/^[0-9a-f]{64}$/i.test(input.thesis_md_sha256)) {
    reasons.push("R17: thesis_md_sha256 required (64 hex chars) — proves caller read the file this session");
    return { pass: false, reasons, warnings };
  }

  // Read file + verify sha
  let md: string;
  try {
    md = readFileSync(input.thesis_md_path, "utf-8");
  } catch (e) {
    reasons.push(`R17: cannot read thesis file ${input.thesis_md_path}: ${(e as Error).message}`);
    return { pass: false, reasons, warnings };
  }

  const actualSha = createHash("sha256").update(md, "utf-8").digest("hex");
  if (actualSha.toLowerCase() !== input.thesis_md_sha256.toLowerCase()) {
    reasons.push(
      `R17: thesis_md_sha256 mismatch — caller=${input.thesis_md_sha256.slice(0, 12)}... ` +
      `actual=${actualSha.slice(0, 12)}... — re-read thesis before proposing`
    );
    return { pass: false, reasons, warnings };
  }

  // Parse structure ladder
  const ladder = parseThesisStructureLadder(md);

  if (ladder.preferred.length === 0 && ladder.rejected.length === 0) {
    warnings.push(
      `R17: no structure ladder found in thesis (no frontmatter structure: block AND no "Preferred:" / "Alternative ladder" body section) — ` +
      `cannot enforce structure match; consider adding`
    );
    return { pass: true, reasons, warnings };
  }

  const proposed = input.proposed_structure;

  // Check rejected first (fail-closed)
  for (const rej of ladder.rejected) {
    if (matchesCanonical(proposed, rej)) {
      reasons.push(
        `R17: proposed structure "${canonicalToHuman(proposed)}" is REJECTED in thesis ladder — ` +
        `matched: "${rej.slice(0, 80)}"`
      );
      return { pass: false, reasons, warnings };
    }
  }

  // Check preferred (must match at least one)
  const matchesPreferred = ladder.preferred.some((p) => matchesCanonical(proposed, p));
  if (!matchesPreferred) {
    reasons.push(
      `R17: proposed structure "${canonicalToHuman(proposed)}" not in thesis preferred ladder — ` +
      `permitted: [${ladder.preferred.map((p) => p.slice(0, 50)).join(" | ")}]`
    );
    return { pass: false, reasons, warnings };
  }

  return { pass: true, reasons, warnings };
}

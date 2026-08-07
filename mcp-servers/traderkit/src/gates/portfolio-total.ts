// Read the portfolio total from the aggregate doc the profile points at.
//
// Why this exists, measured 2026-08-07: a roll was refused at 31.5% post-trade
// single-name against a 15% cap. The cap was right and the denominator was
// not — the caller had summed five brokers ($162,951.25) on a book of about
// $763,553. The gate divided by what it was handed, and wrote a hash-chained
// refusal that reads exactly like a real one. A bare number carries no record
// of which brokers went into it, so nothing downstream could catch it.
//
// So callers no longer supply the denominator. Every refusal here names the
// file and what is wrong with it, because the alternative — computing on a
// number nobody can vouch for — is what produced a permanent audit entry for
// a breach that never happened.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export class PortfolioTotalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortfolioTotalError";
  }
}

export interface PortfolioTotal {
  usd: number;
  /** The doc's own `updated:` stamp, not the time we read it. */
  asOf: string;
  /** Absolute path read, so a reason string can name it. */
  source: string;
}

export interface ReadOptions {
  now?: Date;
  maxAgeDays?: number;
}

/** A weekend plus a day: an aggregate refreshed Friday is still good Monday. */
export const DEFAULT_MAX_AGE_DAYS = 4;

const UPDATED = /^updated:\s*(\d{4}-\d{2}-\d{2})\s*$/m;

// The figure sits on a line that also lists the parts — per-broker legs on the
// personal aggregate, settled cash and buying power on a single-broker book — so
// match the label and take the FIRST dollar figure after it. The later ones are
// components, and summing or misreading them is the error this module closes.
//
// Two labels, tried in order, because the docs use two words for one claim: the
// cross-broker aggregate says "Total equity ex-transit", a single-broker book
// says "NAV". Order matters and is not cosmetic — portfolio-master names a
// broker leg as "IBKR (radon OAuth sync, NAV $107,131.89)" six lines above its
// own total, so a NAV-first read returns $107,131.89 for a $763,553 book. The
// fallback therefore demands a LABELLED figure, `NAV: $…`, never the bare word.
const TOTAL_LINE = /Total equity ex-transit.*$/m;
const NAV_LINE = /^.*?\*{0,2}NAV\*{0,2}\s*:.*$/m;
const DOLLARS = /\$\s*([\d,]+(?:\.\d+)?)/;

const MS_PER_DAY = 86_400_000;

/**
 * @param vaultRoot absolute path the profile's `vault_link` is relative to
 * @param vaultLink e.g. "wiki/trading/portfolio-master.md"
 * @throws PortfolioTotalError when the total cannot be read, parsed, or trusted
 */
export function readPortfolioTotal(
  vaultRoot: string,
  vaultLink: string,
  opts: ReadOptions = {}
): PortfolioTotal {
  const source = join(vaultRoot, vaultLink);
  const now = opts.now ?? new Date();
  const maxAgeDays = opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;

  let body: string;
  try {
    body = readFileSync(source, "utf8");
  } catch {
    throw new PortfolioTotalError(
      `portfolio total unavailable — cannot read the aggregate at ${source}. ` +
        `The single-name cap cannot be checked without it.`
    );
  }

  const stamp = UPDATED.exec(body);
  if (!stamp) {
    throw new PortfolioTotalError(
      `portfolio total unusable — ${source} carries no \`updated:\` stamp, ` +
        `so its age cannot be established.`
    );
  }
  const asOf = stamp[1]!;

  const line = TOTAL_LINE.exec(body) ?? NAV_LINE.exec(body);
  const figure = line ? DOLLARS.exec(line[0]) : null;
  const usd = figure ? Number(figure[1]!.replace(/,/g, "")) : NaN;
  if (!Number.isFinite(usd) || usd <= 0) {
    throw new PortfolioTotalError(
      `portfolio total unusable — ${source} states no total equity figure. ` +
        `A missing total is not a total of zero; refusing rather than ` +
        `skipping the single-name cap.`
    );
  }

  // Both sides at UTC midnight, so the answer is whole days and does not swing
  // on what time of day the check runs.
  const asOfMs = Date.parse(`${asOf}T00:00:00Z`);
  const nowMs = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  const ageDays = Math.round((nowMs - asOfMs) / MS_PER_DAY);
  if (ageDays > maxAgeDays) {
    throw new PortfolioTotalError(
      `portfolio total stale — ${source} was updated ${asOf}, ${ageDays} days ` +
        `ago; the bound is ${maxAgeDays} days. Refresh the aggregate before ` +
        `checking the single-name cap against it.`
    );
  }

  return { usd, asOf, source };
}

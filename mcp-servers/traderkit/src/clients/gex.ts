// Per-strike GEX (gamma-exposure) wall computation. Pure, deterministic, testable.
// Ported from radon scripts/gex_scan.py (bucket_profile / compute_gex_flip /
// find_key_levels / compute_expected_range), generalized from index/ETF tickers
// to any single name, and extended with CC-relevant upside call walls.
//
// Source data: UW /stock/{ticker}/greek-exposure/strike → rows with
// {strike, call_gex, put_gex, call_delta, put_delta}.

const TRADING_DAYS_PER_YEAR = 252;
const DEFAULT_RANGE_PCT = 0.1; // strikes within ±10% of spot
const INDEX_TICKERS = new Set(["SPX", "NDX"]);

export interface GexStrikeRow {
  strike: number;
  call_gex: number;
  put_gex: number;
  net_gex: number;
  call_delta: number;
  put_delta: number;
  net_delta: number;
}

export interface GexLevel {
  strike: number;
  gamma: number;
  distance: number;
  distance_pct: number;
}

export interface GexProfileBucket {
  strike: number;
  call_gex: number;
  put_gex: number;
  net_gex: number;
  pct_from_spot: number;
  tag: string | null;
}

export interface GexLevels {
  max_magnet: GexLevel | null;
  second_magnet: GexLevel | null;
  max_accelerator: GexLevel | null;
  put_wall: GexLevel | null;
  call_wall: GexLevel | null;
  gex_flip: GexLevel | null;
}

export interface CcSignal {
  short_call_strike: number;
  // nearest meaningful call-gamma wall at/above spot — the resistance ceiling
  nearest_upside_wall: GexLevel | null;
  // top upside call-gamma walls above spot (resistance the stock must pierce)
  upside_call_walls: GexLevel[];
  // position of the short call vs the nearest upside wall
  vs_wall: "above_wall_safe" | "at_wall" | "below_wall_risk" | "no_wall";
  note: string;
}

export interface GexAnalysis {
  ticker: string;
  spot: number;
  bucket_size: number;
  net_gex: number;
  net_dex: number;
  levels: GexLevels;
  upside_call_walls: GexLevel[];
  profile: GexProfileBucket[];
  expected_range?: { low: number | null; high: number | null; iv_1d: number | null };
  cc_signal?: CcSignal;
}

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function toNum(x: unknown): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

/** Bucket width: $25 for index, $5 for SPY/QQQ, else ~0.5% of spot (min $1). */
export function bucketSizeFor(ticker: string, spot: number): number {
  const t = ticker.toUpperCase();
  if (INDEX_TICKERS.has(t)) return 25;
  if (t === "SPY" || t === "QQQ") return 5;
  return Math.max(1, Math.round(spot * 0.005));
}

/** Parse raw UW per-strike rows into typed rows, skipping malformed entries. */
export function parseStrikeRows(rows: Record<string, unknown>[]): GexStrikeRow[] {
  const out: GexStrikeRow[] = [];
  for (const r of rows) {
    const strike = Number(r.strike);
    if (!Number.isFinite(strike)) continue;
    const call_gex = toNum(r.call_gex);
    const put_gex = toNum(r.put_gex);
    const call_delta = toNum(r.call_delta);
    const put_delta = toNum(r.put_delta);
    out.push({
      strike,
      call_gex,
      put_gex,
      net_gex: call_gex + put_gex,
      call_delta,
      put_delta,
      net_delta: call_delta + put_delta,
    });
  }
  return out;
}

/** Aggregate per-strike GEX into buckets within ±rangePct of spot. */
export function bucketProfile(
  rows: GexStrikeRow[],
  bucketSize: number,
  spot: number,
  rangePct = DEFAULT_RANGE_PCT,
): GexProfileBucket[] {
  const low = spot * (1 - rangePct);
  const high = spot * (1 + rangePct);
  const buckets = new Map<number, { call_gex: number; put_gex: number; net_gex: number }>();
  for (const row of rows) {
    if (row.strike < low || row.strike > high) continue;
    const b = Math.round(row.strike / bucketSize) * bucketSize;
    const cur = buckets.get(b) ?? { call_gex: 0, put_gex: 0, net_gex: 0 };
    cur.call_gex += row.call_gex;
    cur.put_gex += row.put_gex;
    cur.net_gex += row.net_gex;
    buckets.set(b, cur);
  }
  return [...buckets.keys()]
    .sort((a, b) => a - b)
    .map((strike) => {
      const v = buckets.get(strike)!;
      return {
        strike,
        call_gex: round(v.call_gex),
        put_gex: round(v.put_gex),
        net_gex: round(v.net_gex),
        pct_from_spot: round(((strike - spot) / spot) * 100),
        tag: null,
      };
    });
}

/** GEX flip: highest strike ≤ spot where net GEX crosses negative→positive. */
export function computeGexFlip(profile: GexProfileBucket[], spot: number): number | null {
  let flip: number | null = null;
  for (let i = 1; i < profile.length; i++) {
    const prev = profile[i - 1]!.net_gex;
    const curr = profile[i]!.net_gex;
    const strike = profile[i]!.strike;
    if (prev < 0 && curr > 0 && strike <= spot) flip = strike;
  }
  return flip;
}

function makeLevel(bucket: GexProfileBucket | null, spot: number): GexLevel | null {
  if (!bucket) return null;
  return {
    strike: bucket.strike,
    gamma: round(bucket.net_gex),
    distance: round(bucket.strike - spot),
    distance_pct: round(((bucket.strike - spot) / spot) * 100),
  };
}

/** Identify magnets, accelerator, put wall, call wall from a bucketed profile. */
export function findKeyLevels(profile: GexProfileBucket[], spot: number): Omit<GexLevels, "gex_flip"> {
  if (!profile.length) {
    return { max_magnet: null, second_magnet: null, max_accelerator: null, put_wall: null, call_wall: null };
  }
  const positive = profile.filter((b) => b.net_gex > 0).sort((a, b) => b.net_gex - a.net_gex);
  const negative = profile.filter((b) => b.net_gex < 0).sort((a, b) => a.net_gex - b.net_gex);
  const putWall = profile.reduce((m, b) => (Math.abs(b.put_gex) > Math.abs(m.put_gex) ? b : m), profile[0]!);
  const callWall = profile.reduce((m, b) => (b.call_gex > m.call_gex ? b : m), profile[0]!);
  return {
    max_magnet: makeLevel(positive[0] ?? null, spot),
    second_magnet: makeLevel(positive[1] ?? null, spot),
    max_accelerator: makeLevel(negative[0] ?? null, spot),
    put_wall: makeLevel(putWall, spot),
    call_wall: makeLevel(callWall, spot),
  };
}

/**
 * CC-relevant upside walls: call-gamma buckets ABOVE spot, ranked by call_gex.
 * These are the resistance levels a covered-call writer anchors to — selling
 * at/above a heavy call wall maximizes the chance the stock pins below strike.
 */
export function upsideCallWalls(profile: GexProfileBucket[], spot: number, top = 3): GexLevel[] {
  return profile
    .filter((b) => b.strike > spot && b.call_gex > 0)
    .sort((a, b) => b.call_gex - a.call_gex)
    .slice(0, top)
    .map((b) => ({
      strike: b.strike,
      gamma: round(b.call_gex),
      distance: round(b.strike - spot),
      distance_pct: round(((b.strike - spot) / spot) * 100),
    }));
}

function tagProfile(
  profile: GexProfileBucket[],
  spot: number,
  flip: number | null,
  levels: Omit<GexLevels, "gex_flip">,
): void {
  let spotBucket: number | null = null;
  let minDist = Infinity;
  for (const b of profile) {
    const d = Math.abs(b.strike - spot);
    if (d < minDist) {
      minDist = d;
      spotBucket = b.strike;
    }
  }
  const tagMap = new Map<number, string>();
  if (spotBucket !== null) tagMap.set(spotBucket, "SPOT");
  if (flip !== null) tagMap.set(flip, "GEX FLIP");
  for (const [name, level] of Object.entries(levels)) {
    if (!level) continue;
    const label = name.toUpperCase().replace(/_/g, " ");
    if (!tagMap.has(level.strike)) tagMap.set(level.strike, label);
  }
  for (const b of profile) b.tag = tagMap.get(b.strike) ?? null;
}

/** 1-day expected range from ATM IV (decimal, e.g. 0.236). */
export function computeExpectedRange(spot: number, atmIv: number | undefined): {
  low: number | null;
  high: number | null;
  iv_1d: number | null;
} {
  if (!atmIv || atmIv <= 0) return { low: null, high: null, iv_1d: null };
  const iv1d = atmIv / Math.sqrt(TRADING_DAYS_PER_YEAR);
  const move = spot * iv1d;
  return { low: round(spot - move), high: round(spot + move), iv_1d: round(iv1d * 100, 4) };
}

function buildCcSignal(walls: GexLevel[], spot: number, shortStrike: number, bucketSize: number): CcSignal {
  const nearest = walls.length ? walls.reduce((a, b) => (a.strike <= b.strike ? a : b)) : null;
  let vs: CcSignal["vs_wall"];
  let note: string;
  if (!nearest) {
    vs = "no_wall";
    note = `No call-gamma wall above spot $${spot} — thin upside positioning; rely on delta/DTE rules for strike selection.`;
  } else if (shortStrike >= nearest.strike + bucketSize) {
    vs = "above_wall_safe";
    note = `Short $${shortStrike}C sits above the nearest call wall $${nearest.strike} (resistance) — pinning pressure favors expiry below strike.`;
  } else if (Math.abs(shortStrike - nearest.strike) <= bucketSize) {
    vs = "at_wall";
    note = `Short $${shortStrike}C is at the call wall $${nearest.strike} — strong pin candidate; assignment risk only on a decisive break above.`;
  } else {
    vs = "below_wall_risk";
    note = `Short $${shortStrike}C is below the nearest call wall $${nearest.strike} — heavier call gamma sits above your strike; elevated test/assignment risk if spot grinds up.`;
  }
  return {
    short_call_strike: shortStrike,
    nearest_upside_wall: nearest,
    upside_call_walls: walls,
    vs_wall: vs,
    note,
  };
}

export interface GexAnalysisOpts {
  rangePct?: number;
  atmIv?: number | undefined;
  shortCallStrike?: number | undefined;
}

/** Full GEX analysis from parsed strike rows. Pure — no IO. */
export function computeGexAnalysis(
  rows: GexStrikeRow[],
  ticker: string,
  spot: number,
  opts: GexAnalysisOpts = {},
): GexAnalysis {
  const rangePct = opts.rangePct ?? DEFAULT_RANGE_PCT;
  const bucketSize = bucketSizeFor(ticker, spot);
  const profile = bucketProfile(rows, bucketSize, spot, rangePct);
  const flip = computeGexFlip(profile, spot);
  const baseLevels = findKeyLevels(profile, spot);
  tagProfile(profile, spot, flip, baseLevels);

  const flipLevel: GexLevel | null =
    flip === null ? null : { strike: flip, gamma: 0, distance: round(flip - spot), distance_pct: round(((flip - spot) / spot) * 100) };

  const netGex = rows.reduce((s, r) => s + r.net_gex, 0);
  const netDex = rows.reduce((s, r) => s + r.net_delta, 0);
  const walls = upsideCallWalls(profile, spot);

  const analysis: GexAnalysis = {
    ticker: ticker.toUpperCase(),
    spot,
    bucket_size: bucketSize,
    net_gex: round(netGex),
    net_dex: round(netDex),
    levels: { ...baseLevels, gex_flip: flipLevel },
    upside_call_walls: walls,
    profile,
  };

  if (opts.atmIv !== undefined) analysis.expected_range = computeExpectedRange(spot, opts.atmIv);
  if (opts.shortCallStrike !== undefined) {
    analysis.cc_signal = buildCcSignal(walls, spot, opts.shortCallStrike, bucketSize);
  }
  return analysis;
}

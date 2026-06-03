/**
 * check_ai_bott_layer — mirrors check_concentration but for AI-Bottlenecks
 * physical-layer chokepoint exposure (vs single-name).
 *
 * Source of truth: vault watchlist at
 *   `wiki/trading/watchlists/ai-bottlenecks.md`
 * Parsed shape: { layer_roman, layer_name, cap_tier, notes } per ticker.
 *
 * Default cap: 4% NAV per physical layer (I-XV). Override via `layer_cap_pct`.
 *
 * Why a separate tool: single-name caps in `check_concentration` miss the
 * cross-name macro-driver concentration risk (e.g. INTC + AMD + NVDA all
 * under Layer V Custom Silicon — each <4% but combined 11% NAV layer
 * exposure). The single-driver unwind hits all together.
 *
 * Cross-thesis dedupe rule applies: tickers held under a sibling thesis
 * (e.g. NVDA under materials-cc-basket, IREN under situational-awareness)
 * count under their primary budget for single-name purposes, but ALWAYS
 * count under their AI-Bott layer budget — the layer exposure is additive
 * regardless of which sleeve owns the position. See
 * [[wiki/trading/cross-thesis-dedupe]].
 */
import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { TickerSchema } from "../utils/schemas.js";
import { concentrationLabel } from "../utils/concentration.js";

const DEFAULT_VAULT = process.env.OBSIDIAN_VAULT ??
  join(homedir(), "Library/Mobile Documents/iCloud~md~obsidian/Documents/obsidian");
const WATCHLIST_REL = "wiki/trading/watchlists/ai-bottlenecks.md";
const DEFAULT_LAYER_CAP_PCT = 4.0;

export const CheckAiBottLayerArgs = z.object({
  positions: z.array(z.object({
    ticker: TickerSchema,
    market_value_usd: z.number(),
  })),
  portfolio_total_usd: z.number().positive(),
  layer_cap_pct: z.number().positive().max(100).optional(),
  vault_path: z.string().optional(),
});

interface LayerInfo {
  ticker: string;
  layer_roman: string;
  layer_name: string;
  cap_tier: "LC" | "MC" | "SC";
  notes: string;
}

const HEADER_RE = /^##\s+([IVXLC]+)\s*[—–-]\s*(.+?)\s*$/;
const ROW_RE = /^\|\s*([A-Z0-9][A-Z0-9._-]*)\s*\|\s*([^|]+?)\s*\|\s*(LC|MC|SC)\s*\|\s*(.+?)\s*\|\s*$/;

let _layerMapCache: { vault: string; map: Map<string, LayerInfo> } | null = null;

function loadLayerMap(vaultPath: string): Map<string, LayerInfo> {
  if (_layerMapCache && _layerMapCache.vault === vaultPath) {
    return _layerMapCache.map;
  }
  const path = join(vaultPath, WATCHLIST_REL);
  const map = new Map<string, LayerInfo>();
  if (!existsSync(path)) {
    _layerMapCache = { vault: vaultPath, map };
    return map;
  }
  const text = readFileSync(path, "utf-8");
  let currentRoman = "";
  let currentName = "";
  for (const line of text.split("\n")) {
    const header = HEADER_RE.exec(line);
    if (header && header[1] && header[2]) {
      currentRoman = header[1];
      currentName = header[2].trim();
      continue;
    }
    if (!currentRoman) continue;
    if (line.startsWith("|---") || line.startsWith("| Ticker")) continue;
    const row = ROW_RE.exec(line);
    if (!row) continue;
    const ticker = row[1];
    const capTier = row[3];
    const notes = row[4] ?? "";
    if (!ticker || !capTier) continue;
    if (!map.has(ticker)) {
      map.set(ticker, {
        ticker,
        layer_roman: currentRoman,
        layer_name: currentName,
        cap_tier: capTier as "LC" | "MC" | "SC",
        notes: notes.trim(),
      });
    }
  }
  _layerMapCache = { vault: vaultPath, map };
  return map;
}

/**
 * Lightweight ticker→layer lookup for callers (e.g. propose_trade) that only
 * need layer membership, not full portfolio exposure. Returns null when the
 * ticker is not in the watchlist or watchlist file is missing.
 */
export function getLayerForTicker(
  ticker: string,
  vaultPath?: string,
): { layer_roman: string; layer_name: string; cap_tier: string } | null {
  const vault = vaultPath ?? DEFAULT_VAULT;
  const map = loadLayerMap(vault);
  const info = map.get(ticker.toUpperCase());
  if (!info) return null;
  return {
    layer_roman: info.layer_roman,
    layer_name: info.layer_name,
    cap_tier: info.cap_tier,
  };
}

export interface LayerExposureEntry {
  layer_roman: string;
  layer_name: string;
  n_positions: number;
  tickers: string[];
  market_value_usd: number;
  pct_nav: number;
  cap_pct: number;
  label: string;
  headroom_pct: number;
}

export async function checkAiBottLayerHandler(raw: unknown) {
  const args = CheckAiBottLayerArgs.parse(raw);
  const vault = args.vault_path ?? DEFAULT_VAULT;
  const cap = args.layer_cap_pct ?? DEFAULT_LAYER_CAP_PCT;
  const layerMap = loadLayerMap(vault);

  if (layerMap.size === 0) {
    return {
      cap_pct: cap,
      portfolio_total_usd: args.portfolio_total_usd,
      n_layers_held: 0,
      layer_exposures: [],
      violations: [],
      warnings: [`watchlist not found at ${vault}/${WATCHLIST_REL}`],
      tracked_tickers: [],
      untracked_tickers: args.positions.map((p) => p.ticker),
    };
  }

  // Group positions by layer
  const byLayer = new Map<string, { layer_name: string; tickers: string[]; mv: number }>();
  const tracked: string[] = [];
  const untracked: string[] = [];
  for (const p of args.positions) {
    const info = layerMap.get(p.ticker);
    if (!info) {
      untracked.push(p.ticker);
      continue;
    }
    tracked.push(p.ticker);
    const bucket = byLayer.get(info.layer_roman) ?? {
      layer_name: info.layer_name,
      tickers: [],
      mv: 0,
    };
    bucket.tickers.push(p.ticker);
    bucket.mv += p.market_value_usd;
    byLayer.set(info.layer_roman, bucket);
  }

  const layerExposures: LayerExposureEntry[] = [];
  for (const [roman, bucket] of byLayer) {
    const pct = (bucket.mv / args.portfolio_total_usd) * 100;
    layerExposures.push({
      layer_roman: roman,
      layer_name: bucket.layer_name,
      n_positions: bucket.tickers.length,
      tickers: [...new Set(bucket.tickers)].sort(),
      market_value_usd: bucket.mv,
      pct_nav: Math.round(pct * 100) / 100,
      cap_pct: cap,
      label: concentrationLabel(pct, cap),
      headroom_pct: Math.round(Math.max(0, cap - pct) * 100) / 100,
    });
  }
  layerExposures.sort((a, b) => b.pct_nav - a.pct_nav);

  const violations = layerExposures
    .filter((e) => e.label === "OVER-CAP")
    .map((e) => ({
      layer_roman: e.layer_roman,
      layer_name: e.layer_name,
      pct_nav: e.pct_nav,
      cap_pct: e.cap_pct,
      tickers: e.tickers,
      over_cap_by_pct: Math.round((e.pct_nav - e.cap_pct) * 100) / 100,
    }));
  const warnings = layerExposures
    .filter((e) => e.label === "NEAR-CAP" || e.label === "AT-CAP")
    .map((e) => `${e.layer_roman} (${e.layer_name}) at ${e.pct_nav}% — ${e.label} (cap ${e.cap_pct}%)`);

  return {
    cap_pct: cap,
    portfolio_total_usd: args.portfolio_total_usd,
    n_layers_held: layerExposures.length,
    layer_exposures: layerExposures,
    violations,
    warnings,
    tracked_tickers: tracked,
    untracked_tickers: untracked,
    summary_one_line: (() => {
      const top = layerExposures[0];
      if (!top) return "[AI-BOTT] no held positions in watchlist";
      return `[AI-BOTT] ${layerExposures.length} layers held · top: ${top.layer_roman} (${top.layer_name}) ${top.pct_nav}% [${top.label}]`;
    })(),
  };
}

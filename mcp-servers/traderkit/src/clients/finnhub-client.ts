import { toMessage } from "../utils/errors.js";

const FINNHUB_BASE = process.env.FINNHUB_BASE ?? "https://finnhub.io/api/v1";

export interface FinnhubProfile {
  ticker: string;
  name?: string | undefined;
  market_cap_usd?: number | undefined;
  sector?: string | undefined;
  industry?: string | undefined;
  country?: string | undefined;
  exchange?: string | undefined;
  ipo_date?: string | undefined;
}

function sanitizeBody(body: string, token: string): string {
  const stripped = token ? body.split(token).join("[redacted]") : body;
  return stripped.slice(0, 200);
}

async function fhGet(path: string, params: Record<string, string>): Promise<unknown> {
  const token = process.env.FINNHUB_API_KEY;
  if (!token) throw new Error("FINNHUB_API_KEY not set");
  const qs = new URLSearchParams(params);
  const url = `${FINNHUB_BASE}${path}${qs.toString() ? `?${qs}` : ""}`;
  const res = await fetch(url, {
    headers: { "X-Finnhub-Token": token, Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Finnhub ${res.status} ${path}: ${sanitizeBody(body, token)}`);
  }
  return res.json();
}

function asRecord(x: unknown): Record<string, unknown> {
  return x && typeof x === "object" ? (x as Record<string, unknown>) : {};
}

function asNumber(x: unknown): number | undefined {
  if (x === null || x === undefined || x === "") return undefined;
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
}

function asString(x: unknown): string | undefined {
  return typeof x === "string" && x.length > 0 ? x : undefined;
}

export async function finnhubProfile(ticker: string): Promise<FinnhubProfile> {
  const T = ticker.toUpperCase();
  try {
    const j = asRecord(await fhGet("/stock/profile2", { symbol: T }));
    const cap = asNumber(j.marketCapitalization);
    return {
      ticker: T,
      name: asString(j.name),
      market_cap_usd: cap !== undefined ? cap * 1_000_000 : undefined,
      sector: asString(j.finnhubIndustry),
      industry: asString(j.finnhubIndustry),
      country: asString(j.country),
      exchange: asString(j.exchange),
      ipo_date: asString(j.ipo),
    };
  } catch (e) {
    process.stderr.write(`traderkit: finnhubProfile(${T}) failed: ${toMessage(e)}\n`);
    return { ticker: T };
  }
}


import { toMessage } from "../utils/errors.js";

const FRED_BASE = process.env.FRED_BASE ?? "https://api.stlouisfed.org/fred";

export interface FredObservation {
  series_id: string;
  date: string;
  value: number;
}

function sanitizeBody(body: string, token: string): string {
  const stripped = token ? body.split(token).join("[redacted]") : body;
  return stripped.slice(0, 200);
}

async function fredGet(path: string, params: Record<string, string>): Promise<unknown> {
  const token = process.env.FRED_API_KEY;
  if (!token) throw new Error("FRED_API_KEY not set");
  const merged = { ...params, api_key: token, file_type: "json" };
  const qs = new URLSearchParams(merged);
  const url = `${FRED_BASE}${path}?${qs}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`FRED ${res.status} ${path}: ${sanitizeBody(body, token)}`);
  }
  return res.json();
}

interface FredObservationsPayload {
  observations?: Array<{ date?: string; value?: string }>;
}

export async function fredLatestObservation(seriesId: string): Promise<FredObservation | null> {
  try {
    const j = (await fredGet("/series/observations", {
      series_id: seriesId, sort_order: "desc", limit: "5",
    })) as FredObservationsPayload;
    for (const obs of j.observations ?? []) {
      if (obs.value && obs.value !== "." && obs.date) {
        const v = Number(obs.value);
        if (Number.isFinite(v)) return { series_id: seriesId, date: obs.date, value: v };
      }
    }
    return null;
  } catch (e) {
    process.stderr.write(`traderkit: fredLatestObservation(${seriesId}) failed: ${toMessage(e)}\n`);
    return null;
  }
}

export async function fredMacroSnapshot(
  seriesIds: string[],
): Promise<Record<string, FredObservation | { error: string }>> {
  const out: Record<string, FredObservation | { error: string }> = {};
  for (const sid of seriesIds) {
    const obs = await fredLatestObservation(sid);
    out[sid] = obs ?? { error: "empty" };
  }
  return out;
}

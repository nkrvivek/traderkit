import { z } from "zod";
import { fredLatestObservation, fredMacroSnapshot } from "../clients/fred-client.js";

export const FredSeriesArgs = z.object({
  series_ids: z.array(z.string().min(1)).min(1).max(20),
});

export async function fredSeriesHandler(raw: unknown): Promise<unknown> {
  const { series_ids } = FredSeriesArgs.parse(raw);
  if (series_ids.length === 1) {
    const obs = await fredLatestObservation(series_ids[0]!);
    return { snapshot: { [series_ids[0]!]: obs ?? { error: "empty" } } };
  }
  return { snapshot: await fredMacroSnapshot(series_ids) };
}

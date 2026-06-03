import { z } from "zod";
import { avGlobalQuote, avMacroSeries } from "../clients/alpha-vantage-client.js";

export const AvQuoteArgs = z.object({
  ticker: z.string().min(1).optional(),
  macro_series: z.enum([
    "REAL_GDP", "REAL_GDP_PER_CAPITA", "TREASURY_YIELD", "FEDERAL_FUNDS_RATE",
    "CPI", "INFLATION", "RETAIL_SALES", "DURABLES", "UNEMPLOYMENT", "NONFARM_PAYROLL",
  ]).optional(),
}).refine((a) => a.ticker || a.macro_series, {
  message: "must provide ticker or macro_series",
});

export async function avQuoteHandler(raw: unknown): Promise<unknown> {
  const args = AvQuoteArgs.parse(raw);
  if (args.ticker) return { quote: await avGlobalQuote(args.ticker) };
  return { series: args.macro_series, points: await avMacroSeries(args.macro_series!) };
}

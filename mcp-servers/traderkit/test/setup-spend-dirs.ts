/**
 * Keep the suite out of ~/.fmp-spend and ~/.uw-spend.
 *
 * Both counters are shared with other processes, and trade-refresh's
 * `src.fmp_quota` and `src.uw_quota` read them off disk. Importing either
 * client writes a zero row for the day, so without this every `npm test` would
 * claim the MCP server ran. A test that fakes a 429 would go further and mark
 * the live day as rate-limited on a token four consumers draw on.
 *
 * Set before any test file imports a client, which is what setupFiles buys.
 * The Python consumers cannot do this: pytest imports at collection, before any
 * fixture can redirect the path, which is why they write from the constructor
 * instead of at module load.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FMP_SPEND_DIR = mkdtempSync(join(tmpdir(), "fmp-spend-suite-"));
process.env.UW_SPEND_DIR = mkdtempSync(join(tmpdir(), "uw-spend-suite-"));

/**
 * Keep the suite out of ~/.fmp-spend.
 *
 * src/clients/fmp-spend.ts writes to a counter shared with four other
 * processes, and trade-refresh's `src.fmp_quota` reads it. Importing the FMP
 * client writes a zero row for the day, so without this every `npm test` would
 * claim the MCP server ran. A test that fakes a 429 would go further and mark
 * the live day as rate-limited.
 *
 * Set before any test file imports the client, which is what setupFiles buys.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FMP_SPEND_DIR = mkdtempSync(join(tmpdir(), "fmp-spend-suite-"));

import { join } from "node:path";
import { homedir } from "node:os";

export const KIT_ROOT = process.env.TRADERKIT_ROOT ?? join(homedir(), ".traderkit");
export const PROFILES_DIR = join(KIT_ROOT, "profiles");

// What a profile's `vault_link` is relative to. Set TRADERKIT_VAULT_ROOT to the
// notes directory holding the portfolio aggregate; unset, nothing resolves and
// the caps check says so rather than guessing a path.
export const VAULT_ROOT = process.env.TRADERKIT_VAULT_ROOT ?? null;
export const SESSION_FILE = ".session.json";
export const ACTIVITIES_CACHE_TTL_MS = 5 * 60 * 1000;

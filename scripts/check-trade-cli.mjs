#!/usr/bin/env node
// Run check_trade from a shell.
//
// check_trade existed only behind MCP, so the quote -> check -> mint -> place
// chain could not run as one command. That is why a precheck token had no
// place a person could get one from, and why the enforced place-order path
// could not actually be reached without an assistant in the loop.
//
// This calls the same handler the MCP server calls, against the same profiles,
// and writes the same hash-chained entry to ~/.traderkit/gate_audit/. The
// ticket_id it prints is the one src/gate_audit.py reads back.
//
// Usage:
//   echo '{"profile":"personal","tool":"ts_place_spread",...}' \
//     | node scripts/check-trade-cli.mjs
//   node scripts/check-trade-cli.mjs --json '{"profile":"personal",...}'
//
// Exit 0 when the check passes, 1 when it fails, 2 on a bad invocation.
// Prints one JSON object on stdout either way, so callers parse rather than scrape.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, "../mcp-servers/traderkit/dist");

try {
  process.loadEnvFile(resolve(HERE, "../.env"));
} catch {
  // .env optional — env may already be exported in the shell
}

// An empty line in .env is not a value, and the server reads its paths with
// `??`, which catches undefined but not "". `TRADERKIT_ROOT=` sits blank in
// .env, so loading it turned ~/.traderkit/profiles into the relative
// "profiles" and every profile silently vanished. Drop blanks so the
// server's own defaults survive.
for (const [k, v] of Object.entries(process.env)) {
  if (v === "") delete process.env[k];
}

function fail(msg, code = 2) {
  process.stdout.write(JSON.stringify({ pass: false, reasons: [msg], warnings: [] }) + "\n");
  process.exit(code);
}

function readArgs() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--json");
  if (i !== -1) {
    if (!argv[i + 1]) fail("--json given with no value");
    return argv[i + 1];
  }
  const file = argv.indexOf("--file");
  if (file !== -1) {
    if (!argv[file + 1]) fail("--file given with no path");
    return readFileSync(argv[file + 1], "utf8");
  }
  try {
    return readFileSync(0, "utf8");
  } catch {
    fail("no input — pipe JSON on stdin, or pass --json / --file");
  }
}

const raw = readArgs();
let args;
try {
  args = JSON.parse(raw);
} catch (e) {
  fail(`input is not JSON: ${e.message}`);
}

const { loadAllProfiles } = await import(`${SERVER}/profiles/loader.js`);
const { PROFILES_DIR } = await import(`${SERVER}/config.js`);
const { connectSnaptradeRead } = await import(`${SERVER}/mcp/snaptrade-read-client.js`);
const { checkTradeHandler } = await import(`${SERVER}/tools/check-trade.js`);

const allProfiles = await loadAllProfiles(PROFILES_DIR).catch(() => []);
if (allProfiles.length === 0) fail(`no profiles loaded from ${PROFILES_DIR}`);

// The wash-sale rule reads broker activity through this client. Without it the
// gate reports "wash-sale activities fetch failed" and refuses, so losing the
// client can never read as a clean check — but say why it was lost, because
// "not configured" and "the connection died" need different repairs.
let snaptradeRead = null;
let readClientNote = null;
const readCommand = process.env.SNAPTRADE_READ_COMMAND;
if (!readCommand) {
  readClientNote = "SNAPTRADE_READ_COMMAND unset — wash-sale checks cannot run";
} else {
  // The MCP stdio transport hands the child a minimal environment, so the
  // read server starts with none of our credentials and dies with
  // "Connection closed". Name what it needs rather than forwarding the whole
  // environment into a child process.
  const CHILD_ENV = [
    "PATH", "HOME", "SNAPTRADE_CLIENT_ID", "SNAPTRADE_CONSUMER_KEY",
    "SNAPTRADE_USER_ID", "SNAPTRADE_USER_SECRET",
  ];
  const childEnv = Object.fromEntries(
    CHILD_ENV.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  const missing = CHILD_ENV.filter((k) => !process.env[k]);

  try {
    snaptradeRead = await connectSnaptradeRead({
      command: readCommand,
      args: (process.env.SNAPTRADE_READ_ARGS ?? "").split(" ").filter(Boolean),
      env: childEnv,
    });
  } catch (e) {
    // A missing credential kills the child before it speaks, and the transport
    // reports only "Connection closed". Say which one is absent.
    readClientNote = missing.length
      ? `snaptrade-read cannot start — missing ${missing.join(", ")}`
      : `snaptrade-read failed to connect (${readCommand}): ${e.message}`;
  }
}

let result;
try {
  result = await checkTradeHandler(args, { allProfiles, snaptradeRead });
} catch (e) {
  fail(`check_trade threw: ${e.message}`);
}

if (readClientNote) result.warnings = [...(result.warnings ?? []), readClientNote];

process.stdout.write(JSON.stringify(result, null, 2) + "\n");
await snaptradeRead?.close().catch(() => {});
process.exit(result.pass ? 0 : 1);

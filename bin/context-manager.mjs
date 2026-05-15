#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileUrlForPath, moduleDir } from "../scripts/lib/utils.mjs";

const REPO_ROOT = path.resolve(moduleDir(import.meta.url), "..");

const COMMANDS = {
  init: "scripts/activate_hooks.mjs",
  compile: "scripts/compile.mjs",
  lint: "scripts/lint.mjs",
  "migrate-codex-history": "scripts/migrate_codex_history.mjs",
  "replay-pending": "scripts/replay_pending.mjs",
  "smoke-e2e": "scripts/smoke_e2e.mjs"
};

const command = process.argv[2];
if (!command || !(command in COMMANDS)) {
  process.stderr.write(
    "Usage: context-manager <init|compile|lint|migrate-codex-history|replay-pending|smoke-e2e> [args]\n"
  );
  process.exit(1);
}

const modulePath = path.join(REPO_ROOT, COMMANDS[command]);
const module = await import(fileUrlForPath(modulePath));
const run = module.mainFromCli ?? module.main;
if (typeof run !== "function") {
  process.stderr.write(`Command module does not export main: ${command}\n`);
  process.exit(1);
}

const exitCode = await run(process.argv.slice(3));
process.exit(typeof exitCode === "number" ? exitCode : 0);

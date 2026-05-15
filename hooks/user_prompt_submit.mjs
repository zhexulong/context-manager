#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { INTERNAL_ENV_VAR } from "../scripts/lib/llm.mjs";
import { recordHookStatus } from "../scripts/lib/runtime_status.mjs";
import { isMainModule, parseCommonArgs, readJsonStdin } from "../scripts/lib/utils.mjs";

const SKILL_NAME = "guidance-recall";

function guidanceIndexExists(repoRoot) {
  const indexPath = path.join(repoRoot, "guidance", "index.md");
  return fs.existsSync(indexPath) && fs.statSync(indexPath).isFile();
}

function reminderMessage() {
  return [
    `[${SKILL_NAME}] Compiled repo guidance is available when prior decisions, workflows, or conventions matter.`,
    `Use the ${SKILL_NAME} skill instead of bulk-reading working-memory.`
  ].join(" ");
}

export async function main(argv = process.argv.slice(2)) {
  if (process.env[INTERNAL_ENV_VAR] === "1") {
    return 0;
  }
  const args = parseCommonArgs(argv);
  readJsonStdin();
  const repoRoot = path.resolve(args.repoRoot);
  if (!guidanceIndexExists(repoRoot)) {
    recordHookStatus(repoRoot, "UserPromptSubmit", "no_guidance");
    return 0;
  }

  recordHookStatus(repoRoot, "UserPromptSubmit", "hint_emitted", {
    skill_name: SKILL_NAME
  });
  process.stdout.write(`${JSON.stringify({ systemMessage: reminderMessage() })}\n`);
  return 0;
}

export const mainFromCli = main;

if (isMainModule(import.meta.url)) {
  process.exit(await main());
}

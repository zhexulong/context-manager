#!/usr/bin/env node

import path from "node:path";
import process from "node:process";

import { INTERNAL_ENV_VAR } from "../scripts/lib/llm.mjs";
import { recordHookStatus } from "../scripts/lib/runtime_status.mjs";
import { isMainModule, parseCommonArgs, readJsonStdin } from "../scripts/lib/utils.mjs";

export const GUIDANCE_SKILL_NAME = "guidance-recall";

export async function main(argv = process.argv.slice(2)) {
  if (process.env[INTERNAL_ENV_VAR] === "1") {
    return 0;
  }
  const args = parseCommonArgs(argv);
  readJsonStdin();
  const repoRoot = path.resolve(args.repoRoot);
  recordHookStatus(repoRoot, "SessionStart", "skill_mode", {
    skill_name: GUIDANCE_SKILL_NAME
  });
  return 0;
}

export const mainFromCli = main;

if (isMainModule(import.meta.url)) {
  process.exit(await main());
}

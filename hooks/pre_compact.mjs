#!/usr/bin/env node

import path from "node:path";
import process from "node:process";

import { INTERNAL_ENV_VAR } from "../scripts/lib/llm.mjs";
import { recordHookStatus } from "../scripts/lib/runtime_status.mjs";
import { isMainModule, moduleDir, parseCommonArgs, readJsonStdin } from "../scripts/lib/utils.mjs";
import { runPipelineHook } from "./lib/pipeline_runtime.mjs";

const REPO_ROOT = path.resolve(moduleDir(import.meta.url), "..");
const PIPELINE_SCRIPT = path.join(REPO_ROOT, "scripts", "run_pipeline.mjs");

export async function main(argv = process.argv.slice(2)) {
  if (process.env[INTERNAL_ENV_VAR] === "1") {
    return 0;
  }
  const args = parseCommonArgs(argv);
  const payload = readJsonStdin();
  const repoRoot = path.resolve(args.repoRoot);
  const transcriptPath = payload.transcript_path;
  if (!transcriptPath) {
    recordHookStatus(repoRoot, "PreCompact", "skipped_missing_transcript");
    return 0;
  }
  return runPipelineHook({
    repoRoot,
    title: "Pre-Compact Capture",
    transcriptPath,
    hookName: "PreCompact",
    sessionId: payload.session_id || null,
    pipelineScript: PIPELINE_SCRIPT
  });
}

export const mainFromCli = main;

if (isMainModule(import.meta.url)) {
  process.exit(await main());
}

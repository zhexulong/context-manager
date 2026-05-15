#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { appendEntry } from "./flush.mjs";
import { main as compileMain } from "./compile.mjs";
import { recordHookStatus } from "./lib/runtime_status.mjs";
import { reduceTranscriptForFlush } from "./lib/transcript_context.mjs";
import { isMainModule, isoDateToday, moduleDir, parseCommonArgs } from "./lib/utils.mjs";
import { main as replayPendingMain } from "./replay_pending.mjs";

const REPO_ROOT = path.resolve(moduleDir(import.meta.url), "..");
const FLUSH_SCRIPT = path.join(REPO_ROOT, "scripts", "flush.mjs");
const REPLAY_PENDING_SCRIPT = path.join(REPO_ROOT, "scripts", "replay_pending.mjs");
const COMPILE_SCRIPT = path.join(REPO_ROOT, "scripts", "compile.mjs");

function runCommand(command, cwd, inputText = null) {
  const result = spawnSync(process.execPath, command, {
    input: inputText ?? undefined,
    encoding: "utf8",
    cwd,
    env: process.env
  });
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  return {
    status: result.status ?? 1,
    stderr: result.stderr || "",
    stdout: result.stdout || "",
    signal: result.signal || null,
    error: result.error?.message || null
  };
}

function finalStatusDetails(sessionId, extra = {}) {
  return {
    ...(sessionId ? { session_id: sessionId } : {}),
    ...extra
  };
}

function recordFinalHookStatus(repoRoot, hookEvent, status, sessionId, extra = {}) {
  if (!hookEvent) {
    return;
  }
  recordHookStatus(repoRoot, hookEvent, status, finalStatusDetails(sessionId, extra));
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseCommonArgs(argv);
  const repoRoot = path.resolve(args.repoRoot);
  const transcriptPath = path.resolve(args.sourcePath || "");
  let body = "";
  try {
    body = fs.readFileSync(transcriptPath, "utf8");
  } catch (error) {
    recordFinalHookStatus(repoRoot, args.hookEvent, "pipeline_failed", args.sessionId, {
      reason: "transcript_read_failed",
      error: error.message
    });
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  const flushBody = reduceTranscriptForFlush(body);
  const flushDate = (process.env.CODEX_MEMORY_COMPILER_FLUSH_DATE || "").trim();
  const testDelay = (process.env.CODEX_MEMORY_COMPILER_PIPELINE_TEST_DELAY_SEC || "").trim();
  if (testDelay) {
    await new Promise((resolve) => setTimeout(resolve, Number.parseFloat(testDelay) * 1000));
  }

  if (process.env.CODEX_MEMORY_COMPILER_STUB_RESPONSE) {
    const entryDate = flushDate || isoDateToday();
    appendEntry(repoRoot, entryDate, args.title, transcriptPath, flushBody, { sessionId: args.sessionId });
    await replayPendingMain(["--repo-root", repoRoot]);
    const status = await compileMain(["--repo-root", repoRoot]);
    recordFinalHookStatus(
      repoRoot,
      args.hookEvent,
      status === 0 ? "pipeline_completed" : "pipeline_failed",
      args.sessionId,
      status === 0 ? {} : { stage: "compile" }
    );
    return status;
  }

  const flushCommand = [FLUSH_SCRIPT, "--repo-root", repoRoot, "--title", args.title, "--source-path", transcriptPath];
  if (args.sessionId) {
    flushCommand.push("--session-id", args.sessionId);
  }
  if (flushDate) {
    flushCommand.push("--date", flushDate);
  }
  let result = runCommand(flushCommand, repoRoot, flushBody);
  if (result.status !== 0) {
    recordFinalHookStatus(repoRoot, args.hookEvent, "pipeline_failed", args.sessionId, {
      stage: "flush",
      error: result.error || result.signal || result.stderr.trim().split("\n").at(-1) || "subprocess_nonzero_exit"
    });
    return result.status;
  }

  result = runCommand([REPLAY_PENDING_SCRIPT, "--repo-root", repoRoot], repoRoot);
  if (result.status !== 0) {
    recordFinalHookStatus(repoRoot, args.hookEvent, "pipeline_failed", args.sessionId, {
      stage: "replay_pending",
      error: result.error || result.signal || result.stderr.trim().split("\n").at(-1) || "subprocess_nonzero_exit"
    });
    return result.status;
  }

  result = runCommand([COMPILE_SCRIPT, "--repo-root", repoRoot], repoRoot);
  recordFinalHookStatus(
    repoRoot,
    args.hookEvent,
    result.status === 0 ? "pipeline_completed" : "pipeline_failed",
    args.sessionId,
    result.status === 0
      ? {}
      : {
          stage: "compile",
          error: result.error || result.signal || result.stderr.trim().split("\n").at(-1) || "subprocess_nonzero_exit"
        }
  );
  return result.status;
}

export const mainFromCli = main;

if (isMainModule(import.meta.url)) {
  process.exit(await main());
}

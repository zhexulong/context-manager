#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";

import { recordHookStatus } from "../../scripts/lib/runtime_status.mjs";
import { ensureDirectory, fileUrlForPath, slugify, timestampNow } from "../../scripts/lib/utils.mjs";

function snapshotDir(repoRoot) {
  return ensureDirectory(path.join(repoRoot, "reports", "runtime", "transcript-snapshots"));
}

function snapshotTranscript(repoRoot, transcriptPath, hookName, sessionId) {
  const label = slugify(sessionId || path.basename(transcriptPath, path.extname(transcriptPath)) || hookName);
  const filename = `${timestampNow().replaceAll(":", "-")}-${hookName.toLowerCase()}-${label}.md`;
  const target = path.join(snapshotDir(repoRoot), filename);
  fs.copyFileSync(transcriptPath, target);
  return target;
}

function pipelineCommand(pipelineScript, repoRoot, title, sourcePath, hookName, sessionId) {
  const command = [pipelineScript, "--repo-root", repoRoot, "--title", title, "--source-path", sourcePath, "--hook-event", hookName];
  if (sessionId) {
    command.push("--session-id", sessionId);
  }
  return command;
}

export async function runPipelineHook({
  repoRoot,
  title,
  transcriptPath,
  hookName,
  sessionId,
  pipelineScript
}) {
  const command = pipelineCommand(pipelineScript, repoRoot, title, transcriptPath, hookName, sessionId);
  if (process.env.CODEX_MEMORY_COMPILER_SYNC_FLUSH === "1") {
    if (process.env.CODEX_MEMORY_COMPILER_STUB_RESPONSE) {
      const module = await import(fileUrlForPath(pipelineScript));
      return module.main(command.slice(1));
    }
    const result = spawnSync(process.execPath, command, {
      encoding: "utf8",
      cwd: repoRoot,
      env: process.env
    });
    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    return result.status ?? 1;
  }

  let snapshotPath;
  try {
    snapshotPath = snapshotTranscript(repoRoot, transcriptPath, hookName, sessionId);
  } catch (error) {
    recordHookStatus(repoRoot, hookName, "pipeline_failed", {
      reason: "transcript_snapshot_failed",
      error: error.message
    });
    return 1;
  }

  const asyncCommand = pipelineCommand(pipelineScript, repoRoot, title, snapshotPath, hookName, sessionId);
  const child = spawn(process.execPath, asyncCommand, {
    cwd: repoRoot,
    stdio: "ignore",
    env: process.env,
    detached: true
  });
  child.unref();
  recordHookStatus(repoRoot, hookName, "pipeline_spawned", {
    session_id: sessionId ?? null,
    snapshot_path: snapshotPath
  });
  return 0;
}

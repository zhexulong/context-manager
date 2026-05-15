#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { main as runPipelineMain } from "./run_pipeline.mjs";
import { isMainModule } from "./lib/utils.mjs";

async function withTemporaryEnv(pairs, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(pairs)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

export async function main() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "context-manager-e2e-"));
  const env = {
    CODEX_MEMORY_COMPILER_SYNC_FLUSH: "1",
    CODEX_MEMORY_COMPILER_FLUSH_DATE: "2026-05-14",
    CODEX_MEMORY_COMPILER_STUB_RESPONSE: JSON.stringify({
      decisions: ["Keep query optional."],
      workflows: ["Run compile after flush."],
      conventions: ["Keep scripts in scripts/."],
      notes: []
    })
  };

  const transcript = path.join(repo, "transcript.md");
  fs.writeFileSync(transcript, "# Transcript\n\nWe decided to keep query optional.\n", "utf8");
  const preStatus = await withTemporaryEnv(env, () =>
    runPipelineMain(["--repo-root", repo, "--title", "Pre-Compact Capture", "--source-path", transcript])
  );
  if (preStatus !== 0) {
    throw new Error("Pre-compact pipeline failed");
  }

  const workingMemory = path.join(repo, "working-memory", "2026-05-14.md");
  const guidanceIndex = path.join(repo, "guidance", "index.md");
  if (!fs.existsSync(workingMemory) || !fs.existsSync(guidanceIndex)) {
    throw new Error("Pipeline did not create working-memory and guidance outputs");
  }
  const guidanceText = fs.readFileSync(guidanceIndex, "utf8");
  if (!guidanceText.includes("Guidance Index")) {
    throw new Error("Guidance index is missing expected header");
  }

  const stopTranscript = path.join(repo, "stop-transcript.md");
  fs.writeFileSync(stopTranscript, "# Transcript\n\nKeep scripts in scripts/.\n", "utf8");
  const stopStatus = await withTemporaryEnv(env, () =>
    runPipelineMain(["--repo-root", repo, "--title", "Session-End Capture", "--source-path", stopTranscript])
  );
  if (stopStatus !== 0) {
    throw new Error("Stop pipeline failed");
  }

  const workingMemoryText = fs.readFileSync(workingMemory, "utf8");
  if (!workingMemoryText.includes("Pre-Compact Capture") || !workingMemoryText.includes("Session-End Capture")) {
    throw new Error("Working memory is missing expected captured sections");
  }

  process.stdout.write("E2E smoke passed\n");
  process.stdout.write(`Repo: ${repo}\n`);
  process.stdout.write(`Working memory: ${workingMemory}\n`);
  process.stdout.write(`Guidance index: ${guidanceIndex}\n`);
  return 0;
}

export const mainFromCli = main;

if (isMainModule(import.meta.url)) {
  try {
    process.exit(await main());
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

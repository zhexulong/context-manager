#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { appendEntry, markPendingRetryFailure, pendingFlushDir } from "./flush.mjs";
import { isMainModule, parseCommonArgs } from "./lib/utils.mjs";

function queuedAtKey(payload, pendingFile) {
  return `${payload.queued_at || ""}\u0000${pendingFile}`;
}

function readPendingPayload(pendingFile) {
  try {
    return JSON.parse(fs.readFileSync(pendingFile, "utf8"));
  } catch (error) {
    process.stderr.write(`Skipping invalid pending capture ${pendingFile}: ${error.message}\n`);
    return null;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseCommonArgs(argv);
  const repoRoot = path.resolve(args.repoRoot);
  const queueDir = pendingFlushDir(repoRoot);
  const pendingEntries = fs
    .readdirSync(queueDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(queueDir, entry.name))
    .map((pendingFile) => ({ pendingFile, payload: readPendingPayload(pendingFile) }))
    .filter(({ payload }) => payload !== null)
    .sort((left, right) => queuedAtKey(left.payload, left.pendingFile).localeCompare(queuedAtKey(right.payload, right.pendingFile)));

  let replayed = 0;
  let remaining = 0;

  for (const { pendingFile, payload } of pendingEntries) {
    const outputPath = appendEntry(
      repoRoot,
      payload.entry_date,
      payload.title,
      payload.source_path || "",
      payload.body,
      { sessionId: payload.session_id || null }
    );
    if (outputPath === null) {
      markPendingRetryFailure(pendingFile);
      remaining += 1;
      continue;
    }
    fs.unlinkSync(pendingFile);
    replayed += 1;
  }

  process.stdout.write(`Replayed ${replayed} pending capture(s); ${remaining} remaining.\n`);
  return 0;
}

export const mainFromCli = main;

if (isMainModule(import.meta.url)) {
  process.exit(await main());
}

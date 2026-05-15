import fs from "node:fs";
import path from "node:path";

import { ensureDirectory, timestampNow } from "./utils.mjs";

export function runtimeDir(repoRoot) {
  return ensureDirectory(path.join(repoRoot, "reports", "runtime"));
}

export function hookStatusPath(repoRoot) {
  return path.join(runtimeDir(repoRoot), "hook-status.json");
}

export function hookEventsPath(repoRoot) {
  return path.join(runtimeDir(repoRoot), "hook-events.jsonl");
}

export function recordHookStatus(repoRoot, eventName, status, details = null) {
  const timestamp = timestampNow();
  const payload = {
    event_name: eventName,
    status,
    timestamp
  };
  if (details) {
    payload.details = details;
  }

  const statusFile = hookStatusPath(repoRoot);
  let current = {};
  if (fs.existsSync(statusFile)) {
    try {
      current = JSON.parse(fs.readFileSync(statusFile, "utf8"));
    } catch {
      current = {};
    }
  }
  current[eventName] = {
    last_status: status,
    last_seen_at: timestamp,
    details: details ?? {}
  };
  fs.writeFileSync(statusFile, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  fs.appendFileSync(hookEventsPath(repoRoot), `${JSON.stringify(payload)}\n`, "utf8");
}

#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

import { codexHomeDir, installGuidanceSkill } from "./activate_hooks.mjs";
import { ensureDirectory, isMainModule, parseCommonArgs } from "./lib/utils.mjs";

const DEFAULT_LEGACY_BASENAME = "codex-memory-compiler";
const ROLLOUT_ROOTS = ["sessions", "archived_sessions"];

function parseArgs(argv) {
  const common = parseCommonArgs(argv);
  const args = {
    repoRoot: path.resolve(common.repoRoot),
    from: null,
    codexHome: codexHomeDir()
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--from" && value) {
      args.from = path.resolve(value);
      index += 1;
    } else if (key === "--codex-home" && value) {
      args.codexHome = path.resolve(value);
      index += 1;
    }
  }
  return args;
}

function legacyRepoRoot(repoRoot, configuredFrom) {
  if (configuredFrom) {
    return configuredFrom;
  }
  return path.join(path.dirname(repoRoot), DEFAULT_LEGACY_BASENAME);
}

function rolloutFiles(codexHome) {
  const files = [];
  for (const rootName of ROLLOUT_ROOTS) {
    const root = path.join(codexHome, rootName);
    if (!fs.existsSync(root)) {
      continue;
    }
    const stack = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const entryPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(entryPath);
        } else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
          files.push(entryPath);
        }
      }
    }
  }
  return files.sort();
}

function indexedRolloutFiles(codexHome, fromRepoRoot) {
  const dbPath = path.join(codexHome, "state_5.sqlite");
  if (!fs.existsSync(dbPath)) {
    return null;
  }
  const db = openStateDb(dbPath);
  try {
    return db
      .prepare("select rollout_path from threads where cwd = ? order by updated_at_ms desc")
      .all(fromRepoRoot)
      .map((row) => row.rollout_path)
      .filter(Boolean)
      .filter((filePath) => fs.existsSync(filePath));
  } finally {
    db.close();
  }
}

function rewriteRolloutCwd(filePath, fromRepoRoot, toRepoRoot) {
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/u);
  let changed = false;
  const nextLines = lines.map((line) => {
    if (!line.trim()) {
      return line;
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return line;
    }
    if (parsed?.type !== "session_meta" || parsed?.payload?.cwd !== fromRepoRoot) {
      return line;
    }
    parsed.payload.cwd = toRepoRoot;
    changed = true;
    return JSON.stringify(parsed);
  });
  if (!changed) {
    return false;
  }
  fs.writeFileSync(filePath, `${nextLines.join("\n").replace(/\n+$/u, "")}\n`, "utf8");
  return true;
}

function openStateDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec("pragma busy_timeout = 5000");
  return db;
}

function migrateStateDb(codexHome, fromRepoRoot, toRepoRoot) {
  const dbPath = path.join(codexHome, "state_5.sqlite");
  if (!fs.existsSync(dbPath)) {
    return 0;
  }
  const db = openStateDb(dbPath);
  try {
    const result = db.prepare("update threads set cwd = ? where cwd = ?").run(toRepoRoot, fromRepoRoot);
    return Number(result.changes) || 0;
  } finally {
    db.close();
  }
}

function rewriteSectionHeader(text, tableName, fromRepoRoot, toRepoRoot) {
  const fromHeader = `[${tableName}."${fromRepoRoot}"]`;
  const toHeader = `[${tableName}."${toRepoRoot}"]`;
  if (!text.includes(fromHeader)) {
    return text;
  }
  if (text.includes(toHeader)) {
    return removeConfigSection(text, fromHeader);
  }
  return text.replace(fromHeader, toHeader);
}

function removeConfigSection(text, header) {
  const escapedHeader = header.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`(^|\\n)${escapedHeader}\\n[\\s\\S]*?(?=(\\n\\[[^\\n]+\\])|$)`, "u");
  return text.replace(pattern, (match, prefix) => prefix).trimEnd();
}

function cleanupHomeConfig(codexHome, fromRepoRoot, toRepoRoot) {
  const configPath = path.join(codexHome, "config.toml");
  if (!fs.existsSync(configPath)) {
    return false;
  }
  const oldHookPrefix = `${fromRepoRoot}/.codex/config.toml:`;
  let text = fs.readFileSync(configPath, "utf8");
  const original = text;
  text = rewriteSectionHeader(text, "projects", fromRepoRoot, toRepoRoot);
  const hookStateHeaders = Array.from(
    text.matchAll(/^\[hooks\.state\."([^"]+)"\]$/gmu),
    (match) => match[1]
  );
  for (const key of hookStateHeaders) {
    if (!key.startsWith(oldHookPrefix)) {
      continue;
    }
    text = removeConfigSection(text, `[hooks.state."${key}"]`);
  }
  if (text !== original) {
    fs.writeFileSync(configPath, `${text.trimEnd()}\n`, "utf8");
    return true;
  }
  return false;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const repoRoot = args.repoRoot;
  const fromRepoRoot = legacyRepoRoot(repoRoot, args.from);
  if (fromRepoRoot === repoRoot) {
    process.stderr.write("Legacy repo root and current repo root must differ.\n");
    return 1;
  }

  ensureDirectory(args.codexHome);

  const rolloutCandidates = indexedRolloutFiles(args.codexHome, fromRepoRoot) ?? rolloutFiles(args.codexHome);
  let updatedRollouts = 0;
  for (const rolloutPath of rolloutCandidates) {
    if (rewriteRolloutCwd(rolloutPath, fromRepoRoot, repoRoot)) {
      updatedRollouts += 1;
    }
  }
  const updatedThreads = migrateStateDb(args.codexHome, fromRepoRoot, repoRoot);
  const configUpdated = cleanupHomeConfig(args.codexHome, fromRepoRoot, repoRoot);
  const skillDir = installGuidanceSkill();

  process.stdout.write(
    [
      `Migrated rollout files: ${updatedRollouts}`,
      `Migrated sqlite threads: ${updatedThreads}`,
      `Updated home config: ${configUpdated ? "yes" : "no"}`,
      `Refreshed guidance skill: ${skillDir}`
    ].join("\n") + "\n"
  );
  return 0;
}

export const mainFromCli = main;

if (isMainModule(import.meta.url)) {
  process.exit(await main());
}

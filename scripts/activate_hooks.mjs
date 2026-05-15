#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { ensureDirectory, isMainModule, moduleDir, parseCommonArgs } from "./lib/utils.mjs";

const BLOCK_BEGIN = "# BEGIN CONTEXT-MANAGER HOOK TRUST";
const BLOCK_END = "# END CONTEXT-MANAGER HOOK TRUST";
const SKILL_NAME = "guidance-recall";
const PACKAGE_ROOT = path.resolve(moduleDir(import.meta.url), "..");
const HOOK_STANZAS = [
  [
    "[[hooks.SessionStart]]",
    'matcher = "startup|resume|clear"',
    "",
    "[[hooks.SessionStart.hooks]]",
    'type = "command"',
    'command = "node hooks/session_start.mjs --repo-root ."',
    "timeout = 10"
  ].join("\n"),
  [
    "[[hooks.PreCompact]]",
    "",
    "[[hooks.PreCompact.hooks]]",
    'type = "command"',
    'command = "node hooks/pre_compact.mjs --repo-root ."',
    "timeout = 20"
  ].join("\n"),
  [
    "[[hooks.UserPromptSubmit]]",
    "",
    "[[hooks.UserPromptSubmit.hooks]]",
    'type = "command"',
    'command = "node hooks/user_prompt_submit.mjs --repo-root ."',
    "timeout = 10"
  ].join("\n"),
  [
    "[[hooks.Stop]]",
    "",
    "[[hooks.Stop.hooks]]",
    'type = "command"',
    'command = "node hooks/stop.mjs --repo-root ."',
    "timeout = 20"
  ].join("\n")
];

function escapeForRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function replaceManagedBlock(text) {
  const pattern = new RegExp(
    `\\n?${escapeForRegex(BLOCK_BEGIN)}\\n.*?\\n${escapeForRegex(BLOCK_END)}\\n?`,
    "su"
  );
  return text.replace(pattern, "\n").trimEnd();
}

function ensureHooksFeatureEnabled(text) {
  const featuresMatch = text.match(/(^|\n)\[features\]\n/);
  if (!featuresMatch) {
    const prefix = text.trimEnd();
    return [prefix, "[features]", "hooks = true"].filter(Boolean).join("\n\n").trimEnd();
  }

  const sectionStart = featuresMatch.index + featuresMatch[0].length;
  const remainder = text.slice(sectionStart);
  const nextSectionMatch = remainder.match(/\n\[[^\n]+\]/);
  const sectionEnd = nextSectionMatch ? sectionStart + nextSectionMatch.index : text.length;
  const block = text.slice(sectionStart, sectionEnd);
  const normalizedBlock = /^hooks\s*=/m.test(block)
    ? block.replace(/^hooks\s*=.*$/m, "hooks = true")
    : `${block.trimEnd()}\n${block.trim() ? "" : ""}hooks = true\n`;
  return `${text.slice(0, sectionStart)}${normalizedBlock}${text.slice(sectionEnd)}`.trimEnd();
}

function ensureHooksTable(text) {
  if (/(^|\n)\[hooks\]\n/.test(`${text}\n`)) {
    return text.trimEnd();
  }
  return [text.trimEnd(), "[hooks]"].filter(Boolean).join("\n\n").trimEnd();
}

function replaceHookBlock(text, eventName, block) {
  const topLevelHeader = `[[hooks.${eventName}]]`;
  const escapedHeader = escapeForRegex(topLevelHeader);
  const pattern = new RegExp(
    `(^|\\n)${escapedHeader}[\\s\\S]*?(?=(\\n\\[\\[hooks\\.[A-Z][^.]+\\]\\])|$)`,
    "u"
  );
  if (!pattern.test(text)) {
    return null;
  }
  return text.replace(pattern, (match, prefix) => `${prefix}${block}`);
}

function ensureHookStanzas(text) {
  let output = ensureHooksTable(text);
  const required = [
    { eventName: "SessionStart", marker: /\[\[hooks\.SessionStart\]\]/, block: HOOK_STANZAS[0] },
    { eventName: "PreCompact", marker: /\[\[hooks\.PreCompact\]\]/, block: HOOK_STANZAS[1] },
    { eventName: "UserPromptSubmit", marker: /\[\[hooks\.UserPromptSubmit\]\]/, block: HOOK_STANZAS[2] },
    { eventName: "Stop", marker: /\[\[hooks\.Stop\]\]/, block: HOOK_STANZAS[3] }
  ];
  for (const { eventName, marker, block } of required) {
    if (marker.test(output)) {
      output = replaceHookBlock(output, eventName, block) || output;
    } else {
      output = `${output}\n\n${block}`.trimEnd();
    }
  }
  return `${output}\n`;
}

function desiredProjectConfig() {
  return ensureHookStanzas(ensureHooksFeatureEnabled(""));
}

function codexHomeDir() {
  const configured = process.env.CODEX_MEMORY_COMPILER_CODEX_HOME;
  if (configured) {
    return path.resolve(configured);
  }
  return path.join(os.homedir(), ".codex");
}

function installGuidanceSkill() {
  const sourceDir = path.join(PACKAGE_ROOT, "skills", SKILL_NAME);
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    throw new Error(`Missing guidance skill source: ${sourceDir}`);
  }
  const skillsRoot = ensureDirectory(path.join(codexHomeDir(), "skills"));
  const targetDir = path.join(skillsRoot, SKILL_NAME);
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.cpSync(sourceDir, targetDir, { recursive: true });
  return targetDir;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseCommonArgs(argv);
  const repoRoot = path.resolve(args.repoRoot);
  const configPath = path.resolve(repoRoot, ".codex", "config.toml");

  ensureDirectory(path.dirname(configPath));
  const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  const cleaned = replaceManagedBlock(existing);
  const provisioned = existing ? ensureHookStanzas(ensureHooksFeatureEnabled(cleaned)) : desiredProjectConfig();
  if (provisioned !== existing) {
    fs.writeFileSync(configPath, provisioned, "utf8");
  }
  const skillDir = installGuidanceSkill();

  process.stdout.write(
    [
      `Repo-local hooks ready in ${configPath}`,
      `Guidance skill installed in ${skillDir}`,
      "Codex will still ask for one-time hook review on first run.",
      "Accepted trust is managed by Codex in ~/.codex/config.toml."
    ].join("\n") + "\n"
  );
  return 0;
}

export const mainFromCli = main;

if (isMainModule(import.meta.url)) {
  process.exit(await main());
}

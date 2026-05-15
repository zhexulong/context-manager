#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  extractMarkdownLinks,
  isMainModule,
  isExternalLink,
  markdownHasAnchor,
  markdownFiles,
  parseCommonArgs,
  referencedGuidancePages,
  splitLinkTarget
} from "./lib/utils.mjs";

function exemptGuidancePages(guidanceRoot) {
  return new Set([
    path.resolve(path.join(guidanceRoot, "index.md")),
    path.resolve(path.join(guidanceRoot, "decisions", "index.md")),
    path.resolve(path.join(guidanceRoot, "workflows", "index.md")),
    path.resolve(path.join(guidanceRoot, "conventions", "index.md"))
  ]);
}

function brokenLinks(guidanceRoot) {
  const issues = [];
  for (const page of markdownFiles(guidanceRoot)) {
    const text = fs.readFileSync(page, "utf8");
    for (const [, target] of extractMarkdownLinks(text)) {
      const [pathPart, anchor] = splitLinkTarget(target);
      if (!pathPart || isExternalLink(pathPart)) {
        continue;
      }
      const targetPath = path.resolve(path.dirname(page), pathPart);
      if (!fs.existsSync(targetPath)) {
        issues.push(`Broken link in ${path.relative(guidanceRoot, page)}: ${target}`);
        continue;
      }
      if (anchor && targetPath.endsWith(".md")) {
        const targetText = fs.readFileSync(targetPath, "utf8");
        if (!markdownHasAnchor(targetText, anchor)) {
          issues.push(`Broken anchor in ${path.relative(guidanceRoot, page)}: ${target}`);
        }
      }
    }
  }
  return issues;
}

function orphanGuidancePages(guidanceRoot) {
  const pages = markdownFiles(guidanceRoot);
  const referenced = referencedGuidancePages(guidanceRoot);
  const exempt = exemptGuidancePages(guidanceRoot);
  const issues = [];
  for (const page of pages) {
    const resolved = path.resolve(page);
    if (exempt.has(resolved)) {
      continue;
    }
    if (!referenced.has(resolved)) {
      issues.push(`Orphan guidance page: ${path.relative(guidanceRoot, page)}`);
    }
  }
  return issues;
}

function sparseGuidancePages(guidanceRoot, minimumWords) {
  const issues = [];
  const exempt = exemptGuidancePages(guidanceRoot);
  for (const page of markdownFiles(guidanceRoot)) {
    if (exempt.has(path.resolve(page))) {
      continue;
    }
    const words = fs.readFileSync(page, "utf8").split(/\s+/u).filter(Boolean);
    if (words.length < minimumWords) {
      issues.push(`Sparse guidance page: ${path.relative(guidanceRoot, page)} (${words.length} words)`);
    }
  }
  return issues;
}

function staleGuidancePages(guidanceRoot, staleDays) {
  if (!Number.isFinite(staleDays)) {
    return [];
  }
  const cutoff = Date.now() - staleDays * 24 * 60 * 60 * 1000;
  const issues = [];
  const exempt = exemptGuidancePages(guidanceRoot);
  for (const page of markdownFiles(guidanceRoot)) {
    if (exempt.has(path.resolve(page))) {
      continue;
    }
    const modifiedAt = fs.statSync(page).mtimeMs;
    if (modifiedAt < cutoff) {
      issues.push(
        `Stale guidance page: ${path.relative(guidanceRoot, page)} (last updated ${new Date(modifiedAt)
          .toISOString()
          .slice(0, 10)})`
      );
    }
  }
  return issues;
}

function contradictionIssues(guidanceRoot) {
  const issues = [];
  const exempt = exemptGuidancePages(guidanceRoot);
  for (const page of markdownFiles(guidanceRoot)) {
    if (exempt.has(path.resolve(page))) {
      continue;
    }
    const positives = new Set();
    const negatives = new Set();
    for (const rawLine of fs.readFileSync(page, "utf8").split(/\r?\n/u)) {
      const line = rawLine.trim().toLowerCase();
      if (!line || line.startsWith("#")) {
        continue;
      }
      const normalized = line.replace(/[.!?]+$/u, "");
      if (normalized.startsWith("always ")) {
        positives.add(normalized.slice("always ".length).trim());
      }
      if (normalized.startsWith("never ")) {
        negatives.add(normalized.slice("never ".length).trim());
      }
    }

    for (const statement of [...positives].filter((item) => negatives.has(item)).sort()) {
      issues.push(
        `Contradiction in ${path.relative(guidanceRoot, page)}: both positive and negative guidance for '${statement}'`
      );
    }
  }
  return issues;
}

function pendingFlushIssues(repoRoot) {
  const pendingDir = path.join(repoRoot, "reports", "pending-flush");
  if (!fs.existsSync(pendingDir)) {
    return [];
  }
  const issues = [];
  for (const entry of fs.readdirSync(pendingDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const pendingFile = path.join(pendingDir, entry.name);
    try {
      const payload = JSON.parse(fs.readFileSync(pendingFile, "utf8"));
      const details = [`attempts=${payload.attempt_count ?? 0}`];
      if (payload.last_error) {
        details.push(`last_error=${payload.last_error}`);
      }
      issues.push(`Pending flush capture: ${path.relative(repoRoot, pendingFile)} (${details.join(", ")})`);
    } catch {
      issues.push(`Pending flush capture: ${path.relative(repoRoot, pendingFile)} (invalid json)`);
    }
  }
  return issues.sort();
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseCommonArgs(argv);
  const repoRoot = path.resolve(args.repoRoot);
  const guidanceRoot = path.join(repoRoot, "guidance");
  const issues = [
    ...pendingFlushIssues(repoRoot),
    ...brokenLinks(guidanceRoot),
    ...orphanGuidancePages(guidanceRoot),
    ...sparseGuidancePages(guidanceRoot, args.sparseWords ?? 8),
    ...staleGuidancePages(guidanceRoot, args.staleDays),
    ...contradictionIssues(guidanceRoot)
  ];

  if (issues.length > 0) {
    for (const issue of issues) {
      process.stdout.write(`${issue}\n`);
    }
    return 1;
  }
  process.stdout.write("No lint issues found.\n");
  return 0;
}

export const mainFromCli = main;

if (isMainModule(import.meta.url)) {
  process.exit(await main());
}

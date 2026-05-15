#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { runCodexStructured } from "./lib/llm.mjs";
import { normalizeWorkingMemoryFile } from "./lib/working_memory.mjs";
import {
  ensureDirectory,
  isMainModule,
  isoDateToday,
  parseCommonArgs,
  readStdinText,
  renderPromptTemplate,
  slugify,
  timestampNow
} from "./lib/utils.mjs";

const STRUCTURED_SECTION_ORDER = ["Decisions", "Workflows", "Conventions", "Notes"];
const PENDING_CAPTURE_ERROR = "llm_unavailable_or_invalid_output";
const DEFAULT_FLUSH_PROMPT = `Extract only durable, high-signal working memory from the conversation text below.

Return JSON only. Use these rules:
- decisions: choices, tradeoffs, selected approaches
- workflows: repeatable steps or procedures
- conventions: stable defaults, rules, naming or path conventions
- notes: only useful residual items that do not fit the other categories
- Ignore routine file reads, tool chatter, and trivial back-and-forth
- Prefer concise standalone statements
- If a category has nothing useful, return an empty array

Conversation text:
{body}
`;

function normalizeCandidate(text) {
  let stripped = text.trim();
  if (stripped.startsWith("- ") || stripped.startsWith("* ")) {
    stripped = stripped.slice(2).trim();
  }
  if (stripped.startsWith("#")) {
    stripped = stripped.replace(/^#+/u, "").trim();
  }
  return stripped;
}

function renderStructuredSections(sections) {
  const lines = [];
  for (const sectionName of STRUCTURED_SECTION_ORDER) {
    const items = sections[sectionName] || [];
    if (items.length === 0) {
      continue;
    }
    lines.push(`### ${sectionName}`, "");
    for (const item of items.slice(0, 5)) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function sessionMarker(sessionId) {
  return `<!-- context-manager: session_id=${sessionId} -->`;
}

function sessionAnchorId(title, sessionId) {
  if (!sessionId) {
    return null;
  }
  return slugify(`${title}-${sessionId}`);
}

function sessionAnchorTag(title, sessionId) {
  const anchorId = sessionAnchorId(title, sessionId);
  return anchorId ? `<a id="${anchorId}"></a>` : null;
}

function splitWorkingMemorySections(text) {
  const sections = [];
  if (!text.trim()) {
    return sections;
  }
  const lines = text.split(/\r?\n/u);
  let currentStart = null;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].startsWith("## ")) {
      if (currentStart !== null) {
        sections.push({
          start: currentStart,
          end: index,
          text: lines.slice(currentStart, index).join("\n").trimEnd()
        });
      }
      currentStart = index;
    }
  }
  if (currentStart !== null) {
    sections.push({
      start: currentStart,
      end: lines.length,
      text: lines.slice(currentStart).join("\n").trimEnd()
    });
  }
  return sections;
}

function replaceSessionSection(existing, block, sessionId) {
  if (!sessionId) {
    return null;
  }
  const marker = sessionMarker(sessionId);
  const lines = existing.split(/\r?\n/u);
  for (const section of splitWorkingMemorySections(existing)) {
    if (!section.text.includes(marker)) {
      continue;
    }
    if (section.text === block) {
      return existing.trimEnd();
    }
    const replaced = [...lines.slice(0, section.start), ...block.split("\n"), ...lines.slice(section.end)]
      .join("\n")
      .trimEnd();
    return replaced;
  }
  return null;
}

export function pendingFlushDir(repoRoot) {
  return ensureDirectory(path.join(repoRoot, "reports", "pending-flush"));
}

export function pendingFlushPath(repoRoot, entryDate, title, sourcePath, body, sessionId = null) {
  const dedupeKey = [entryDate, title, sourcePath || "", sessionId || "", body].join("\n");
  const digest = crypto.createHash("sha256").update(dedupeKey, "utf8").digest("hex").slice(0, 12);
  return path.join(pendingFlushDir(repoRoot), `${entryDate}-${slugify(title)}-${digest}.json`);
}

function normalizePendingPayload(payload) {
  return {
    ...payload,
    attempt_count: payload.attempt_count ?? 0,
    last_attempt_at: payload.last_attempt_at ?? null,
    last_error: payload.last_error ?? PENDING_CAPTURE_ERROR
  };
}

function writePendingPayload(targetPath, payload) {
  fs.writeFileSync(targetPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function queuePendingCapture(repoRoot, entryDate, title, sourcePath, body, sessionId = null) {
  const targetPath = pendingFlushPath(repoRoot, entryDate, title, sourcePath, body, sessionId);
  if (fs.existsSync(targetPath)) {
    const payload = normalizePendingPayload(JSON.parse(fs.readFileSync(targetPath, "utf8")));
    if (!payload.session_id && sessionId) {
      payload.session_id = sessionId;
    }
    writePendingPayload(targetPath, payload);
    return targetPath;
  }

  const payload = normalizePendingPayload({
    entry_date: entryDate,
    title,
    source_path: sourcePath,
    session_id: sessionId,
    body,
    queued_at: timestampNow()
  });
  writePendingPayload(targetPath, payload);
  return targetPath;
}

export function markPendingRetryFailure(pendingFile) {
  const payload = normalizePendingPayload(JSON.parse(fs.readFileSync(pendingFile, "utf8")));
  payload.attempt_count = Number(payload.attempt_count || 0) + 1;
  payload.last_attempt_at = timestampNow();
  payload.last_error = PENDING_CAPTURE_ERROR;
  writePendingPayload(pendingFile, payload);
}

function llmExtractSections(repoRoot, body) {
  const schema = {
    type: "object",
    properties: {
      decisions: { type: "array", items: { type: "string" } },
      workflows: { type: "array", items: { type: "string" } },
      conventions: { type: "array", items: { type: "string" } },
      notes: { type: "array", items: { type: "string" } }
    },
    required: ["decisions", "workflows", "conventions", "notes"],
    additionalProperties: false
  };
  const prompt = renderPromptTemplate("flush", DEFAULT_FLUSH_PROMPT, { body });
  const result = runCodexStructured(repoRoot, prompt, schema, "flush_extract_sections");
  if (!result) {
    return null;
  }

  const sections = {
    Decisions: [],
    Workflows: [],
    Conventions: [],
    Notes: []
  };
  const mapping = {
    decisions: "Decisions",
    workflows: "Workflows",
    conventions: "Conventions",
    notes: "Notes"
  };

  for (const [key, target] of Object.entries(mapping)) {
    const values = result[key];
    if (!Array.isArray(values)) {
      return null;
    }

    const cleaned = [];
    const seen = new Set();
    for (const value of values) {
      if (typeof value !== "string") {
        continue;
      }
      const normalized = normalizeCandidate(value);
      if (normalized.length < 3) {
        continue;
      }
      const marker = normalized.toLowerCase().replace(/[.!?]+$/u, "");
      if (seen.has(marker)) {
        continue;
      }
      seen.add(marker);
      cleaned.push(normalized);
    }
    sections[target] = cleaned.slice(0, 5);
  }

  return sections;
}

export function appendEntry(repoRoot, entryDate, title, sourcePath, body, options = {}) {
  const sessionId = options.sessionId || null;
  const llmSections = llmExtractSections(repoRoot, body);
  if (llmSections === null) {
    queuePendingCapture(repoRoot, entryDate, title, sourcePath, body, sessionId);
    return null;
  }

  const workingMemoryDir = ensureDirectory(path.join(repoRoot, "working-memory"));
  const targetPath = path.join(workingMemoryDir, `${entryDate}.md`);
  const structuredBody = renderStructuredSections(llmSections);

  const blockLines = [`## ${title}`, ""];
  const anchorTag = sessionAnchorTag(title, sessionId);
  if (anchorTag) {
    blockLines.push(anchorTag, "");
  }
  if (sessionId) {
    blockLines.push(sessionMarker(sessionId), "");
  }
  if (sourcePath) {
    blockLines.push(`Source: \`${sourcePath}\``, "");
  }
  blockLines.push(structuredBody, "");
  const block = blockLines.join("\n").trimEnd();

  const lines = [];
  if (fs.existsSync(targetPath)) {
    const existing = normalizeWorkingMemoryFile(repoRoot, targetPath).trimEnd();
    const replaced = replaceSessionSection(existing, block, sessionId);
    if (replaced !== null) {
      fs.writeFileSync(targetPath, `${replaced}\n`, "utf8");
      return targetPath;
    }
    if (existing.includes(block)) {
      return targetPath;
    }
    if (existing) {
      lines.push(existing, "");
    }
  } else {
    lines.push(`# Working Memory ${entryDate}`, "");
  }
  lines.push(block, "");
  fs.writeFileSync(targetPath, lines.join("\n"), "utf8");
  return targetPath;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseCommonArgs(argv);
  const body = readStdinText().trim();
  if (!body) {
    process.stderr.write("flush.mjs requires non-empty stdin content\n");
    return 1;
  }

  const outputPath = appendEntry(
    path.resolve(args.repoRoot),
    args.date || isoDateToday(),
    args.title || "Session Capture",
    args.sourcePath || "",
    body,
    { sessionId: args.sessionId || null }
  );
  if (outputPath) {
    process.stdout.write(`${outputPath}\n`);
  }
  return 0;
}

export const mainFromCli = main;

if (isMainModule(import.meta.url)) {
  process.exit(await main());
}

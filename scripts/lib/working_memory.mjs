import fs from "node:fs";
import path from "node:path";

const CURRENT_PROJECT_MARKER = "context-manager";
const LEGACY_PROJECT_MARKERS = ["codex-memory-compiler"];
const SESSION_MARKER_RE = /^<!--\s*(?:context-manager|codex-memory-compiler):\s*session_id=([^\s>]+)\s*-->$/u;
const SOURCE_LINE_RE = /^Source: `([^`]+)`$/u;

function splitWorkingMemorySections(text) {
  const sections = [];
  if (!text.trim()) {
    return { preamble: "", sections };
  }
  const lines = text.split(/\r?\n/u);
  let currentStart = null;
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith("## ")) {
      continue;
    }
    if (currentStart !== null) {
      sections.push({
        start: currentStart,
        end: index,
        text: lines.slice(currentStart, index).join("\n").trimEnd()
      });
    }
    currentStart = index;
  }
  if (currentStart !== null) {
    sections.push({
      start: currentStart,
      end: lines.length,
      text: lines.slice(currentStart).join("\n").trimEnd()
    });
  }
  const preamble = currentStart === null ? text.trimEnd() : lines.slice(0, sections[0].start).join("\n").trimEnd();
  return { preamble, sections };
}

function normalizeSourcePath(repoRoot, sourcePath) {
  const normalizedSourcePath = sourcePath.trim();
  if (!normalizedSourcePath || !path.isAbsolute(normalizedSourcePath) || fs.existsSync(normalizedSourcePath)) {
    return normalizedSourcePath;
  }

  const currentRepoRoot = path.resolve(repoRoot);
  const currentRepoParent = path.dirname(currentRepoRoot);
  for (const legacyName of LEGACY_PROJECT_MARKERS) {
    const legacyRepoRoot = path.join(currentRepoParent, legacyName);
    if (
      normalizedSourcePath !== legacyRepoRoot &&
      !normalizedSourcePath.startsWith(`${legacyRepoRoot}${path.sep}`)
    ) {
      continue;
    }
    const candidate = path.join(currentRepoRoot, path.relative(legacyRepoRoot, normalizedSourcePath));
    if (candidate === currentRepoRoot || !candidate.startsWith(`${currentRepoRoot}${path.sep}`)) {
      continue;
    }
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return normalizedSourcePath;
}

function sessionIdForSection(sectionText) {
  for (const rawLine of sectionText.split(/\r?\n/u)) {
    const match = rawLine.trim().match(SESSION_MARKER_RE);
    if (match) {
      return match[1];
    }
  }
  return null;
}

function normalizeSection(repoRoot, sectionText) {
  return sectionText
    .split(/\r?\n/u)
    .map((rawLine) => {
      const trimmed = rawLine.trim();
      const markerMatch = trimmed.match(SESSION_MARKER_RE);
      if (markerMatch) {
        return `<!-- ${CURRENT_PROJECT_MARKER}: session_id=${markerMatch[1]} -->`;
      }
      const sourceMatch = rawLine.match(SOURCE_LINE_RE);
      if (sourceMatch) {
        return `Source: \`${normalizeSourcePath(repoRoot, sourceMatch[1])}\``;
      }
      return rawLine;
    })
    .join("\n")
    .trimEnd();
}

export function normalizeWorkingMemoryText(repoRoot, text) {
  const trimmed = text.trimEnd();
  if (!trimmed) {
    return text;
  }

  const { preamble, sections } = splitWorkingMemorySections(trimmed);
  if (sections.length === 0) {
    return `${normalizeSection(repoRoot, trimmed)}\n`;
  }

  const lastSectionIndexBySessionId = new Map();
  sections.forEach((section, index) => {
    const sessionId = sessionIdForSection(section.text);
    if (sessionId) {
      lastSectionIndexBySessionId.set(sessionId, index);
    }
  });

  const keptSections = sections
    .filter((section, index) => {
      const sessionId = sessionIdForSection(section.text);
      return !sessionId || lastSectionIndexBySessionId.get(sessionId) === index;
    })
    .map((section) => normalizeSection(repoRoot, section.text))
    .filter(Boolean);

  const normalizedPreamble = normalizeSection(repoRoot, preamble).trimEnd();
  const parts = [];
  if (normalizedPreamble) {
    parts.push(normalizedPreamble);
  }
  parts.push(...keptSections);
  return `${parts.join("\n\n").trimEnd()}\n`;
}

export function normalizeWorkingMemoryFile(repoRoot, filePath) {
  const existing = fs.readFileSync(filePath, "utf8");
  const normalized = normalizeWorkingMemoryText(repoRoot, existing);
  if (normalized !== existing) {
    fs.writeFileSync(filePath, normalized, "utf8");
  }
  return normalized;
}

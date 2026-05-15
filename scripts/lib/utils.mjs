import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const MARKDOWN_LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;
const NON_SLUG_CHARS_RE = /[^a-z0-9]+/g;
const HTML_ANCHOR_RE = /<a\s+id="([^"]+)"\s*><\/a>/iu;

export const PROMPTS_DIR_ENV_VAR = "CODEX_MEMORY_COMPILER_PROMPTS_DIR";

export function ensureDirectory(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
  return targetPath;
}

export function promptsDir() {
  const configured = process.env[PROMPTS_DIR_ENV_VAR];
  if (configured) {
    return path.resolve(configured);
  }
  return path.resolve(moduleDir(import.meta.url), "..", "prompts");
}

export function modulePath(importMetaUrl) {
  return fileURLToPath(importMetaUrl);
}

export function moduleDir(importMetaUrl) {
  return path.dirname(modulePath(importMetaUrl));
}

export function fileUrlForPath(targetPath) {
  return pathToFileURL(targetPath).href;
}

export function isMainModule(importMetaUrl, argvPath = process.argv[1]) {
  if (!argvPath) {
    return false;
  }
  return importMetaUrl === fileUrlForPath(path.resolve(argvPath));
}

export function loadPromptTemplate(name, fallback) {
  const templatePath = path.join(promptsDir(), `${name}.md`);
  if (fs.existsSync(templatePath)) {
    return fs.readFileSync(templatePath, "utf8");
  }
  return fallback;
}

export function renderPromptTemplate(name, fallback, values) {
  let output = loadPromptTemplate(name, fallback);
  for (const [key, value] of Object.entries(values)) {
    output = output.replaceAll(`{${key}}`, String(value));
  }
  return output;
}

export function markdownFiles(root) {
  if (!fs.existsSync(root)) {
    return [];
  }

  const results = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(fullPath);
      }
    }
  }
  return results.sort();
}

export function firstHeading(markdownText) {
  for (const line of markdownText.split(/\r?\n/u)) {
    const stripped = line.trim();
    if (stripped.startsWith("#")) {
      return stripped.replace(/^#+/u, "").trim() || null;
    }
  }
  return null;
}

export function relativeLink(fromPath, toPath) {
  return path.relative(path.dirname(fromPath), toPath).split(path.sep).join("/");
}

export function extractMarkdownLinks(markdownText) {
  return Array.from(markdownText.matchAll(MARKDOWN_LINK_RE), (match) => [match[1], match[2]]);
}

export function splitLinkTarget(target) {
  const index = target.indexOf("#");
  if (index === -1) {
    return [target, null];
  }
  return [target.slice(0, index), target.slice(index + 1)];
}

export function isExternalLink(target) {
  return target.includes("://") || target.startsWith("mailto:");
}

export function referencedGuidancePages(guidanceRoot) {
  const referenced = new Set();
  const resolvedGuidanceRoot = path.resolve(guidanceRoot);
  for (const page of markdownFiles(guidanceRoot)) {
    const text = fs.readFileSync(page, "utf8");
    for (const [, target] of extractMarkdownLinks(text)) {
      const [pathPart] = splitLinkTarget(target);
      if (!pathPart || isExternalLink(pathPart)) {
        continue;
      }
      const targetPath = path.resolve(path.dirname(page), pathPart);
      if (targetPath === resolvedGuidanceRoot || targetPath.startsWith(`${resolvedGuidanceRoot}${path.sep}`)) {
        referenced.add(targetPath);
      }
    }
  }
  return referenced;
}

export function slugify(text) {
  const slug = text.toLowerCase().replace(NON_SLUG_CHARS_RE, "-").replace(/^-+|-+$/gu, "");
  return slug || "untitled";
}

export function parseCommonArgs(argv) {
  const args = {
    repoRoot: process.cwd()
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--repo-root" && value) {
      args.repoRoot = path.resolve(value);
      index += 1;
    } else if (key === "--date" && value) {
      args.date = value;
      index += 1;
    } else if (key === "--title" && value) {
      args.title = value;
      index += 1;
    } else if (key === "--source-path" && value) {
      args.sourcePath = value;
      index += 1;
    } else if (key === "--session-id" && value) {
      args.sessionId = value;
      index += 1;
    } else if (key === "--hook-event" && value) {
      args.hookEvent = value;
      index += 1;
    } else if (key === "--stale-days" && value) {
      args.staleDays = Number.parseInt(value, 10);
      index += 1;
    } else if (key === "--sparse-words" && value) {
      args.sparseWords = Number.parseInt(value, 10);
      index += 1;
    }
  }
  return args;
}

function readFdText(fd) {
  const chunks = [];
  const buffer = Buffer.allocUnsafe(64 * 1024);
  while (true) {
    try {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    } catch (error) {
      if (error && error.code === "EAGAIN") {
        continue;
      }
      throw error;
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function readJsonStdin() {
  return JSON.parse(readFdText(0));
}

export function readStdinText() {
  return readFdText(0);
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

export function isoDateToday(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function timestampNow(date = new Date()) {
  return `${isoDateToday(date)}T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

export function truncateUtf8(text, maxBytes) {
  if (maxBytes <= 0) {
    return "";
  }
  let output = "";
  let used = 0;
  for (const char of text) {
    const next = Buffer.byteLength(char, "utf8");
    if (used + next > maxBytes) {
      break;
    }
    output += char;
    used += next;
  }
  return output;
}

function markdownHeadingSlug(line) {
  const stripped = line.trim();
  if (!stripped.startsWith("#")) {
    return null;
  }
  return slugify(stripped.replace(/^#+/u, "").trim()) || null;
}

function markdownHeadingLevel(line) {
  const match = line.trim().match(/^(#+)\s/u);
  return match ? match[1].length : null;
}

export function markdownExplicitAnchorId(line) {
  const match = line.trim().match(HTML_ANCHOR_RE);
  return match ? match[1] : null;
}

function locateMarkdownAnchor(lines, anchor) {
  for (let index = 0; index < lines.length; index += 1) {
    if (markdownHeadingSlug(lines[index]) === anchor) {
      return {
        start: index,
        level: markdownHeadingLevel(lines[index])
      };
    }
    if (markdownExplicitAnchorId(lines[index]) !== anchor) {
      continue;
    }
    for (let headingIndex = index + 1; headingIndex < lines.length; headingIndex += 1) {
      const headingLevel = markdownHeadingLevel(lines[headingIndex]);
      if (headingLevel === null) {
        continue;
      }
      return {
        start: headingIndex,
        level: headingLevel
      };
    }
    return {
      start: index,
      level: Number.POSITIVE_INFINITY
    };
  }
  return null;
}

export function markdownHasAnchor(markdownText, anchor) {
  if (!anchor) {
    return true;
  }
  return locateMarkdownAnchor(markdownText.split(/\r?\n/u), anchor) !== null;
}

export function extractMarkdownSection(markdownText, anchor) {
  if (!anchor) {
    return markdownText.trim();
  }
  const lines = markdownText.split(/\r?\n/u);
  const location = locateMarkdownAnchor(lines, anchor);
  if (!location || location.level === null) {
    return null;
  }
  const { start, level } = location;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const nextLevel = markdownHeadingLevel(lines[index]);
    if (nextLevel !== null && nextLevel <= level) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

export function tempFilePath(suffix) {
  return path.join(
    os.tmpdir(),
    `context-manager-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}${suffix}`
  );
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/gu, `'\"'\"'`)}'`;
}

export function shellCommand(command, args) {
  return [command, ...args].map((value) => shellQuote(value)).join(" ");
}

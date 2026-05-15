#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { runCodexStructured } from "./lib/llm.mjs";
import { normalizeWorkingMemoryFile } from "./lib/working_memory.mjs";
import {
  ensureDirectory,
  firstHeading,
  isMainModule,
  markdownExplicitAnchorId,
  markdownFiles,
  parseCommonArgs,
  relativeLink,
  renderPromptTemplate,
  slugify
} from "./lib/utils.mjs";

const GUIDANCE_CATEGORIES = ["decisions", "workflows", "conventions"];
const GENERATED_MARKER = "<!-- context-manager: generated -->";
const CATEGORY_DESCRIPTIONS = {
  decisions: "适合查看已经定下来的方案、原因和影响。",
  workflows: "适合查看某类任务应如何推进。",
  conventions: "适合查看默认约定、命令和边界条件。"
};
const STRUCTURED_SECTION_CATEGORIES = {
  decisions: "decisions",
  workflows: "workflows",
  conventions: "conventions"
};
const DEFAULT_COMPILE_PROMPT = `Compile the working-memory excerpts below into high-level agent guidance.

Rules:
- Output JSON only.
- Only use categories: decisions, workflows, conventions.
- Merge repeated or overlapping points across sources into one page.
- Prefer durable, reusable guidance over session-local notes.
- Drop low-value or transient items.
- The working-memory excerpts are ordered from older to newer.
- If sources conflict, prefer the newer source when it reflects a verified current-state correction.
- Treat defect reports as point-in-time observations; if newer excerpts show the issue is fixed, compile guidance for the fixed current state.
- Existing guidance is prior state to refine or preserve when still valid.
- guidance should be concise standalone bullet statements.
- sources must reference the provided source ids verbatim.

Existing guidance pages:
{existing_guidance}

Working-memory excerpts:
{snapshot}
`;

function ensureGuidanceStructure(repoRoot) {
  const guidanceDir = ensureDirectory(path.join(repoRoot, "guidance"));
  for (const category of GUIDANCE_CATEGORIES) {
    ensureDirectory(path.join(guidanceDir, category));
  }
  return guidanceDir;
}

function clearGeneratedGuidancePages(categoryDir) {
  if (!fs.existsSync(categoryDir)) {
    return;
  }
  for (const entry of fs.readdirSync(categoryDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "index.md") {
      const filePath = path.join(categoryDir, entry.name);
      if (fs.readFileSync(filePath, "utf8").includes(GENERATED_MARKER)) {
        fs.unlinkSync(filePath);
      }
    }
  }
}

function isGeneratedGuidancePage(filePath) {
  return fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8").includes(GENERATED_MARKER);
}

function collectExistingGuidancePages(guidanceDir) {
  const pagesByCategory = Object.fromEntries(GUIDANCE_CATEGORIES.map((category) => [category, []]));
  for (const category of GUIDANCE_CATEGORIES) {
    const categoryDir = path.join(guidanceDir, category);
    if (!fs.existsSync(categoryDir)) {
      continue;
    }
    for (const entry of fs.readdirSync(categoryDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "index.md") {
        continue;
      }
      const filePath = path.join(categoryDir, entry.name);
      pagesByCategory[category].push({
        path: filePath,
        slug: path.basename(entry.name, ".md"),
        title: titleForEntry(filePath),
        generated: isGeneratedGuidancePage(filePath),
        text: fs.readFileSync(filePath, "utf8").trim()
      });
    }
    pagesByCategory[category].sort((left, right) => left.slug.localeCompare(right.slug));
  }
  return pagesByCategory;
}

function collectWorkingMemoryEntries(repoRoot) {
  const entries = markdownFiles(path.join(repoRoot, "working-memory"));
  for (const entry of entries) {
    normalizeWorkingMemoryFile(repoRoot, entry);
  }
  return entries;
}

function titleForEntry(entry) {
  const text = fs.readFileSync(entry, "utf8");
  return firstHeading(text) || path.basename(entry, ".md");
}

function buildChunkBody(lines) {
  return lines
    .filter((line) => !markdownExplicitAnchorId(line))
    .filter((line) => !/<!--\s*(?:context-manager|codex-memory-compiler):\s*session_id=/u.test(line))
    .filter((line) => !line.startsWith("Source: `"))
    .map((line) => line.replace(/\s+$/u, ""))
    .join("\n")
    .trim();
}

function statementTitle(statement) {
  const words = [];
  for (const token of statement.replaceAll("/", " ").replaceAll("-", " ").split(/\s+/u)) {
    const cleaned = token.replace(/^[.,:;!?`()\[\]{}"']+|[.,:;!?`()\[\]{}"']+$/gu, "");
    if (cleaned) {
      words.push(cleaned);
    }
  }
  const truncated = words.slice(0, 8);
  return truncated.map((word) => word[0].toUpperCase() + word.slice(1)).join(" ") || "Untitled Guidance";
}

function chooseSourceAnchor(explicitAnchor, fallbackTitle, titleCounts) {
  if (explicitAnchor) {
    return explicitAnchor;
  }
  if ((titleCounts.get(fallbackTitle) || 0) > 1) {
    return null;
  }
  return slugify(fallbackTitle);
}

function extractStructuredSubchunks(entry, parentTitle, lines, titleCounts) {
  const explicitAnchor = lines.map((line) => markdownExplicitAnchorId(line)).find(Boolean) || null;
  const sourceAnchor = chooseSourceAnchor(explicitAnchor, parentTitle, titleCounts);
  let currentSection = null;
  const chunks = [];
  for (const rawLine of lines) {
    const stripped = rawLine.trim();
    if (stripped.startsWith("### ")) {
      currentSection = STRUCTURED_SECTION_CATEGORIES[stripped.slice(4).trim().toLowerCase()] || null;
      continue;
    }
    if (!currentSection || !stripped.startsWith("- ")) {
      continue;
    }
    const statement = stripped.slice(2).trim();
    if (!statement) {
      continue;
    }
    chunks.push({
      title: statementTitle(statement),
      body: statement,
      sourcePath: entry,
      sourceAnchor,
      category: currentSection
    });
  }
  return chunks;
}

function extractChunks(entry) {
  const text = fs.readFileSync(entry, "utf8");
  const lines = text.split(/\r?\n/u);
  const chunks = [];
  const titleCounts = new Map();
  for (const line of lines) {
    if (!line.startsWith("## ")) {
      continue;
    }
    const title = line.slice(3).trim();
    titleCounts.set(title, (titleCounts.get(title) || 0) + 1);
  }
  let currentTitle = null;
  let currentLines = [];

  const flushCurrent = () => {
    if (currentTitle === null) {
      return;
    }
    const explicitAnchor = currentLines.map((line) => markdownExplicitAnchorId(line)).find(Boolean) || null;
    const sourceAnchor = chooseSourceAnchor(explicitAnchor, currentTitle, titleCounts);
    const structuredChunks = extractStructuredSubchunks(entry, currentTitle, currentLines, titleCounts);
    if (structuredChunks.length > 0) {
      chunks.push(...structuredChunks);
      return;
    }
    const body = buildChunkBody(currentLines);
    if (!body) {
      return;
    }
    chunks.push({
      title: currentTitle,
      body,
      sourcePath: entry,
      sourceAnchor,
      category: null
    });
  };

  for (const line of lines) {
    if (line.startsWith("## ")) {
      flushCurrent();
      currentTitle = line.slice(3).trim();
      currentLines = [];
      continue;
    }
    if (currentTitle !== null) {
      currentLines.push(line);
    }
  }
  flushCurrent();
  if (chunks.length > 0) {
    return chunks;
  }

  const bodyLines = [];
  for (const line of lines) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#")) {
      continue;
    }
    bodyLines.push(stripped);
  }
  const body = bodyLines.join("\n").trim();
  if (!body) {
    return [];
  }
  return [{ title: titleForEntry(entry), body, sourcePath: entry, sourceAnchor: null, category: null }];
}

function guidancePageForSlug(categoryDir, slug) {
  return path.join(categoryDir, `${slug}.md`);
}

function sourceLink(fromPath, chunk) {
  const target = relativeLink(fromPath, chunk.sourcePath);
  return chunk.sourceAnchor ? `${target}#${chunk.sourceAnchor}` : target;
}

function chunkRef(chunk) {
  return chunk.sourceAnchor ? `${path.basename(chunk.sourcePath)}#${chunk.sourceAnchor}` : path.basename(chunk.sourcePath);
}

function llmSourceSnapshot(entries) {
  const lines = [];
  const refs = {};
  for (const entry of entries) {
    for (const chunk of extractChunks(entry)) {
      const ref = chunkRef(chunk);
      if (!refs[ref]) {
        refs[ref] = [];
      }
      refs[ref].push(chunk);
      lines.push(`### ${ref}`, `Title: ${chunk.title}`, chunk.body, "");
    }
  }
  return [lines.join("\n").trim(), refs];
}

function existingGuidanceSnapshot(existingGuidancePages) {
  const lines = [];
  for (const category of GUIDANCE_CATEGORIES) {
    for (const page of existingGuidancePages[category] || []) {
      if (!page.text) {
        continue;
      }
      lines.push(`### guidance:${category}/${path.basename(page.path)}`, page.text, "");
    }
  }
  return lines.join("\n").trim() || "None.";
}

function llmSynthesizeGuidance(repoRoot, entries, existingGuidancePages) {
  const [snapshot, refMap] = llmSourceSnapshot(entries);
  if (!snapshot) {
    return null;
  }

  const schema = {
    type: "object",
    properties: {
      pages: {
        type: "array",
        items: {
          type: "object",
          properties: {
            category: { type: "string", enum: GUIDANCE_CATEGORIES },
            title: { type: "string" },
            guidance: { type: "array", items: { type: "string" } },
            sources: { type: "array", items: { type: "string" } }
          },
          required: ["category", "title", "guidance", "sources"],
          additionalProperties: false
        }
      }
    },
    required: ["pages"],
    additionalProperties: false
  };

  const prompt = renderPromptTemplate("compile", DEFAULT_COMPILE_PROMPT, {
    existing_guidance: existingGuidanceSnapshot(existingGuidancePages),
    snapshot
  });
  const result = runCodexStructured(repoRoot, prompt, schema, "compile_synthesize_guidance");
  if (!result || !Array.isArray(result.pages)) {
    return null;
  }

  const grouped = Object.fromEntries(GUIDANCE_CATEGORIES.map((category) => [category, {}]));
  for (const page of result.pages) {
    if (!page || typeof page !== "object") {
      continue;
    }
    const { category, title, guidance, sources } = page;
    if (!GUIDANCE_CATEGORIES.includes(category) || typeof title !== "string") {
      continue;
    }
    if (!Array.isArray(guidance) || !Array.isArray(sources)) {
      continue;
    }

    const cleanGuidance = [];
    const seenGuidance = new Set();
    for (const item of guidance) {
      if (typeof item !== "string") {
        continue;
      }
      const cleaned = item.trim();
      const marker = cleaned.toLowerCase().replace(/[.!?]+$/u, "");
      if (!cleaned || seenGuidance.has(marker)) {
        continue;
      }
      seenGuidance.add(marker);
      cleanGuidance.push(cleaned);
    }

    const cleanRefs = [];
    const seenRefs = new Set();
    for (const ref of sources) {
      if (typeof ref !== "string" || !refMap[ref] || seenRefs.has(ref)) {
        continue;
      }
      seenRefs.add(ref);
      cleanRefs.push(ref);
    }

    if (cleanGuidance.length === 0 || cleanRefs.length === 0) {
      continue;
    }

    grouped[category][slugify(title)] = {
      category,
      title: title.trim(),
      guidance: cleanGuidance.slice(0, 6),
      sourceRefs: cleanRefs
    };
  }

  if (!GUIDANCE_CATEGORIES.some((category) => Object.keys(grouped[category]).length > 0)) {
    return null;
  }
  return grouped;
}

function buildCategoryIndexFromDrafts(category, categoryDir, drafts, chunkLookup, retainedPages = []) {
  const lines = [`# ${category[0].toUpperCase()}${category.slice(1)}`, "", CATEGORY_DESCRIPTIONS[category], ""];
  const indexPath = path.join(categoryDir, "index.md");
  const generatedEntries = Object.entries(drafts).map(([slug, draft]) => ({
    slug,
    title: draft.title,
    guidancePage: guidancePageForSlug(categoryDir, slug),
    sourceRefs: draft.sourceRefs,
    priority: 1
  }));
  const manualEntries = retainedPages.map((page) => ({
    slug: page.slug,
    title: page.title,
    guidancePage: page.path,
    sourceRefs: null,
    priority: 0
  }));
  const entries = [...generatedEntries, ...manualEntries]
    .sort((left, right) => left.priority - right.priority || left.slug.localeCompare(right.slug))
    .filter((entry, index, list) => index === list.findIndex((candidate) => candidate.slug === entry.slug))
    .sort((left, right) => left.slug.localeCompare(right.slug));
  if (entries.length > 0) {
    for (const entry of entries) {
      lines.push(`- [${entry.title}](${relativeLink(indexPath, entry.guidancePage)})`);
      if (!entry.sourceRefs) {
        continue;
      }
      const sourceLinks = [];
      for (const ref of entry.sourceRefs) {
        const chunk = chunkLookup[ref][0];
        sourceLinks.push(`[${path.basename(chunk.sourcePath)}](${sourceLink(indexPath, chunk)})`);
      }
      if (sourceLinks.length > 0) {
        lines.push(`  Sources: ${sourceLinks.join(", ")}`);
      }
    }
  } else {
    lines.push("- No entries classified here yet.");
  }
  lines.push("");
  return lines.join("\n");
}

function buildGuidancePageFromDraft(draft, guidancePage, chunkLookup) {
  const lines = [`# ${draft.title}`, "", GENERATED_MARKER, "", CATEGORY_DESCRIPTIONS[draft.category], "", "## Guidance", ""];
  for (const item of draft.guidance) {
    lines.push(`- ${item}`);
  }
  lines.push("", "## Sources", "");
  const seenLinks = new Set();
  for (const ref of draft.sourceRefs) {
    for (const chunk of chunkLookup[ref] || []) {
      const link = sourceLink(guidancePage, chunk);
      if (seenLinks.has(link)) {
        continue;
      }
      seenLinks.add(link);
      lines.push(`- [${path.basename(chunk.sourcePath)}](${link})`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function buildIndexFromDrafts(guidanceDir, drafts, entries, existingGuidancePages = {}) {
  const indexPath = path.join(guidanceDir, "index.md");
  const lines = [
    "# Guidance Index",
    "",
    "本仓库的高层 guidance 入口。先按类别找，再按需下探到 working-memory。",
    ""
  ];

  for (const category of GUIDANCE_CATEGORIES) {
    const categoryDir = path.join(guidanceDir, category);
    const categoryIndex = path.join(categoryDir, "index.md");
    lines.push(`## ${category[0].toUpperCase()}${category.slice(1)}`, "", CATEGORY_DESCRIPTIONS[category], "");
    lines.push(`- [Category Index](${relativeLink(indexPath, categoryIndex)})`);
    const entriesForCategory = [
      ...Object.entries(drafts[category]).map(([slug, draft]) => ({
        slug,
        title: draft.title,
        path: guidancePageForSlug(categoryDir, slug),
        priority: 1
      })),
      ...((existingGuidancePages[category] || []).filter((page) => !page.generated).map((page) => ({
        slug: page.slug,
        title: page.title,
        path: page.path,
        priority: 0
      })))
    ]
      .sort((left, right) => left.priority - right.priority || left.slug.localeCompare(right.slug))
      .filter((entry, index, list) => index === list.findIndex((candidate) => candidate.slug === entry.slug))
      .sort((left, right) => left.slug.localeCompare(right.slug));
    if (entriesForCategory.length > 0) {
      for (const entry of entriesForCategory.slice(0, 5)) {
        lines.push(`- [${entry.title}](${relativeLink(indexPath, entry.path)})`);
      }
    } else {
      lines.push("- No guidance pages here yet.");
    }
    lines.push("");
  }

  lines.push("## Continue Down", "", "如果 guidance 页面还不够，就沿链接继续查看对应的 working-memory。", "");
  if (entries.length > 0) {
    for (const entry of entries) {
      lines.push(`- [${titleForEntry(entry)}](${relativeLink(indexPath, entry)})`);
    }
  } else {
    lines.push("- No working-memory entries yet.");
  }
  lines.push("");
  return lines.join("\n");
}

function ensurePlaceholderGuidanceIndexes(guidanceDir, entries) {
  const emptyDrafts = Object.fromEntries(GUIDANCE_CATEGORIES.map((category) => [category, {}]));
  const existingGuidancePages = collectExistingGuidancePages(guidanceDir);
  for (const category of GUIDANCE_CATEGORIES) {
    const categoryDir = path.join(guidanceDir, category);
    const indexPath = path.join(categoryDir, "index.md");
    if (!fs.existsSync(indexPath)) {
      fs.writeFileSync(
        indexPath,
        buildCategoryIndexFromDrafts(category, categoryDir, {}, {}, existingGuidancePages[category].filter((page) => !page.generated)),
        "utf8"
      );
    }
  }
  const topIndexPath = path.join(guidanceDir, "index.md");
  if (!fs.existsSync(topIndexPath)) {
    fs.writeFileSync(topIndexPath, buildIndexFromDrafts(guidanceDir, emptyDrafts, entries, existingGuidancePages), "utf8");
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseCommonArgs(argv);
  const repoRoot = path.resolve(args.repoRoot);
  const guidanceDir = ensureGuidanceStructure(repoRoot);
  const entries = collectWorkingMemoryEntries(repoRoot);
  const existingGuidancePages = collectExistingGuidancePages(guidanceDir);
  let llmDrafts = llmSynthesizeGuidance(repoRoot, entries, existingGuidancePages);
  let chunkLookup = {};
  if (llmDrafts === null) {
    ensurePlaceholderGuidanceIndexes(guidanceDir, entries);
    return 0;
  } else {
    [, chunkLookup] = llmSourceSnapshot(entries);
  }

  for (const category of GUIDANCE_CATEGORIES) {
    const categoryDir = path.join(guidanceDir, category);
    clearGeneratedGuidancePages(categoryDir);
    for (const [slug, draft] of Object.entries(llmDrafts[category])) {
      const existingManualPage = (existingGuidancePages[category] || []).find((page) => page.slug === slug && !page.generated);
      if (existingManualPage) {
        continue;
      }
      const guidancePage = guidancePageForSlug(categoryDir, slug);
      fs.writeFileSync(guidancePage, buildGuidancePageFromDraft(draft, guidancePage, chunkLookup), "utf8");
    }
    fs.writeFileSync(
      path.join(categoryDir, "index.md"),
      buildCategoryIndexFromDrafts(
        category,
        categoryDir,
        llmDrafts[category],
        chunkLookup,
        (existingGuidancePages[category] || []).filter((page) => !page.generated)
      ),
      "utf8"
    );
  }

  fs.writeFileSync(path.join(guidanceDir, "index.md"), buildIndexFromDrafts(guidanceDir, llmDrafts, entries, existingGuidancePages), "utf8");
  return 0;
}

export const mainFromCli = main;

if (isMainModule(import.meta.url)) {
  process.exit(await main());
}

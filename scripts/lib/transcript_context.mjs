import { truncateUtf8 } from "./utils.mjs";

const MAX_PREVIEW_BYTES = 240;
const MAX_INLINE_TOOL_OUTPUT_BYTES = 320;
const MAX_DIGEST_BYTES = 48 * 1024;
const MAX_TIMELINE_BYTES = 42 * 1024;
const MAX_USER_MESSAGE_BYTES = 2200;
const MAX_ASSISTANT_MESSAGE_BYTES = 1800;
const MESSAGE_TRUNCATION_MARKER = "\n\n[message truncated]";
const KNOWN_TRANSCRIPT_TYPES = new Set(["session_meta", "event_msg", "response_item", "user_message", "agent_message"]);
const HIGH_SIGNAL_RE = /(decision|decided|workflow|convention|must|should|need to|root cause|fix|plan|architecture|boundary|risk|regression|决定|结论|流程|约定|必须|应该|修复|原因|计划|架构|边界|风险)/iu;
const BOOTSTRAP_PATTERNS = [
  /^# AGENTS\.md instructions for /u,
  /<INSTRUCTIONS>\s*# AGENTS\.md/iu,
  /You are Codex, a coding agent based on GPT-5\./u,
  /## Final answer instructions/u,
  /## Intermediary updates/u
];

function parseJsonLines(text) {
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return null;
  }

  const records = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch {
      return null;
    }
  }
  return records;
}

function isCodexTranscript(records) {
  return records.some((record) => KNOWN_TRANSCRIPT_TYPES.has(record?.type));
}

function messageTextFromContent(content) {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((part) => part && typeof part === "object" && typeof part.text === "string")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function isBootstrapOrEnvironmentMessage(role, text) {
  if (!text) {
    return true;
  }
  if (role === "developer" || role === "system") {
    return true;
  }
  if (text.startsWith("<environment_context>")) {
    return true;
  }
  if (BOOTSTRAP_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }
  return false;
}

function compactWhitespace(text) {
  return text.replace(/\r/g, "").replace(/[ \t]+/gu, " ").replace(/\n{3,}/gu, "\n\n").trim();
}

function previewText(text, maxBytes = MAX_PREVIEW_BYTES) {
  return truncateUtf8(compactWhitespace(text), maxBytes);
}

function summarizeToolArguments(rawArguments) {
  if (typeof rawArguments !== "string" || !rawArguments.trim()) {
    return "";
  }
  try {
    const parsed = JSON.parse(rawArguments);
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.cmd === "string" && parsed.cmd.trim()) {
        return `cmd=\`${previewText(parsed.cmd.trim(), 160)}\``;
      }
      if (typeof parsed.q === "string" && parsed.q.trim()) {
        return `q=\`${previewText(parsed.q.trim(), 160)}\``;
      }
      if (typeof parsed.query === "string" && parsed.query.trim()) {
        return `query=\`${previewText(parsed.query.trim(), 160)}\``;
      }
      if (typeof parsed.path === "string" && parsed.path.trim()) {
        return `path=\`${previewText(parsed.path.trim(), 160)}\``;
      }
      const keys = Object.keys(parsed).slice(0, 4);
      if (keys.length > 0) {
        return `keys=${keys.join(",")}`;
      }
    }
  } catch {
  }
  return `args=\`${previewText(rawArguments.trim(), 160)}\``;
}

function extractToolOutputBody(output) {
  if (typeof output !== "string" || !output.trim()) {
    return "";
  }
  const marker = "\nOutput:\n";
  const markerIndex = output.indexOf(marker);
  if (markerIndex !== -1) {
    return output.slice(markerIndex + marker.length).trim();
  }
  return output.trim();
}

function summarizeToolOutput(output) {
  if (typeof output !== "string" || !output.trim()) {
    return "no output";
  }
  const statusMatch = output.match(/Process exited with code (\d+)/u);
  const status = statusMatch ? `exit ${statusMatch[1]}` : "completed";
  const body = extractToolOutputBody(output);
  const bodyBytes = Buffer.byteLength(body, "utf8");
  if (!body) {
    return status;
  }
  if (bodyBytes > MAX_INLINE_TOOL_OUTPUT_BYTES) {
    return `${status}; verbose output omitted (${bodyBytes} bytes)`;
  }
  return `${status}; output: ${previewText(body)}`;
}

function truncateMessageText(text, role) {
  const compact = compactWhitespace(text);
  const maxBytes = role === "user" ? MAX_USER_MESSAGE_BYTES : MAX_ASSISTANT_MESSAGE_BYTES;
  if (Buffer.byteLength(compact, "utf8") <= maxBytes) {
    return compact;
  }
  const allowedBytes = Math.max(maxBytes - Buffer.byteLength(MESSAGE_TRUNCATION_MARKER, "utf8"), 0);
  return `${truncateUtf8(compact, allowedBytes).trimEnd()}${MESSAGE_TRUNCATION_MARKER}`;
}

function renderTimelineEntry(entry) {
  if (entry.kind === "tool") {
    const args = entry.arguments ? ` ${entry.arguments}` : "";
    return [`### Tool \`${entry.name}\`${args}`, "", entry.summary, ""].join("\n");
  }
  return [`### ${entry.role === "user" ? "User" : "Assistant"}`, "", entry.text, ""].join("\n");
}

function timelineSignalScore(entry, totalEntries) {
  if (entry.kind === "tool") {
    let score = 20;
    if (entry.summary.includes("exit ") && !entry.summary.includes("exit 0")) {
      score += 40;
    }
    if (entry.summary.includes("verbose output omitted")) {
      score += 10;
    }
    if (entry.index >= Math.max(totalEntries - 8, 0)) {
      score += 8;
    }
    return score;
  }

  let score = entry.role === "user" ? 100 : 70;
  if (entry.index === 0) {
    score += 20;
  }
  if (entry.index >= Math.max(totalEntries - 6, 0)) {
    score += 18;
  }
  if (HIGH_SIGNAL_RE.test(entry.text)) {
    score += 30;
  }
  if (entry.text.includes("?")) {
    score += 8;
  }
  if (entry.text.length <= 280) {
    score += 6;
  }
  return score;
}

function selectBudgetedEntries(entries, maxBytes, renderEntry, scoreEntry, mandatoryPredicates = []) {
  const candidates = entries.map((entry, index) => {
    const rendered = renderEntry(entry);
    return {
      ...entry,
      rendered,
      originalIndex: index,
      bytes: Buffer.byteLength(rendered, "utf8"),
      score: scoreEntry(entry, entries.length)
    };
  });
  const selected = new Set();
  let used = 0;

  function includeCandidate(candidate) {
    if (!candidate || selected.has(candidate.originalIndex)) {
      return;
    }
    if (used + candidate.bytes > maxBytes) {
      return;
    }
    selected.add(candidate.originalIndex);
    used += candidate.bytes;
  }

  for (const predicate of mandatoryPredicates) {
    includeCandidate(candidates.find(predicate));
  }

  for (const candidate of [...candidates].sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return right.originalIndex - left.originalIndex;
  })) {
    includeCandidate(candidate);
  }

  return candidates.filter((candidate) => selected.has(candidate.originalIndex)).sort((left, right) => left.originalIndex - right.originalIndex);
}

function renderTimeline(entries) {
  const selectedEntries = selectBudgetedEntries(entries, MAX_TIMELINE_BYTES, renderTimelineEntry, timelineSignalScore, [
    (entry) => entry.kind === "message" && entry.role === "user",
    (entry) => entry.kind === "message" && entry.role === "user" && entry.index === entries.length - 1,
    (entry) => entry.kind === "message" && entry.role === "assistant" && entry.index === entries.length - 1
  ]);
  if (selectedEntries.length === 0) {
    return { text: "", keptConversation: 0, keptTools: 0 };
  }
  const lines = ["## Timeline", ""];
  for (const entry of selectedEntries) {
    lines.push(entry.rendered);
  }
  return {
    text: lines.join("\n").trimEnd(),
    keptConversation: selectedEntries.filter((entry) => entry.kind === "message").length,
    keptTools: selectedEntries.filter((entry) => entry.kind === "tool").length
  };
}

function renderOmittedSummary(stats, selectedConversationCount, selectedToolCount) {
  const lines = [];
  if (stats.bootstrapMessages > 0) {
    lines.push(`- Skipped ${stats.bootstrapMessages} bootstrap or environment message(s).`);
  }
  if (stats.conversationMessages > selectedConversationCount) {
    lines.push(`- Kept ${selectedConversationCount} of ${stats.conversationMessages} conversation message(s) by signal and budget.`);
  }
  if (stats.toolSummaries > selectedToolCount) {
    lines.push(`- Kept ${selectedToolCount} of ${stats.toolSummaries} tool summary item(s) by signal and budget.`);
  }
  if (stats.runtimeEvents > 0) {
    lines.push(`- Skipped ${stats.runtimeEvents} runtime bookkeeping event(s).`);
  }
  if (stats.reasoningEvents > 0) {
    lines.push(`- Skipped ${stats.reasoningEvents} reasoning event(s).`);
  }
  if (stats.otherMessages > 0) {
    lines.push(`- Skipped ${stats.otherMessages} low-signal message item(s).`);
  }
  if (lines.length === 0) {
    return "";
  }
  return ["## Omitted Context", "", ...lines].join("\n");
}

export function reduceTranscriptForFlush(text) {
  const raw = typeof text === "string" ? text.trim() : "";
  if (!raw) {
    return "";
  }

  const records = parseJsonLines(raw);
  if (!records || !isCodexTranscript(records)) {
    return raw;
  }

  const seenConversation = new Set();
  const toolCalls = new Map();
  const timeline = [];
  const stats = {
    bootstrapMessages: 0,
    conversationMessages: 0,
    runtimeEvents: 0,
    reasoningEvents: 0,
    otherMessages: 0,
    toolSummaries: 0
  };
  let timelineIndex = 0;

  function pushConversation(role, textValue) {
    const textContent = truncateMessageText(textValue, role);
    if (!textContent) {
      return;
    }
    if (isBootstrapOrEnvironmentMessage(role, textContent)) {
      stats.bootstrapMessages += 1;
      return;
    }
    const dedupeKey = `${role}\u0000${textContent}`;
    if (seenConversation.has(dedupeKey)) {
      return;
    }
    seenConversation.add(dedupeKey);
    const entry = { kind: "message", role, text: textContent, index: timelineIndex };
    timeline.push(entry);
    timelineIndex += 1;
    stats.conversationMessages += 1;
  }

  for (const record of records) {
    if (!record || typeof record !== "object") {
      continue;
    }
    if (record.type === "event_msg") {
      const payload = record.payload || {};
      if (payload.type === "user_message" && typeof payload.message === "string") {
        pushConversation("user", payload.message);
      } else if (payload.type === "agent_message" && typeof payload.message === "string") {
        pushConversation("assistant", payload.message);
      } else if (payload.type === "token_count" || payload.type === "task_started") {
        stats.runtimeEvents += 1;
      } else {
        stats.otherMessages += 1;
      }
      continue;
    }

    if (record.type !== "response_item") {
      if (record.type === "session_meta") {
        stats.runtimeEvents += 1;
      }
      continue;
    }

    const payload = record.payload || {};
    if (payload.type === "message") {
      const role = payload.role || "";
      const textValue = messageTextFromContent(payload.content);
      if (isBootstrapOrEnvironmentMessage(role, textValue)) {
        stats.bootstrapMessages += 1;
      } else if (role === "user" || role === "assistant") {
        pushConversation(role, textValue);
      } else {
        stats.otherMessages += 1;
      }
      continue;
    }

    if (payload.type === "function_call") {
      const callId = payload.call_id || "";
      toolCalls.set(callId, {
        name: payload.name || "tool",
        arguments: summarizeToolArguments(payload.arguments)
      });
      continue;
    }

    if (payload.type === "function_call_output") {
      const tool = toolCalls.get(payload.call_id || "") || { name: "tool", arguments: "" };
      timeline.push({
        kind: "tool",
        name: tool.name,
        arguments: tool.arguments,
        summary: summarizeToolOutput(payload.output),
        index: timelineIndex
      });
      timelineIndex += 1;
      stats.toolSummaries += 1;
      continue;
    }

    if (payload.type === "reasoning") {
      stats.reasoningEvents += 1;
      continue;
    }

    stats.otherMessages += 1;
  }

  const sections = [
    "# Codex Transcript Digest",
    "",
    "Selection policy:",
    "- Preserved user requests and assistant natural-language replies.",
    "- Compressed tool activity into short summaries.",
    "- Omitted bootstrap instructions, environment payloads, reasoning traces, and runtime bookkeeping.",
    ""
  ];
  const timelineSection = renderTimeline(timeline);
  if (timelineSection.text) {
    sections.push(timelineSection.text, "");
  }
  const omittedSection = renderOmittedSummary(stats, timelineSection.keptConversation, timelineSection.keptTools);
  if (omittedSection) {
    sections.push(omittedSection, "");
  }

  return truncateUtf8(sections.join("\n").trim(), MAX_DIGEST_BYTES).trimEnd();
}

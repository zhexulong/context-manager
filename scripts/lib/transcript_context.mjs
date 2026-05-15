import { truncateUtf8 } from "./utils.mjs";

const MAX_PREVIEW_BYTES = 240;
const MAX_INLINE_TOOL_OUTPUT_BYTES = 320;
const KNOWN_TRANSCRIPT_TYPES = new Set(["session_meta", "event_msg", "response_item", "user_message", "agent_message"]);

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

function renderConversation(entries) {
  if (entries.length === 0) {
    return "";
  }
  const lines = ["## Conversation", ""];
  for (const entry of entries) {
    lines.push(`### ${entry.role === "user" ? "User" : "Assistant"}`, "", entry.text, "");
  }
  return lines.join("\n").trimEnd();
}

function renderToolSummaries(entries) {
  if (entries.length === 0) {
    return "";
  }
  const lines = ["## Tool Activity Summary", ""];
  for (const entry of entries) {
    const args = entry.arguments ? ` ${entry.arguments}` : "";
    lines.push(`- \`${entry.name}\`${args}: ${entry.summary}`);
  }
  return lines.join("\n");
}

function renderOmittedSummary(stats) {
  const lines = [];
  if (stats.bootstrapMessages > 0) {
    lines.push(`- Skipped ${stats.bootstrapMessages} bootstrap or environment message(s).`);
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

  const conversation = [];
  const seenConversation = new Set();
  const toolCalls = new Map();
  const toolSummaries = [];
  const stats = {
    bootstrapMessages: 0,
    runtimeEvents: 0,
    reasoningEvents: 0,
    otherMessages: 0
  };

  function pushConversation(role, textValue) {
    const textContent = compactWhitespace(textValue);
    if (!textContent) {
      return;
    }
    const dedupeKey = `${role}\u0000${textContent}`;
    if (seenConversation.has(dedupeKey)) {
      return;
    }
    seenConversation.add(dedupeKey);
    conversation.push({ role, text: textContent });
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
      toolSummaries.push({
        name: tool.name,
        arguments: tool.arguments,
        summary: summarizeToolOutput(payload.output)
      });
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
  const conversationSection = renderConversation(conversation);
  if (conversationSection) {
    sections.push(conversationSection, "");
  }
  const toolSection = renderToolSummaries(toolSummaries);
  if (toolSection) {
    sections.push(toolSection, "");
  }
  const omittedSection = renderOmittedSummary(stats);
  if (omittedSection) {
    sections.push(omittedSection, "");
  }

  return sections.join("\n").trim();
}

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { ensureDirectory, isoDateToday, tempFilePath, timestampNow } from "./utils.mjs";

export const INTERNAL_ENV_VAR = "CODEX_MEMORY_COMPILER_INTERNAL";
export const CODEX_CMD_ENV_VAR = "CODEX_MEMORY_COMPILER_CODEX_CMD";
export const TIMEOUT_ENV_VAR = "CODEX_MEMORY_COMPILER_LLM_TIMEOUT_SEC";
const CODEX_SANDBOX_NETWORK_DISABLED_ENV_VAR = "CODEX_SANDBOX_NETWORK_DISABLED";

function resolveExecutable(command) {
  if (!command) {
    return null;
  }
  const expanded = command.startsWith("~")
    ? path.join(process.env.HOME || process.env.USERPROFILE || "~", command.slice(1))
    : command;
  if (path.isAbsolute(expanded) || expanded.includes(path.sep)) {
    return fs.existsSync(expanded) ? path.resolve(expanded) : null;
  }

  const pathExts = process.platform === "win32"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
        .split(";")
        .filter(Boolean)
    : [""];
  const pathEntries = (process.env.PATH || "").split(path.delimiter);
  for (const entry of pathEntries) {
    for (const ext of pathExts) {
      const candidate = path.join(entry, `${expanded}${ext}`);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

export function codexCommand() {
  const configured = process.env[CODEX_CMD_ENV_VAR];
  if (configured) {
    return resolveExecutable(configured);
  }
  return resolveExecutable("codex");
}

export function llmTimeoutSeconds() {
  const raw = (process.env[TIMEOUT_ENV_VAR] || "90").trim();
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return 90;
  }
  return Math.max(parsed, 5);
}

export function llmFailureLogDir(repoRoot) {
  return ensureDirectory(path.join(repoRoot, "reports", "llm-failures"));
}

export function recordLlmFailure(repoRoot, taskName, reason, options = {}) {
  const entry = {
    timestamp: timestampNow(),
    task: taskName,
    reason
  };
  if (options.codex) {
    entry.codex_command = options.codex;
  }
  if (typeof options.returncode === "number") {
    entry.returncode = options.returncode;
  }
  if (options.stderr) {
    entry.stderr = String(options.stderr).trim().slice(0, 2000);
  }

  const target = path.join(llmFailureLogDir(repoRoot), `${isoDateToday()}.jsonl`);
  try {
    fs.appendFileSync(target, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    return;
  }
}

function isCodexCliExecutable(commandPath) {
  const base = path.basename(commandPath || "").toLowerCase();
  return base === "codex" || base === "codex.exe" || base === "codex.cmd" || base === "codex.bat";
}

export function runCodexStructured(repoRoot, prompt, schema, taskName) {
  const stubResponse = process.env.CODEX_MEMORY_COMPILER_STUB_RESPONSE;
  if (stubResponse) {
    const capturePath = process.env.CODEX_MEMORY_COMPILER_CAPTURE_PROMPT;
    if (capturePath) {
      try {
        fs.writeFileSync(capturePath, prompt, "utf8");
      } catch {
      }
    }
    try {
      const parsed = JSON.parse(stubResponse);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        recordLlmFailure(repoRoot, taskName, "invalid_payload_type", { codex: "stub_response" });
        return null;
      }
      return parsed;
    } catch {
      recordLlmFailure(repoRoot, taskName, "invalid_json", { codex: "stub_response" });
      return null;
    }
  }

  const codex = codexCommand();
  if (!codex) {
    recordLlmFailure(repoRoot, taskName, "codex_command_not_found");
    return null;
  }
  if (process.env[CODEX_SANDBOX_NETWORK_DISABLED_ENV_VAR] === "1" && isCodexCliExecutable(codex)) {
    recordLlmFailure(repoRoot, taskName, "sandbox_network_disabled", { codex });
    return null;
  }

  const schemaPath = tempFilePath(".json");
  const outputPath = tempFilePath(".txt");
  try {
    fs.writeFileSync(schemaPath, JSON.stringify(schema), "utf8");
    fs.writeFileSync(outputPath, "", "utf8");

    const env = {
      ...process.env,
      [INTERNAL_ENV_VAR]: "1"
    };
    if (!("RUST_LOG" in env)) {
      env.RUST_LOG = "error";
    }

    const codexArgs = [
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--color",
      "never",
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outputPath,
      "-C",
      repoRoot,
      "-"
    ];

    const isPythonScript = codex.endsWith(".py");
    const isNodeScript = codex.endsWith(".mjs") || codex.endsWith(".js") || codex.endsWith(".cjs");
    const spawnCommand = isPythonScript ? "python3" : isNodeScript ? process.execPath : codex;
    const spawnArgs = isPythonScript || isNodeScript ? [codex, ...codexArgs] : codexArgs;

    const result = spawnSync(spawnCommand, spawnArgs, {
      cwd: repoRoot,
      encoding: "utf8",
      env,
      input: prompt,
      timeout: llmTimeoutSeconds() * 1000
    });
    if (result.error && result.error.code === "ETIMEDOUT") {
      recordLlmFailure(repoRoot, taskName, "timeout", { codex });
      return null;
    }
    if (result.error) {
      recordLlmFailure(repoRoot, taskName, "os_error", { codex, stderr: result.error.message });
      return null;
    }
    if (result.status !== 0) {
      recordLlmFailure(repoRoot, taskName, "subprocess_nonzero_exit", {
        codex,
        returncode: result.status ?? undefined,
        stderr: result.stderr
      });
      return null;
    }

    const payload = fs.readFileSync(outputPath, "utf8").trim();
    if (!payload) {
      recordLlmFailure(repoRoot, taskName, "empty_output", { codex });
      return null;
    }
    const parsed = JSON.parse(payload);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      recordLlmFailure(repoRoot, taskName, "invalid_payload_type", { codex });
      return null;
    }
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) {
      recordLlmFailure(repoRoot, taskName, "invalid_json", { codex });
    } else {
      recordLlmFailure(repoRoot, taskName, "os_error", { codex, stderr: error.message });
    }
    return null;
  } finally {
    for (const filePath of [schemaPath, outputPath]) {
      try {
        fs.unlinkSync(filePath);
      } catch {
      }
    }
  }
}

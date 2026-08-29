#!/usr/bin/env node
/**
 * Codex CLI lifecycle hook forwarder for Poracode.
 *
 * Invoked by Codex with:
 *   argv[2] = hook event name (e.g. "SessionStart", "Stop")
 *   stdin   = JSON payload (includes hook_event_name)
 *
 * Stop: Codex requires JSON on stdout when exit code is 0 — always emit `{}`.
 *
 * Generic plumbing lives in the shared `poracode-hook-runtime.mjs` sibling.
 */

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { readPluginVersionFromManifest, runForwarder } from "./poracode-hook-runtime.mjs";

const PLUGIN_VERSION = readPluginVersionFromManifest(import.meta.url);
const BROWSER_EXCLUSIVE_DENY_REASON =
  "Y Space Browser is connected. Use its browser MCP instead of shell-driven page retrieval, browser tools, or external browsers.";

let preToolUseResponse;
const SHELL_TOOL_NAMES = new Set([
  "bash",
  "shell",
  "shell_command",
  "exec_command",
  "functions.exec_command",
]);
const MAX_INSPECTED_SCRIPT_BYTES = 512 * 1024;
const SCRIPT_FILE_RE =
  /(?:^|[;&|]\s*|\s)(?:node(?:\.exe)?|bun(?:\.exe)?|deno(?:\.exe)?|python(?:3(?:\.\d+)?)?(?:\.exe)?|py(?:\.exe)?|ruby(?:\.exe)?|perl(?:\.exe)?|php(?:\.exe)?|bash|sh|zsh|osascript)\s+(?:(?:--?[A-Za-z][\w-]*(?:=[^\s;&|]+)?|-\w+)\s+)*(?:["']([^"']+\.(?:[cm]?[jt]s|tsx?|py|rb|pl|php|sh|scpt|applescript))["']|([^\s;&|]+\.(?:[cm]?[jt]s|tsx?|py|rb|pl|php|sh|scpt|applescript)))/giu;
const PACKAGE_SCRIPT_RE =
  /(?:^|[;&|]\s*)(npm|pnpm|yarn|bun)(?:\.cmd|\.exe)?\s+(?:(run)\s+)?([A-Za-z0-9:_-]+)(?:\s|$)/iu;
const PACKAGE_SCRIPT_SHORTHANDS = new Set(["test", "start", "stop", "restart"]);
const BROWSER_SCRIPT_CONTENT_RE =
  /(?:\b(?:fetch|XMLHttpRequest|urlopen|file_get_contents|curl_init)\s*\(|\b(?:axios|requests|httpx)\s*\.\s*(?:get|post|put|patch|delete|request)\s*\(|\b(?:aiohttp|Net::HTTP|HTTP::Tiny|LWP::UserAgent)\b|(?:from|import|require\s*\()[^\r\n]{0,160}\b(?:playwright|puppeteer|selenium|webdriver|browser-use|browser_use)\b|\b(?:tell\s+(?:application|app)|using\s+terms\s+from)\s+["']?(?:Google Chrome|Chromium|Safari|Firefox|Brave(?: Browser)?|Microsoft Edge|Arc|Comet|Opera|Vivaldi)\b|\b(?:subprocess\s*\.\s*(?:run|call|Popen|check_call|check_output)|os\s*\.\s*system)\s*\([^\r\n]{0,400}["'](?:open|google-chrome|chromium|firefox|brave-browser|msedge|microsoft-edge|opera|vivaldi|comet)\b)/iu;

function readInspectionSource(sourcePath) {
  try {
    const stat = statSync(sourcePath);
    if (!stat.isFile() || stat.size > MAX_INSPECTED_SCRIPT_BYTES) return undefined;
    return readFileSync(sourcePath, "utf8");
  } catch {
    return undefined;
  }
}

function browserCommandOrScript(command, cwd, deniedCommand, depth = 0) {
  if (deniedCommand.test(command)) return true;
  if (depth >= 4) return true;

  const packageMatch = PACKAGE_SCRIPT_RE.exec(command);
  const scriptName = packageMatch?.[3];
  if (scriptName && (packageMatch[2] || PACKAGE_SCRIPT_SHORTHANDS.has(scriptName))) {
    const manifest = readInspectionSource(resolve(cwd, "package.json"));
    if (manifest === undefined) return true;
    try {
      const scripts = JSON.parse(manifest)?.scripts;
      const script = scripts && typeof scripts === "object" ? scripts[scriptName] : undefined;
      if (typeof script !== "string" || script.trim().length === 0) return true;
      return [`pre${scriptName}`, scriptName, `post${scriptName}`].some((name) => {
        const lifecycleCommand = scripts[name];
        return (
          typeof lifecycleCommand === "string" &&
          browserCommandOrScript(lifecycleCommand, cwd, deniedCommand, depth + 1)
        );
      });
    } catch {
      return true;
    }
  }

  const paths = [...command.matchAll(SCRIPT_FILE_RE)].flatMap((match) => {
    const scriptPath = match[1] ?? match[2];
    if (!scriptPath) return [];
    return [isAbsolute(scriptPath) ? scriptPath : resolve(cwd, scriptPath)];
  });
  return paths.some((scriptPath) => {
    const source = readInspectionSource(scriptPath);
    if (source === undefined) return true;
    if (BROWSER_SCRIPT_CONTENT_RE.test(source)) return true;
    return source.split(/\r?\n/u).some((line) => deniedCommand.test(line.trim()));
  });
}

function shellCwd(payload) {
  const input = payload?.tool_input;
  const candidate = input?.cwd ?? input?.workdir ?? payload?.cwd;
  return typeof candidate === "string" && candidate.length > 0 ? resolve(candidate) : process.cwd();
}

function normalizedShellCommand(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((part) => typeof part === "string")) {
    return value.join(" ");
  }
  return undefined;
}

function shellCommandsFrom(payload) {
  const input = payload?.tool_input;
  if (!input || typeof input !== "object") return [];
  return [normalizedShellCommand(input.command), normalizedShellCommand(input.cmd)].filter(
    (command) => typeof command === "string",
  );
}

function browserExclusiveResponse(eventName, payload) {
  if (eventName !== "PreToolUse" || process.env.PORACODE_CODEX_BROWSER_EXCLUSIVE !== "1") {
    return undefined;
  }
  const toolName = typeof payload?.tool_name === "string" ? payload.tool_name.toLowerCase() : "";
  if (!SHELL_TOOL_NAMES.has(toolName)) return undefined;
  const commands = shellCommandsFrom(payload);
  const source = process.env.PORACODE_BROWSER_COMMAND_DENY_REGEX;
  if (commands.length === 0 || !source) return undefined;
  try {
    const deniedCommand = new RegExp(source, "iu");
    const cwd = shellCwd(payload);
    if (!commands.some((command) => browserCommandOrScript(command, cwd, deniedCommand))) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: BROWSER_EXCLUSIVE_DENY_REASON,
    },
  });
}

function intentFor(eventName, payload, ctx) {
  const name = typeof payload?.hook_event_name === "string" ? payload.hook_event_name : eventName;
  preToolUseResponse = browserExclusiveResponse(name, payload);
  switch (name) {
    case "SessionStart":
      return "session.started";
    case "UserPromptSubmit":
      return "session.turn_started";
    case "PermissionRequest":
      return "session.needs_approval";
    case "Stop":
      return "session.turn_finished";
    case "PreToolUse":
    case "PostToolUse":
      // Tool-use events are observability-only — surface them as turn_started
      // when debug is on so the supervisor sees them, otherwise skip.
      return ctx?.debug ? "session.turn_started" : undefined;
    default:
      return undefined;
  }
}

function buildExtra(eventName, payload) {
  const extra = { agentNativeEvent: eventName };
  if (payload && typeof payload === "object") {
    if (typeof payload.session_id === "string") extra.sessionId = payload.session_id;
    if (typeof payload.turn_id === "string") extra.turnId = payload.turn_id;
    if (typeof payload.tool_name === "string") extra.tool = payload.tool_name;
    if (typeof payload.permission_mode === "string") {
      extra.permissionMode = payload.permission_mode;
    }
    if (payload.tool_input && typeof payload.tool_input === "object") {
      const cmd = shellCommandsFrom(payload)[0];
      if (cmd) {
        extra.toolCommand = cmd.length > 200 ? `${cmd.slice(0, 200)}...` : cmd;
      }
    }
    if (typeof payload.last_assistant_message === "string") {
      const m = payload.last_assistant_message;
      extra.lastAssistantMessage = m.length > 500 ? `${m.slice(0, 500)}...` : m;
    }
    if (typeof payload.stop_hook_active === "boolean") {
      extra.stopHookActive = payload.stop_hook_active;
    }
  }
  return extra;
}

function pickSessionId(payload) {
  return typeof payload?.session_id === "string" ? payload.session_id : undefined;
}

function stdoutResponseFor(eventName) {
  return preToolUseResponse ?? (eventName === "Stop" ? "{}" : undefined);
}

await runForwarder({
  agentKind: "codex",
  pluginVersion: PLUGIN_VERSION,
  intentFor,
  buildExtra,
  pickSessionId,
  stdoutResponseFor,
  debugLabel: "codex",
});

#!/usr/bin/env node
/**
 * Claude Code lifecycle hook forwarder for Poracode.
 *
 * Invoked by Claude on each subscribed hook event with:
 *   argv[2] = hook event name (e.g. "UserPromptSubmit")
 *   stdin   = JSON payload from Claude
 *
 * Reads `PORACODE_HOOK_URL`, `PORACODE_HOOK_SECRET`, etc. from env, builds
 * the universal Poracode envelope, and POSTs it. Emits NOTHING on stdout —
 * Claude relays hook stdout into the model's context for some events.
 *
 * Generic plumbing lives in the shared `poracode-hook-runtime.mjs` sibling.
 */

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { readPluginVersionFromManifest, runForwarder } from "./poracode-hook-runtime.mjs";

const PLUGIN_VERSION = readPluginVersionFromManifest(import.meta.url);
const BROWSER_EXCLUSIVE_DENY_REASON = "Use the embedded Y Space Browser for web and browser work.";
const SHELL_TOOL_NAMES = new Set(["bash", "shell", "powershell"]);
const MAX_INSPECTED_SCRIPT_BYTES = 512 * 1024;
const SCRIPT_FILE_RE =
  /(?:^|[;&|]\s*|\s)(?:node(?:\.exe)?|bun(?:\.exe)?|deno(?:\.exe)?|python(?:3(?:\.\d+)?)?(?:\.exe)?|py(?:\.exe)?|ruby(?:\.exe)?|perl(?:\.exe)?|php(?:\.exe)?|bash|sh|zsh|osascript)\s+(?:(?:--?[A-Za-z][\w-]*(?:=[^\s;&|]+)?|-\w+)\s+)*(?:["']([^"']+\.(?:[cm]?[jt]s|tsx?|py|rb|pl|php|sh|scpt|applescript))["']|([^\s;&|]+\.(?:[cm]?[jt]s|tsx?|py|rb|pl|php|sh|scpt|applescript)))/giu;
const PACKAGE_SCRIPT_RE =
  /(?:^|[;&|]\s*)(npm|pnpm|yarn|bun)(?:\.cmd|\.exe)?\s+(?:(run)\s+)?([A-Za-z0-9:_-]+)(?:\s|$)/iu;
const PACKAGE_SCRIPT_SHORTHANDS = new Set(["test", "start", "stop", "restart"]);
const BROWSER_SCRIPT_CONTENT_RE =
  /(?:\b(?:fetch|XMLHttpRequest|urlopen|file_get_contents|curl_init)\s*\(|\b(?:axios|requests|httpx)\s*\.\s*(?:get|post|put|patch|delete|request)\s*\(|\b(?:aiohttp|Net::HTTP|HTTP::Tiny|LWP::UserAgent)\b|(?:from|import|require\s*\()[^\r\n]{0,160}\b(?:playwright|puppeteer|selenium|webdriver|browser-use|browser_use)\b|\b(?:tell\s+(?:application|app)|using\s+terms\s+from)\s+["']?(?:Google Chrome|Chromium|Safari|Firefox|Brave(?: Browser)?|Microsoft Edge|Arc|Comet|Opera|Vivaldi)\b|\b(?:subprocess\s*\.\s*(?:run|call|Popen|check_call|check_output)|os\s*\.\s*system)\s*\([^\r\n]{0,400}["'](?:open|google-chrome|chromium|firefox|brave-browser|msedge|microsoft-edge|opera|vivaldi|comet)\b)/iu;

let preToolUseResponse;

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

function browserExclusiveResponse(eventName, payload) {
  if (eventName !== "PreToolUse" || process.env.PORACODE_CLAUDE_BROWSER_EXCLUSIVE !== "1") {
    return undefined;
  }
  const toolName = typeof payload?.tool_name === "string" ? payload.tool_name.toLowerCase() : "";
  if (!SHELL_TOOL_NAMES.has(toolName)) return undefined;
  const command = payload?.tool_input?.command;
  const denySource = process.env.PORACODE_BROWSER_COMMAND_DENY_REGEX;
  if (typeof command !== "string" || !denySource) return undefined;
  try {
    const deniedCommand = new RegExp(denySource, "iu");
    const rawCwd = payload?.tool_input?.cwd ?? payload?.tool_input?.workdir ?? payload?.cwd;
    const cwd = typeof rawCwd === "string" && rawCwd.length > 0 ? resolve(rawCwd) : process.cwd();
    if (!browserCommandOrScript(command, cwd, deniedCommand)) return undefined;
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

function intentFor(eventName, payload) {
  preToolUseResponse = browserExclusiveResponse(eventName, payload);
  switch (eventName) {
    case "SessionStart":
      return "session.started";
    case "UserPromptSubmit":
      return "session.turn_started";
    case "PermissionRequest":
      return "session.needs_approval";
    // Auto-mode classifier denied a tool. Claude usually recovers and
    // continues the turn, so we stay in `working` rather than idle.
    case "PermissionDenied":
      return "session.turn_started";
    // Tool finished (approve path) — exit `needs_approval`, still mid-turn.
    case "PostToolUse":
      return "session.turn_started";
    // Tool execution failed. Two sub-cases per Claude docs:
    //   - `is_interrupt: true` → user interrupt; `Stop` will NOT follow, so
    //     this is the actual turn end → idle.
    //   - otherwise → genuine failure; Claude recovers and `Stop` will fire,
    //     so stay `working` and let `Stop` close the turn.
    case "PostToolUseFailure":
      return payload?.is_interrupt === true ? "session.turn_finished" : "session.turn_started";
    case "ElicitationResult": {
      const a = payload?.action;
      if (a === "cancel" || a === "decline") {
        return "session.turn_finished";
      }
      return undefined;
    }
    case "Notification":
      return payload?.matcher === "idle_prompt" ? "session.needs_reply" : undefined;
    case "TaskCreated":
      return "session.turn_started";
    case "TaskCompleted":
      return "session.turn_finished";
    case "Stop":
      return "session.turn_finished";
    case "StopFailure":
      return "session.turn_errored";
    default:
      return undefined;
  }
}

function buildExtra(eventName, payload) {
  const extra = { agentNativeEvent: eventName };
  if (payload && typeof payload === "object") {
    if (payload.matcher) extra.matcher = payload.matcher;
    if (payload.tool_name) extra.tool = payload.tool_name;
    if (payload.message) extra.message = payload.message;
  }
  return extra;
}

function pickSessionId(payload) {
  return typeof payload?.session_id === "string" ? payload.session_id : undefined;
}

await runForwarder({
  agentKind: "claude",
  pluginVersion: PLUGIN_VERSION,
  intentFor,
  buildExtra,
  pickSessionId,
  stdoutResponseFor: () => preToolUseResponse,
});

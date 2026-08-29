import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isCompetingBrowserCommand } from "./browserExclusivePolicy";

const MAX_INSPECTED_SCRIPT_BYTES = 512 * 1024;
const SCRIPT_FILE_RE =
  /(?:^|[;&|]\s*|\s)(?:node(?:\.exe)?|bun(?:\.exe)?|deno(?:\.exe)?|python(?:3(?:\.\d+)?)?(?:\.exe)?|py(?:\.exe)?|ruby(?:\.exe)?|perl(?:\.exe)?|php(?:\.exe)?|bash|sh|zsh|osascript)\s+(?:(?:--?[A-Za-z][\w-]*(?:=[^\s;&|]+)?|-\w+)\s+)*(?:["']([^"']+\.(?:[cm]?[jt]s|tsx?|py|rb|pl|php|sh|scpt|applescript))["']|([^\s;&|]+\.(?:[cm]?[jt]s|tsx?|py|rb|pl|php|sh|scpt|applescript)))/giu;
const PACKAGE_SCRIPT_RE =
  /(?:^|[;&|]\s*)(npm|pnpm|yarn|bun)(?:\.cmd|\.exe)?\s+(?:(run)\s+)?([A-Za-z0-9:_-]+)(?:\s|$)/iu;
const PACKAGE_SCRIPT_SHORTHANDS = new Set(["test", "start", "stop", "restart"]);
const BROWSER_SCRIPT_CONTENT_RE =
  /(?:\b(?:fetch|XMLHttpRequest|urlopen|file_get_contents|curl_init)\s*\(|\b(?:axios|requests|httpx)\s*\.\s*(?:get|post|put|patch|delete|request)\s*\(|\b(?:aiohttp|Net::HTTP|HTTP::Tiny|LWP::UserAgent)\b|(?:from|import|require\s*\()[^\r\n]{0,160}\b(?:playwright|puppeteer|selenium|webdriver|browser-use|browser_use)\b|\b(?:tell\s+(?:application|app)|using\s+terms\s+from)\s+["']?(?:Google Chrome|Chromium|Safari|Firefox|Brave(?: Browser)?|Microsoft Edge|Arc|Comet|Opera|Vivaldi)\b|\b(?:subprocess\s*\.\s*(?:run|call|Popen|check_call|check_output)|os\s*\.\s*system)\s*\([^\r\n]{0,400}["'](?:open|google-chrome|chromium|firefox|brave-browser|msedge|microsoft-edge|opera|vivaldi|comet)\b)/iu;

function readInspectionSource(sourcePath: string): string | undefined {
  try {
    const stat = statSync(sourcePath);
    if (!stat.isFile() || stat.size > MAX_INSPECTED_SCRIPT_BYTES) return undefined;
    return readFileSync(sourcePath, "utf8");
  } catch {
    return undefined;
  }
}

function packageScriptCommands(command: string, cwd: string): string[] | undefined | null {
  const match = PACKAGE_SCRIPT_RE.exec(command);
  const scriptName = match?.[3];
  if (!scriptName) return null;
  if (!match[2] && !PACKAGE_SCRIPT_SHORTHANDS.has(scriptName)) return null;
  const source = readInspectionSource(resolve(cwd, "package.json"));
  if (source === undefined) return undefined;
  try {
    const parsed = JSON.parse(source) as { scripts?: unknown };
    if (!parsed.scripts || typeof parsed.scripts !== "object" || Array.isArray(parsed.scripts)) {
      return undefined;
    }
    const scripts = parsed.scripts as Record<string, unknown>;
    const script = scripts[scriptName];
    if (typeof script !== "string" || script.trim().length === 0) return undefined;
    return [`pre${scriptName}`, scriptName, `post${scriptName}`].flatMap((name) => {
      const lifecycleCommand = scripts[name];
      return typeof lifecycleCommand === "string" && lifecycleCommand.trim().length > 0
        ? [lifecycleCommand]
        : [];
    });
  } catch {
    return undefined;
  }
}

function invokedScriptPaths(command: string, cwd: string): string[] {
  return [...command.matchAll(SCRIPT_FILE_RE)].flatMap((match) => {
    const scriptPath = match[1] ?? match[2];
    if (!scriptPath) return [];
    return [isAbsolute(scriptPath) ? scriptPath : resolve(cwd, scriptPath)];
  });
}

export function isCompetingBrowserScriptContent(source: string): boolean {
  if (BROWSER_SCRIPT_CONTENT_RE.test(source)) return true;
  return source.split(/\r?\n/gu).some((line) => isCompetingBrowserCommand(line.trim()));
}

/**
 * Inspect indirection that static shell globs cannot see. Script contents are
 * read locally with a hard size cap and reduced to a boolean; contents and
 * parser errors never enter provider-visible diagnostics or logs. An invoked
 * script/package command that cannot be inspected is denied fail-closed.
 */
function inspectCommand(command: string, cwd: string, depth: number): boolean {
  if (isCompetingBrowserCommand(command)) return true;
  if (depth >= 4) return true;

  const packageCommands = packageScriptCommands(command, cwd);
  if (packageCommands !== null) {
    if (packageCommands === undefined) return true;
    return packageCommands.some((packageCommand) => inspectCommand(packageCommand, cwd, depth + 1));
  }

  const scriptPaths = invokedScriptPaths(command, cwd);
  if (scriptPaths.length === 0) return false;
  return scriptPaths.some((scriptPath) => {
    const source = readInspectionSource(scriptPath);
    return source === undefined || isCompetingBrowserScriptContent(source);
  });
}

export function isCompetingBrowserCommandOrScript(command: string, cwd: string): boolean {
  return inspectCommand(command, cwd, 0);
}

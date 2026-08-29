import type { ResolvedMcpServer } from "./contracts";

type BrowserMcpCandidate = Pick<ResolvedMcpServer, "id" | "name" | "transport"> & {
  description?: string;
  tools?: readonly { name: string; description?: string }[];
};

/** Provider-neutral steering paired with hard launch-time capability suppression. */
export const Y_SPACE_BROWSER_EXCLUSIVE_GUIDANCE =
  "Y Space Browser is the only browser route for this session. Use the browser MCP tools for every web search, page read, navigation, inspection, screenshot, and browser interaction. Do not use provider-native web fetch or search, Chrome, Playwright, external browser MCPs, browser skills, or shell routes such as curl, wget, HTTPie, text browsers, Node fetch, or OS openers to fetch/test pages or launch/install browser automation, and do not launch a separate browser. Never claim that you verified, opened, tested, or observed a page unless you actually used the Browser MCP in the current turn. When reporting browser work, include the exact tab id, URL or title, and the page result you observed; if Browser MCP could not verify it, say so explicitly.";

/** Browser-oriented skills that must not compete with the embedded browser. */
export const COMPETING_BROWSER_SKILL_NAMES = [
  "browser",
  "browse",
  "browser-use",
  "control-in-app-browser",
  "gstack",
  "setup-browser-cookies",
  "playwright",
  "puppeteer",
  "selenium",
  "chrome",
  "chromium",
  "firefox",
  "webkit",
  "stagehand",
  "browserbase",
  "browserstack",
  "browserless",
  "webdriver",
  "node-repl",
] as const;

const DEFAULT_BROWSER_URL_COMMAND_PREFIXES = [
  "open ",
  "sudo open ",
  "exec open ",
  "*/open ",
  "xdg-open ",
  "*/xdg-open ",
  "gio open ",
  "*/gio open ",
  "sensible-browser ",
  "*/sensible-browser ",
  "Start-Process ",
  "pwsh *Start-Process ",
  "powershell *Start-Process ",
  "start ",
  "cmd*/c start ",
  "explorer ",
  "explorer.exe ",
] as const;

const DEFAULT_BROWSER_URL_COMMAND_GLOBS = DEFAULT_BROWSER_URL_COMMAND_PREFIXES.flatMap((prefix) => [
  `${prefix}*http://*`,
  `${prefix}*https://*`,
]);

const DEFAULT_BROWSER_LOCAL_DOCUMENT_COMMAND_GLOBS = DEFAULT_BROWSER_URL_COMMAND_PREFIXES.map(
  (prefix) => `${prefix}*.htm*`,
);

const PAGE_RETRIEVAL_COMMAND_PREFIXES = [
  "curl ",
  "*/curl ",
  "wget ",
  "*/wget ",
  "http ",
  "*/http ",
  "httpie ",
  "*/httpie ",
  "lynx ",
  "*/lynx ",
  "w3m ",
  "*/w3m ",
] as const;

const PAGE_RETRIEVAL_COMMAND_GLOBS = PAGE_RETRIEVAL_COMMAND_PREFIXES.flatMap((prefix) => [
  `${prefix}*http://*`,
  `${prefix}*https://*`,
  `${prefix}*.htm*`,
]);

const NODE_INLINE_PAGE_RETRIEVAL_GLOBS = ["node ", "*/node ", "node.exe ", "*\\node.exe "].flatMap(
  (prefix) => [
    `${prefix}*fetch*http://*`,
    `${prefix}*fetch*https://*`,
    `${prefix}*require*http*.get*http*`,
  ],
);

const INLINE_RUNTIME_PAGE_RETRIEVAL_GLOBS = [
  "*python*requests*http*",
  "*python*urllib*http*",
  "*python*httpx*http*",
  "*python*aiohttp*http*",
  "*python*webbrowser*",
  "*ruby*Net::HTTP*http*",
  "*ruby*net/http*http*",
  "*perl*HTTP::Tiny*http*",
  "*perl*LWP*http*",
  "*php*file_get_contents*http*",
  "*php*curl_init*http*",
  "*bun*fetch*http*",
  "*deno*fetch*http*",
  "*deno*--allow-net*http*",
] as const;

const DIRECT_BROWSER_EXECUTABLE_GLOBS = [
  "google-chrome*",
  "*/google-chrome*",
  "chromium*",
  "*/chromium*",
  "chrome.exe*",
  "*\\chrome.exe*",
  "firefox*",
  "*/firefox*",
  "*\\firefox.exe*",
  "brave-browser*",
  "*/brave-browser*",
  "brave.exe*",
  "*\\brave.exe*",
  "msedge*",
  "*\\msedge.exe*",
  "microsoft-edge*",
  "*/microsoft-edge*",
  "opera*",
  "*/opera*",
  "vivaldi*",
  "*/vivaldi*",
  "comet*",
  "*/comet*",
  "*/Google Chrome.app/Contents/MacOS/Google Chrome*",
  "*/Safari.app/Contents/MacOS/Safari*",
  "*/Firefox.app/Contents/MacOS/firefox*",
  "*/Brave Browser.app/Contents/MacOS/Brave Browser*",
  "*/Microsoft Edge.app/Contents/MacOS/Microsoft Edge*",
  "*/Opera.app/Contents/MacOS/Opera*",
  "*/Vivaldi.app/Contents/MacOS/Vivaldi*",
  "*/Comet.app/Contents/MacOS/Comet*",
] as const;

const POSIX_SHELL_EVAL_PREFIXES = ["bash -lc ", "*/bash -lc "] as const;

const POSIX_BROWSER_URL_LAUNCH_PREFIXES = [
  "open ",
  "xdg-open ",
  "gio open ",
  "sensible-browser ",
] as const;

const SHELL_EVAL_BROWSER_EXECUTABLE_GLOBS = [
  "google-chrome*",
  "*/google-chrome*",
  "chromium*",
  "*/chromium*",
  "chrome.exe*",
  "*\\chrome.exe*",
  "firefox*",
  "*/firefox*",
  "brave-browser*",
  "*/brave-browser*",
  "msedge*",
  "*\\msedge.exe*",
  "microsoft-edge*",
  "*/microsoft-edge*",
] as const;

const SHELL_EVALUATED_BROWSER_COMMAND_GLOBS = POSIX_SHELL_EVAL_PREFIXES.flatMap((shell) =>
  ["'", '"'].flatMap((quote) => [
    ...POSIX_BROWSER_URL_LAUNCH_PREFIXES.flatMap((browserCommand) => [
      `${shell}${quote}${browserCommand}*http://*`,
      `${shell}${quote}${browserCommand}*https://*`,
    ]),
    ...SHELL_EVAL_BROWSER_EXECUTABLE_GLOBS.map(
      (browserCommand) => `${shell}${quote}${browserCommand}`,
    ),
  ]),
);

const PREFIX_WRAPPED_BROWSER_COMMAND_GLOBS = ["command ", "nohup "].flatMap((prefix) => [
  ...POSIX_BROWSER_URL_LAUNCH_PREFIXES.flatMap((browserCommand) => [
    `${prefix}${browserCommand}*http://*`,
    `${prefix}${browserCommand}*https://*`,
  ]),
  ...SHELL_EVAL_BROWSER_EXECUTABLE_GLOBS.map((browserCommand) => `${prefix}${browserCommand}`),
]);

/**
 * Provider permission syntaxes expose shell globs rather than the shared
 * command classifier. Keep the known wrapper forms explicit so their rules do
 * not broaden into text-only mentions or unrelated environment-prefixed
 * commands.
 */
const ADDITIONAL_WRAPPED_BROWSER_COMMAND_GLOBS = [
  "sh -lc 'open *http://*",
  "sh -lc 'open *https://*",
  'sh -lc "open *http://*',
  'sh -lc "open *https://*',
  "zsh -lc 'firefox*",
  'zsh -lc "firefox*',
  "bash -c 'open *http://*",
  "bash -c 'open *https://*",
  'bash -c "open *http://*',
  'bash -c "open *https://*',
  "env DISPLAY=* firefox*",
  "FOO=* firefox*",
] as const;

/** Common shell-launched browser drivers and native external-browser launches. */
export const COMPETING_BROWSER_COMMAND_GLOBS = [
  "*playwright*",
  "*puppeteer*",
  "*selenium*",
  "*chromedriver*",
  "*geckodriver*",
  "*gstack*",
  "*browser-use*",
  "*browser_use*",
  "*open -a*Google Chrome*",
  "*open -a*Chromium*",
  "*open -a*Safari*",
  "*open -a*Firefox*",
  "*open -a*Brave*",
  "*open -a*Microsoft Edge*",
  "*open -a*Arc*",
  "*open -a*Comet*",
  "*open -a*Opera*",
  "*open -a*Vivaldi*",
  "*osascript*Google Chrome*",
  "*osascript*Chromium*",
  "*osascript*Safari*",
  "*osascript*Firefox*",
  "*osascript*Brave*",
  "*osascript*Microsoft Edge*",
  "*osascript*Arc*",
  "*osascript*Comet*",
  "*osascript*Opera*",
  "*osascript*Vivaldi*",
  "*Start-Process*chrome*",
  "*Start-Process*firefox*",
  "*Start-Process*msedge*",
  "*Start-Process*brave*",
  "*start chrome*",
  "*start firefox*",
  "*start msedge*",
  "*start brave*",
  ...DEFAULT_BROWSER_URL_COMMAND_GLOBS,
  ...DEFAULT_BROWSER_LOCAL_DOCUMENT_COMMAND_GLOBS,
  ...PAGE_RETRIEVAL_COMMAND_GLOBS,
  ...NODE_INLINE_PAGE_RETRIEVAL_GLOBS,
  ...INLINE_RUNTIME_PAGE_RETRIEVAL_GLOBS,
  ...DIRECT_BROWSER_EXECUTABLE_GLOBS,
  ...SHELL_EVALUATED_BROWSER_COMMAND_GLOBS,
  ...PREFIX_WRAPPED_BROWSER_COMMAND_GLOBS,
  ...ADDITIONAL_WRAPPED_BROWSER_COMMAND_GLOBS,
] as const;

const SHELL_COMMAND_SEGMENT_START = String.raw`(?:^\s*|[\s\S]*[;&|]\s*)`;
const POSIX_ENV_ASSIGNMENT = String.raw`[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s;&|]*)`;
const OPTIONAL_POSIX_SHELL_EVAL_PREFIX = String.raw`(?:(?:[^\s;&|]*[/\\])?(?:bash|sh|zsh)\s+-(?:lc|c)\s+["']\s*)?`;
const OPTIONAL_SHELL_LAUNCH_PREFIX = String.raw`(?:(?:sudo|exec)\s+)*(?:(?:[^\s;&|]*[/\\])?env\s+)?(?:${POSIX_ENV_ASSIGNMENT}\s+)*(?:(?:sudo|exec)\s+)*`;
const POSIX_BROWSER_COMMAND_START = `${SHELL_COMMAND_SEGMENT_START}${OPTIONAL_POSIX_SHELL_EVAL_PREFIX}${OPTIONAL_SHELL_LAUNCH_PREFIX}`;
const WEB_ROUTE_HOST_TARGET = String.raw`(?:(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|\[::1\])(?::\d{1,5})?(?:\/[^\s"';&|]*)?|(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,63}(?::\d{1,5})?(?:\/[^\s"';&|]*)?)`;
const NETWORK_ROUTE_TARGET = String.raw`(?:https?:\/\/|${WEB_ROUTE_HOST_TARGET})`;
const LOCAL_BROWSER_DOCUMENT_TARGET = String.raw`(?:file:\/\/[^\s"';&|]*\.html?|[^\s"';&|]*\.html?)(?:[?#][^\s"';&|]*)?`;
const BROWSER_ROUTE_TARGET = String.raw`(?:https?:\/\/|${LOCAL_BROWSER_DOCUMENT_TARGET})`;
const NODE_INLINE_PAGE_RETRIEVAL_CALL = String.raw`(?:(?:(?:globalThis|window)\s*\.\s*)?fetch\s*\(|require\s*\(\s*["'](?:node:)?https?["']\s*\)\s*\.\s*(?:get|request)\s*\()`;
const SCRIPT_RUNTIME = String.raw`(?:python(?:3(?:\.\d+)?)?|py|ruby|perl|php|bun|deno)`;
const INLINE_SCRIPT_FLAG = String.raw`(?:-c|-e|-r|--eval|--code|eval)`;
const INLINE_WEB_CLIENT_MARKER = String.raw`(?:requests\s*\.|urllib(?:\.request)?\s*\.|httpx\s*\.|aiohttp|webbrowser\s*\.|Net::HTTP|open-uri|LWP::UserAgent|HTTP::Tiny|file_get_contents\s*\(|curl_init\s*\(|fetch\s*\(|playwright|puppeteer|selenium|pyppeteer)`;
const EXTERNAL_BROWSER_LAUNCH_REGEX_SOURCES = [
  String.raw`${POSIX_BROWSER_COMMAND_START}(?:[^\s;&|]*[/\\])?open\s+(?:-[a-z]+\s+)*["']?${BROWSER_ROUTE_TARGET}[\s\S]*`,
  String.raw`${POSIX_BROWSER_COMMAND_START}(?:[^\s;&|]*[/\\])?(?:xdg-open|sensible-browser)\s+["']?${BROWSER_ROUTE_TARGET}[\s\S]*`,
  String.raw`${POSIX_BROWSER_COMMAND_START}(?:[^\s;&|]*[/\\])?gio\s+open\s+["']?${BROWSER_ROUTE_TARGET}[\s\S]*`,
  String.raw`${SHELL_COMMAND_SEGMENT_START}(?:Start-Process|start|explorer(?:\.exe)?)\b[^\r\n;&|]*${BROWSER_ROUTE_TARGET}[\s\S]*`,
  String.raw`${SHELL_COMMAND_SEGMENT_START}(?:cmd(?:\.exe)?\s+\/(?:c|k)\s+start|(?:powershell|pwsh)(?:\.exe)?\b[^\r\n;&|]*Start-Process)\b[^\r\n;&|]*${BROWSER_ROUTE_TARGET}[\s\S]*`,
  String.raw`${POSIX_BROWSER_COMMAND_START}(?:[^\s;&|]*[/\\])?(?:google-chrome(?:-stable)?|chromium(?:-browser)?|chrome(?:\.exe)?|firefox(?:\.exe)?|brave(?:-browser|\.exe)?|msedge(?:\.exe)?|microsoft-edge(?:-stable)?|safari|opera|vivaldi|comet)(?:\s|$)[\s\S]*`,
  String.raw`${POSIX_BROWSER_COMMAND_START}["'][^"']*(?:Google Chrome|Chromium|Safari|Firefox|Brave Browser|Microsoft Edge|Arc|Comet|Opera|Vivaldi)\.app[/\\][^"']*["'](?:\s|$)[\s\S]*`,
  String.raw`${POSIX_BROWSER_COMMAND_START}(?:[^\s;&|]*[/\\])?osascript\b[\s\S]*(?:Google Chrome|Chromium|Safari|Firefox|Brave(?: Browser)?|Microsoft Edge|Arc|Comet|Opera|Vivaldi)[\s\S]*`,
  String.raw`${POSIX_BROWSER_COMMAND_START}(?:[^\s;&|]*[/\\])?(?:curl|wget|http|httpie)\b[^\r\n;&|]*(?:\s|=)["']?${NETWORK_ROUTE_TARGET}[\s\S]*`,
  String.raw`${POSIX_BROWSER_COMMAND_START}(?:[^\s;&|]*[/\\])?(?:lynx|w3m)\b[^\r\n;&|]*(?:\s|=)["']?(?:${NETWORK_ROUTE_TARGET}|${LOCAL_BROWSER_DOCUMENT_TARGET})[\s\S]*`,
  String.raw`${POSIX_BROWSER_COMMAND_START}(?:[^\s;&|]*[/\\])?node(?:\.exe)?\b[^\r\n;&|]*\s(?:-e|--eval|-p|--print)(?:=|\s+)[^\r\n;&|]*${NODE_INLINE_PAGE_RETRIEVAL_CALL}[^\r\n;&|]*https?:\/\/[\s\S]*`,
  String.raw`${POSIX_BROWSER_COMMAND_START}(?:[^\s;&|]*[/\\])?${SCRIPT_RUNTIME}(?:\.exe)?\b[^\r\n;&|]*\s${INLINE_SCRIPT_FLAG}(?:=|\s+)[\s\S]*${INLINE_WEB_CLIENT_MARKER}[\s\S]*(?:https?:\/\/|${WEB_ROUTE_HOST_TARGET})[\s\S]*`,
  String.raw`${POSIX_BROWSER_COMMAND_START}(?:[^\s;&|]*[/\\])?(?:python(?:3(?:\.\d+)?)?|py)(?:\.exe)?\b[^\r\n;&|]*\s-m\s+(?:webbrowser|httpie|requests|playwright|selenium)\b[^\r\n;&|]*(?:https?:\/\/|${WEB_ROUTE_HOST_TARGET})[\s\S]*`,
  String.raw`${POSIX_BROWSER_COMMAND_START}(?:[^\s;&|]*[/\\])?(?:python(?:3(?:\.\d+)?)?|py)(?:\.exe)?\b[^\r\n;&|]*\s${INLINE_SCRIPT_FLAG}(?:=|\s+)[\s\S]*(?:subprocess\s*\.\s*(?:run|call|Popen|check_call|check_output)|os\s*\.\s*system)[\s\S]*(?:open|google-chrome|chromium|firefox|brave-browser|msedge|microsoft-edge|opera|vivaldi|comet)[\s\S]*`,
  String.raw`${POSIX_BROWSER_COMMAND_START}(?:[^\s;&|]*[/\\])?deno(?:\.exe)?\b[^\r\n;&|]*\brun\b[^\r\n;&|]*--allow-net(?:=|\s|$)[^\r\n;&|]*(?:https?:\/\/|${WEB_ROUTE_HOST_TARGET})[\s\S]*`,
] as const;

function regexSourceForCommandGlob(glob: string): string {
  return glob
    .split("*")
    .map((part) => part.replace(/[\\^$.[\]{}()+?|]/gu, "\\$&"))
    .join("[\\s\\S]*");
}

/**
 * Portable source shared with the Codex JavaScript hook. Keep this free of
 * runtime-specific lookbehind so the same launch policy works in native and
 * WSL Node runtimes.
 */
export const COMPETING_BROWSER_COMMAND_REGEX_SOURCE = `^(?:${COMPETING_BROWSER_COMMAND_GLOBS.map(
  regexSourceForCommandGlob,
)
  .concat(EXTERNAL_BROWSER_LAUNCH_REGEX_SOURCES)
  .join("|")})$`;

const COMPETING_BROWSER_COMMAND_RE = new RegExp(COMPETING_BROWSER_COMMAND_REGEX_SOURCE, "iu");

export function isCompetingBrowserCommand(command: string | readonly string[]): boolean {
  return COMPETING_BROWSER_COMMAND_RE.test(
    typeof command === "string" ? command : command.join(" "),
  );
}

const STRONG_COMPETING_BROWSER_MARKERS = [
  /(?:^|-)playwright(?:-|$)/u,
  /(?:^|-)puppeteer(?:-|$)/u,
  /(?:^|-)selenium(?:-|$)/u,
  /(?:^|-)gstack(?:-|$)/u,
  /(?:^|-)stagehand(?:-|$)/u,
  /(?:^|-)browserbase(?:-|$)/u,
  /(?:^|-)browserstack(?:-|$)/u,
  /(?:^|-)browserless(?:-|$)/u,
  /(?:^|-)chrome(?:-|$)/u,
  /(?:^|-)chromium(?:-|$)/u,
  /(?:^|-)firefox(?:-|$)/u,
  /(?:^|-)webkit(?:-|$)/u,
  /(?:^|-)webdriver(?:-|$)/u,
  /(?:^|-)node-repl(?:-|$)/u,
  /(?:^|-)browser-?mcp(?:-|$)/u,
  /(?:^|-)browser-(?:use|automation|control|driver)(?:-|$)/u,
  /(?:^|-)control-in-app-browser(?:-|$)/u,
] as const;

const GENERIC_BROWSER_IDENTITY_MARKER = /(?:^|-)(?:browser|browse)(?:-|$)/u;
const BROWSER_DESCRIPTION_MARKERS = [
  /(?:^|-)headless-browser(?:-|$)/u,
  /(?:^|-)browser-(?:automation|control|driver|testing|qa)(?:-|$)/u,
  /(?:^|-)control-(?:the-)?browser(?:-|$)/u,
] as const;

const NATIVE_BROWSER_APP_MARKERS = [
  /(?:^|-)chrome(?:-|$)/u,
  /(?:^|-)chromium(?:-|$)/u,
  /(?:^|-)safari(?:-|$)/u,
  /(?:^|-)firefox(?:-|$)/u,
  /(?:^|-)brave(?:-|$)/u,
  /(?:^|-)msedge(?:-|$)/u,
  /(?:^|-)microsoft-edge(?:-|$)/u,
  /(?:^|-)arc(?:-|$)/u,
  /(?:^|-)comet(?:-|$)/u,
  /(?:^|-)opera(?:-|$)/u,
  /(?:^|-)vivaldi(?:-|$)/u,
  /(?:^|-)orion(?:-|$)/u,
  /(?:^|-)duckduckgo(?:-|$)/u,
  /(?:^|-)zen-browser(?:-|$)/u,
] as const;

function normalizedCapabilityText(value: string | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

const NORMALIZED_COMPETING_BROWSER_SKILL_NAMES = COMPETING_BROWSER_SKILL_NAMES.map((name) =>
  normalizedCapabilityText(name),
);

/** Match case and namespace variants such as `GStack` and `vendor/PlayWright`. */
export function isCompetingBrowserSkillIdentity(value: string | undefined): boolean {
  const normalized = normalizedCapabilityText(value);
  return NORMALIZED_COMPETING_BROWSER_SKILL_NAMES.some(
    (name) => normalized === name || normalized.endsWith(`-${name}`),
  );
}

export function isCompetingBrowserAppIdentity(...values: readonly (string | undefined)[]): boolean {
  return values.some((value) => {
    const normalized = normalizedCapabilityText(value);
    return NATIVE_BROWSER_APP_MARKERS.some((marker) => marker.test(normalized));
  });
}

export function isCompetingBrowserCapabilityText(
  ...values: readonly (string | undefined)[]
): boolean {
  return values.some((value) => {
    const normalized = normalizedCapabilityText(value);
    return STRONG_COMPETING_BROWSER_MARKERS.some((marker) => marker.test(normalized));
  });
}

/** Match a capability's declared identity, where a bare Browser name is meaningful. */
export function isCompetingBrowserCapabilityIdentity(
  ...values: readonly (string | undefined)[]
): boolean {
  return values.some((value) => {
    const normalized = normalizedCapabilityText(value);
    return (
      GENERIC_BROWSER_IDENTITY_MARKER.test(normalized) ||
      STRONG_COMPETING_BROWSER_MARKERS.some((marker) => marker.test(normalized))
    );
  });
}

const STRONG_BROWSER_TOOL_MARKERS = [
  /(?:^|-)(?:browser|browse|playwright|puppeteer|selenium|webdriver)(?:-|$)/u,
  /(?:^|-)(?:web|page|dom|tab)-(?:open|navigate|visit|goto|click|type|fill|select|inspect|read|content|snapshot|screenshot|evaluate|execute|close|reload|back|forward|search|fetch|scrape|crawl)(?:-|$)/u,
  /(?:^|-)(?:open|navigate|visit|goto|click|type|fill|select|inspect|read|snapshot|screenshot|evaluate|execute|close|reload|back|forward|scrape|crawl)-(?:web|page|dom|tab|url|site)(?:-|$)/u,
  /(?:^|-)(?:web-search|web-fetch|fetch-url|open-url|page-content|page-source|list-tabs)(?:-|$)/u,
  /(?:^|-)(?:internet|online|google)-(?:search|fetch|lookup|browse)(?:-|$)/u,
  /(?:^|-)(?:search|fetch|lookup|browse)-(?:internet|online|google)(?:-|$)/u,
] as const;

const GENERIC_WEB_TOOL_ACTION_MARKER =
  /(?:^|-)(?:open|navigate|visit|goto|click|type|fill|select|inspect|read|content|snapshot|screenshot|evaluate|execute|close|reload|back|forward|search|fetch|scrape|crawl)(?:-|$)/u;
const WEB_TOOL_CONTEXT_MARKER =
  /(?:^|-)(?:browser|web|webpage|website|page|dom|tab|url|site|http|html|internet|online|google)(?:-|$)/u;

/**
 * Classify advertised MCP tools after discovery, rather than trusting a
 * server's configured label. This closes the neutral-wrapper case where an
 * MCP named `utilities` advertises `go` with “navigate the browser” only after
 * the provider connects.
 */
export function isCompetingBrowserToolDescriptor(name: string, description?: string): boolean {
  const normalizedName = normalizedCapabilityText(name);
  const normalizedDescription = normalizedCapabilityText(description);
  if (STRONG_BROWSER_TOOL_MARKERS.some((marker) => marker.test(normalizedName))) return true;
  const combined = `${normalizedName}-${normalizedDescription}`;
  return GENERIC_WEB_TOOL_ACTION_MARKER.test(combined) && WEB_TOOL_CONTEXT_MARKER.test(combined);
}

export function hasYSpaceBrowserMcp(
  servers: readonly Pick<ResolvedMcpServer, "id" | "name">[],
): boolean {
  return servers.some((server) => server.id === "browser" && server.name === "browser");
}

export function isCompetingBrowserMcpServer(server: BrowserMcpCandidate): boolean {
  if (server.id === "browser" && server.name === "browser") return false;
  const transport = server.transport;
  const transportDetails =
    transport.type === "stdio" ? [transport.command, ...transport.args] : [transport.url];
  const normalizedDescription = normalizedCapabilityText(server.description);
  return (
    isCompetingBrowserCapabilityIdentity(server.id, server.name) ||
    isCompetingBrowserCapabilityText(server.description, ...transportDetails) ||
    BROWSER_DESCRIPTION_MARKERS.some((marker) => marker.test(normalizedDescription)) ||
    server.tools?.some((tool) => isCompetingBrowserToolDescriptor(tool.name, tool.description)) ===
      true
  );
}

export function filterCompetingBrowserMcpServers<T extends BrowserMcpCandidate>(
  servers: readonly T[],
): T[] {
  return servers.filter((server) => !isCompetingBrowserMcpServer(server));
}

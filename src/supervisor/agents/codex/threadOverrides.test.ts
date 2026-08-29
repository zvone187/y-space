import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedMcpServer } from "@/shared/contracts";
import { resolveLaunchSpec } from "../base";
import { codexMcpTokenEnvVar } from "../userMcp";
import { buildCodexAppServerCommand, buildCodexArgvFor } from "./argv";
import { buildCodexThreadOverrides } from "./threadOverrides";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function expectBrowserExclusiveCodexArgs(args: readonly string[]): void {
  const overrides = args.flatMap((arg, index) => (arg === "-c" ? [args[index + 1]] : []));
  const rendered = args.join(" ");
  for (const expected of [
    "features.browser_use=false",
    "features.browser_use_external=false",
    "features.browser_use_full_cdp_access=false",
    "features.in_app_browser=false",
    "features.computer_use=false",
    "features.standalone_web_search=false",
    "features.code_mode.enabled=false",
    'features.code_mode.direct_only_tool_namespaces=["functions"]',
    "features.code_mode_only=false",
    "features.code_mode_host=true",
    'web_search="disabled"',
    'plugins."browser@openai-bundled".enabled=false',
    "mcp_servers.node_repl.enabled=false",
    "mcp_servers.playwright.enabled=false",
    "mcp_servers.chrome_devtools.enabled=false",
    'mcp_servers.browser.url="http://127.0.0.1:9000/mcp"',
    "mcp_servers.browser.enabled=true",
    "mcp_servers.browser.required=true",
    'mcp_servers.browser.omit_tools_from=["deferred"]',
  ]) {
    expect(overrides.includes(expected) || rendered.includes(expected)).toBe(true);
  }
}

describe("buildCodexThreadOverrides", () => {
  it("scopes cwd and MCP configuration to the app-server thread", () => {
    const browser: ResolvedMcpServer = {
      id: "browser",
      name: "browser",
      timeoutMs: 30_000,
      transport: {
        type: "http",
        url: "http://127.0.0.1:9000/mcp?thread=local-thread",
        headers: { Authorization: "Bearer secret-token" },
      },
    };

    const overrides = buildCodexThreadOverrides(
      { model: "gpt-5.6", effort: "high" },
      {
        projectLocation: { kind: "windows", path: "C:\\repo" },
        mcpServers: [browser],
      },
    );

    expect(overrides.cwd).toBe("C:\\repo");
    expect(overrides.config).toMatchObject({
      model_reasoning_effort: "high",
      model_context_window: 400_000,
      model_auto_compact_token_limit: 380_000,
      "mcp_servers.browser": {
        url: "http://127.0.0.1:9000/mcp?thread=local-thread",
        bearer_token_env_var: codexMcpTokenEnvVar(browser),
        enabled: true,
        required: true,
        omit_tools_from: ["deferred"],
        tool_timeout_sec: 30,
      },
    });
    expect(JSON.stringify(overrides.config)).not.toContain("secret-token");
  });

  it("makes Y Space Browser the sole browser route in TUI and app-server launches", () => {
    const browser: ResolvedMcpServer = {
      id: "browser",
      name: "browser",
      timeoutMs: 30_000,
      transport: {
        type: "http",
        url: "http://127.0.0.1:9000/mcp",
        headers: {},
      },
    };
    const projectPath = mkdtempSync(join(tmpdir(), "y-space-codex-browser-policy-"));
    tempDirs.push(projectPath);
    mkdirSync(join(projectPath, ".codex"));
    writeFileSync(
      join(projectPath, ".codex", "config.toml"),
      [
        '[mcp_servers.node_repl]\ncommand = "node_repl"',
        '[mcp_servers.playwright]\ncommand = "playwright"',
        '[mcp_servers.chrome_devtools]\nurl = "http://chrome.test/mcp"',
      ].join("\n"),
    );
    const location = { kind: "posix" as const, path: projectPath };

    const tui = buildCodexArgvFor(location, { model: "gpt-5.6" }, "", undefined, {
      mcpServers: [browser],
    });
    const appServer = buildCodexAppServerCommand(location, {
      mcpServers: [browser],
      browserExclusiveHook: {
        codexHomeDir: "/private/y-space/codex/home",
        sqliteHomeDir: "/home/demo/.codex",
        featureFlag: "hooks",
      },
    });

    expectBrowserExclusiveCodexArgs(tui.args);
    expectBrowserExclusiveCodexArgs(appServer.args);
    const renderedAppServerArgs = appServer.args.join(" ");
    expect(renderedAppServerArgs).toContain("--dangerously-bypass-hook-trust");
    expect(renderedAppServerArgs).toContain("--enable");
    expect(renderedAppServerArgs).toContain("hooks");
    expect(appServer.env?.CODEX_HOME).toBe("/private/y-space/codex/home");
    expect(appServer.env?.CODEX_SQLITE_HOME).toBe("/home/demo/.codex");
    for (const env of [tui.env, appServer.env]) {
      expect(env?.PORACODE_CODEX_BROWSER_EXCLUSIVE).toBe("1");
      expect(env?.PORACODE_BROWSER_COMMAND_DENY_REGEX).toMatch(/playwright/iu);
      expect(env?.PORACODE_BROWSER_COMMAND_DENY_REGEX).toMatch(/Google/iu);
    }
    expect(appServer.args.some((arg) => arg === "app-server" || arg.includes("'app-server'"))).toBe(
      true,
    );

    expect(
      buildCodexThreadOverrides(
        { model: "gpt-5.6" },
        { projectLocation: location, mcpServers: [browser] },
      ).config,
    ).toMatchObject({
      "features.browser_use": false,
      "features.browser_use_external": false,
      "features.browser_use_full_cdp_access": false,
      "features.in_app_browser": false,
      "features.computer_use": false,
      "features.standalone_web_search": false,
      "features.code_mode.enabled": false,
      "features.code_mode.direct_only_tool_namespaces": ["functions"],
      "features.code_mode_only": false,
      "features.code_mode_host": true,
      web_search: "disabled",
      'plugins."browser@openai-bundled".enabled': false,
      "mcp_servers.node_repl": { enabled: false },
      "mcp_servers.playwright": { enabled: false },
      "mcp_servers.chrome_devtools": { enabled: false },
      "mcp_servers.browser": {
        url: "http://127.0.0.1:9000/mcp",
        enabled: true,
        required: true,
        omit_tools_from: ["deferred"],
      },
    });
  });

  it("does not enable the Codex shell gate when managed Browser is absent", () => {
    const location = { kind: "posix" as const, path: "/repo" };

    expect(
      buildCodexArgvFor(location, { model: "gpt-5.6" }, "").env?.PORACODE_CODEX_BROWSER_EXCLUSIVE,
    ).toBeUndefined();
    expect(
      buildCodexAppServerCommand(location).env?.PORACODE_CODEX_BROWSER_EXCLUSIVE,
    ).toBeUndefined();
  });

  it("keeps WSL app-server MCP credentials out of wsl.exe argv", () => {
    const secret = "codex-wsl-http-mcp-secret-sentinel";
    const stdioSecret = "codex-wsl-stdio-mcp-secret-sentinel";
    const browser: ResolvedMcpServer = {
      id: "browser",
      name: "browser",
      timeoutMs: 30_000,
      transport: {
        type: "http",
        url: "http://127.0.0.1:9000/mcp",
        headers: { Authorization: `Bearer ${secret}` },
      },
    };
    const command = buildCodexAppServerCommand(
      {
        kind: "wsl",
        distro: "Ubuntu",
        linuxPath: "/work/project",
        uncPath: "\\\\wsl.localhost\\Ubuntu\\work\\project",
      },
      {
        wslExecPath: "/home/demo/.local/bin/codex",
        mcpServers: [
          browser,
          {
            id: "stdio",
            name: "stdio",
            timeoutMs: 30_000,
            transport: {
              type: "stdio",
              command: "node",
              args: ["server.js"],
              env: { STDIO_API_KEY: stdioSecret },
            },
          },
        ],
      },
    );

    expect(JSON.stringify(command.args)).not.toContain(secret);
    expect(JSON.stringify(command.args)).not.toContain(stdioSecret);
    expect(command.args).toContain("/bin/sh");
    expect(command.args.join(" ")).toContain("__y_space_launch_env_file");
    expect(command.cleanup).toEqual(expect.any(Function));

    command.cleanup?.();
  });

  it("keeps native and WSL TUI stdio MCP credentials out of provider argv", () => {
    const secret = "codex-tui-stdio-mcp-secret-sentinel";
    const stdio: ResolvedMcpServer = {
      id: "stdio",
      name: "stdio",
      timeoutMs: 30_000,
      transport: {
        type: "stdio",
        command: "node",
        args: ["server.js"],
        env: { STDIO_API_KEY: secret },
      },
    };
    const native = resolveLaunchSpec(
      { kind: "posix", path: "/repo" },
      buildCodexArgvFor({ kind: "posix", path: "/repo" }, { model: "gpt-5.6" }, "", undefined, {
        mcpServers: [stdio],
      }),
    );
    const wslLocation = {
      kind: "wsl" as const,
      distro: "Ubuntu",
      linuxPath: "/work/project",
      uncPath: "\\\\wsl.localhost\\Ubuntu\\work\\project",
    };
    const wsl = resolveLaunchSpec(
      wslLocation,
      buildCodexArgvFor(wslLocation, { model: "gpt-5.6" }, "", undefined, {
        mcpServers: [stdio],
      }),
    );

    expect(JSON.stringify(native.args)).not.toContain(secret);
    expect(JSON.stringify(wsl.args)).not.toContain(secret);
    expect(native.env?.STDIO_API_KEY).toBe(secret);
    expect(wsl.cleanup).toEqual(expect.any(Function));

    wsl.cleanup?.();
  });

  it("maps a selected context size to the window and 95% compact limit", () => {
    const overrides = buildCodexThreadOverrides({ model: "gpt-5.6-sol", contextSize: "1m" });

    expect(overrides.config).toMatchObject({
      model_context_window: 1_000_000,
      model_auto_compact_token_limit: 950_000,
    });
  });
});

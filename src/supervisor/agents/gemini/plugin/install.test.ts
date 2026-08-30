import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildGeminiWslPrivateSettingsWriteSpec,
  cleanupTrackedGeminiLaunchSettingsForExit,
  createGeminiLaunchSettingsFile,
  getGeminiPluginPaths,
  installGeminiPlugin,
  isGeminiPluginInstalled,
  renderGeminiSettings,
  trackGeminiLaunchCleanup,
} from "./install";

const tempDirs: string[] = [];

function makeBaseDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "poracode-gemini-plugin-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("getGeminiPluginPaths", () => {
  it("places Gemini settings under Poracode's plugin dir", () => {
    const baseDir = makeBaseDir();
    const paths = getGeminiPluginPaths({ envKind: "posix", baseDir });

    expect(paths.pluginDir).toBe(join(baseDir, "agent-plugins", "gemini"));
    expect(paths.settingsPath).toBe(join(baseDir, "agent-plugins", "gemini", "settings.json"));
  });

  it("creates a private MCP launch snapshot without installing the status plugin", () => {
    const baseDir = makeBaseDir();
    const ctx = {
      envKind: "posix" as const,
      baseDir,
      mcpServers: [
        {
          id: "memory-id",
          name: "memory",
          description: "",
          enabled: true,
          timeoutMs: 30_000,
          transport: { type: "stdio" as const, command: "memory-server", args: [], env: {} },
        },
      ],
    };

    const launchSettings = createGeminiLaunchSettingsFile(ctx, ctx.mcpServers);
    expect(launchSettings).toBeDefined();

    expect(readSettings(launchSettings!.settingsPath).mcpServers).toMatchObject({
      memory: { command: "memory-server", timeout: 30_000 },
    });
    expect(existsSync(getGeminiPluginPaths(ctx).settingsPath)).toBe(false);
    launchSettings!.cleanup();
  });
});

describe("renderGeminiSettings", () => {
  it("renders only the trimmed hook surface with the resolved-node command prefix", () => {
    const commandPrefix =
      "'/home/demo/.nvm/versions/node/v22.11.0/bin/node' '/home/demo/.poracode/agent-plugins/gemini/forward.mjs'";
    const doc = renderGeminiSettings({ headExpression: commandPrefix });

    expect(doc.hooksConfig).toEqual({ notifications: false });
    expect(Object.keys(doc.hooks)).toEqual([
      "SessionStart",
      "BeforeAgent",
      "AfterAgent",
      "Notification",
    ]);
    expect(doc.hooks.SessionStart?.[0]?.matcher).toBeUndefined();
    expect(doc.hooks.BeforeAgent?.[0]?.matcher).toBeUndefined();
    expect(doc.hooks.AfterAgent?.[0]?.matcher).toBeUndefined();
    expect(doc.hooks.Notification?.[0]?.matcher).toBeUndefined();
    expect(doc.hooks.AfterAgent?.[0]?.hooks[0]).toMatchObject({
      name: "poracode-status-AfterAgent",
      type: "command",
      command: `${commandPrefix} AfterAgent`,
      timeout: 5000,
    });
  });

  it("does not register dropped redundant turn-open hooks", () => {
    const doc = renderGeminiSettings({ headExpression: "'/usr/bin/node' '/tmp/forward.mjs'" });
    expect(doc.hooks.BeforeModel).toBeUndefined();
    expect(doc.hooks.BeforeTool).toBeUndefined();
    expect(doc.hooks.AfterTool).toBeUndefined();
  });
});

describe("installGeminiPlugin", () => {
  it("stages assets and writes a private Gemini system settings file", () => {
    const baseDir = makeBaseDir();

    const result = installGeminiPlugin({ envKind: "posix", baseDir });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(existsSync(join(result.paths.pluginDir, "plugin.json"))).toBe(true);
    expect(existsSync(join(result.paths.pluginDir, "forward.mjs"))).toBe(true);
    expect(existsSync(result.paths.settingsPath)).toBe(true);
    expect(isGeminiPluginInstalled({ envKind: "posix", baseDir })).toMatchObject({
      installed: true,
      version: "1.2.3",
    });

    const settings = JSON.parse(readFileSync(result.paths.settingsPath, "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const command = settings.hooks.Notification?.[0]?.hooks[0]?.command ?? "";
    expect(command).toMatch(/agent-plugins[\\/]+gemini[\\/]+poracode-hook\.(?:sh|cmd|ps1)/);
    expect(command).toMatch(
      process.platform === "win32"
        ? /^(?:pwsh(?:\.exe)?|powershell(?:\.exe)?|cmd\.exe \/d \/s \/c call ")/
        : /^(?!cmd\.exe)/,
    );
  });

  it("preserves unrelated shared MCP config while rejecting launch-scoped MCP projection", () => {
    const baseDir = makeBaseDir();
    const ctx = { envKind: "posix" as const, baseDir };
    const first = installGeminiPlugin(ctx);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const existing = JSON.parse(readFileSync(first.paths.settingsPath, "utf8")) as Record<
      string,
      unknown
    >;
    writeFileSync(
      first.paths.settingsPath,
      `${JSON.stringify({
        ...existing,
        mcpServers: {
          remoteUser: {
            httpUrl: "https://mcp.example.test/service",
            headers: { Authorization: "Bearer preserve-remote-user-secret" },
            timeout: 30_000,
          },
          "pipedream-slack-deadbeef0001": {
            httpUrl: "http://127.0.0.1:43125/mcp/stale-binding",
            headers: { authorization: "Bearer stale-pipedream-secret" },
            timeout: 30_000,
          },
        },
      })}\n`,
      "utf8",
    );

    const reinstall = installGeminiPlugin({
      ...ctx,
      mcpServers: [
        {
          id: "pipedream:launch-only",
          name: "pipedream-gmail-deadbeef0002",
          timeoutMs: 30_000,
          transport: {
            type: "http",
            url: "http://127.0.0.1:43126/mcp/live-binding",
            headers: { authorization: "Bearer must-stay-launch-only" },
          },
        },
      ],
    });
    expect(reinstall.ok).toBe(true);
    const serialized = readFileSync(first.paths.settingsPath, "utf8");
    const settings = JSON.parse(serialized) as McpSettings;
    expect(settings.mcpServers?.remoteUser).toMatchObject({
      httpUrl: "https://mcp.example.test/service",
      headers: { Authorization: "Bearer preserve-remote-user-secret" },
    });
    expect(settings.mcpServers?.["pipedream-slack-deadbeef0001"]).toBeUndefined();
    expect(serialized).not.toMatch(/(?:stale-pipedream-secret|must-stay-launch-only)/u);
  });
});

type McpSettings = {
  mcpServers?: Record<string, { httpUrl?: string; headers?: Record<string, string> }>;
};

function readSettings(path: string): McpSettings {
  return JSON.parse(readFileSync(path, "utf8")) as McpSettings;
}

describe("createGeminiLaunchSettingsFile", () => {
  it("keeps a failed outward cleanup tracked so process-exit cleanup can retry it", () => {
    const baseDir = makeBaseDir();
    const privateDir = join(baseDir, ".poracode-launch-deadbeef");
    const privateFile = join(privateDir, "settings.json");
    mkdirSync(privateDir, { recursive: true });
    writeFileSync(privateFile, "Bearer retry-cleanup-secret", "utf8");
    let attempts = 0;
    const cleanup = trackGeminiLaunchCleanup(() => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient delete failure");
      rmSync(privateDir, { recursive: true, force: true });
    });

    expect(() => cleanup()).not.toThrow();
    expect(attempts).toBe(1);
    expect(existsSync(privateFile)).toBe(true);

    cleanupTrackedGeminiLaunchSettingsForExit();

    expect(attempts).toBe(2);
    expect(existsSync(privateFile)).toBe(false);
    cleanupTrackedGeminiLaunchSettingsForExit();
    expect(attempts).toBe(2);
  });

  it("tracks private launch snapshots for synchronous process-exit cleanup", () => {
    const baseDir = makeBaseDir();
    const launch = createGeminiLaunchSettingsFile({ envKind: "posix", baseDir }, [
      {
        id: "pipedream:exit-cleanup",
        name: "pipedream-slack-deadbeef0003",
        timeoutMs: 30_000,
        transport: {
          type: "http",
          url: "http://127.0.0.1:43127/mcp/exit-cleanup",
          headers: { authorization: "Bearer exit-cleanup-secret" },
        },
      },
    ]);
    expect(launch).toBeDefined();
    expect(existsSync(launch!.settingsPath)).toBe(true);

    cleanupTrackedGeminiLaunchSettingsForExit();

    expect(existsSync(launch!.settingsPath)).toBe(false);
    expect(() => launch!.cleanup()).not.toThrow();
  });

  it("writes WSL launch JSON over stdin and verifies 0700/0600 modes inside the distro", () => {
    const spec = buildGeminiWslPrivateSettingsWriteSpec(
      "Ubuntu",
      "/home/demo/.poracode/agent-plugins/gemini/.poracode-launch-deadbeef",
      "/home/demo/.poracode/agent-plugins/gemini/.poracode-launch-deadbeef/settings.json",
    );
    const serializedSecret = "Bearer must-travel-over-stdin-only";
    const argv = spec.args.join("\n");

    expect(spec.command.toLowerCase()).toContain("wsl");
    expect(argv).not.toContain(serializedSecret);
    expect(argv).toContain("umask 077");
    expect(argv).toContain('chmod 700 -- "$1"');
    expect(argv).toContain('chmod 600 -- "$2"');
    expect(argv).toContain('stat -c %a -- "$1"');
    expect(argv).toContain('stat -c %a -- "$2"');
  });

  it("fails closed when a required WSL launch has no resolved private settings path", () => {
    expect(() =>
      createGeminiLaunchSettingsFile({ envKind: "wsl", wslDistro: "YSpace-Uncached-Test-Distro" }, [
        {
          id: "pipedream:required",
          name: "pipedream-gmail-deadbeef0002",
          timeoutMs: 30_000,
          transport: {
            type: "http",
            url: "http://127.0.0.1:43126/mcp/required-binding",
            headers: { authorization: "Bearer required-launch-secret" },
          },
        },
      ]),
    ).toThrow(/private Gemini MCP launch settings path/u);
  });

  it("projects provider-neutral MCP configuration only into the launch snapshot", () => {
    const baseDir = makeBaseDir();
    const ctx = { envKind: "posix" as const, baseDir };
    const install = installGeminiPlugin(ctx);
    expect(install.ok).toBe(true);
    if (!install.ok) return;
    const settingsPath = install.paths.settingsPath;
    const servers = [
      {
        id: "runtime",
        name: "runtime",
        timeoutMs: 45_000,
        transport: {
          type: "http" as const,
          url: "http://127.0.0.1:9200/mcp",
          headers: { Authorization: "Bearer token" },
        },
      },
    ];

    const launchSettings = createGeminiLaunchSettingsFile(ctx, servers);
    expect(launchSettings).toBeDefined();
    expect(readSettings(launchSettings!.settingsPath).mcpServers).toEqual({
      runtime: {
        httpUrl: "http://127.0.0.1:9200/mcp",
        headers: { Authorization: "Bearer token" },
        timeout: 45_000,
      },
    });
    expect(readSettings(settingsPath).mcpServers).toBeUndefined();
    launchSettings!.cleanup();
  });
});

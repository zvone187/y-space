import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProjectLocation, ThreadConfig } from "@/shared/contracts";
import type { OscTitle } from "@/shared/osc";
import { createGeminiAdapter } from ".";
import { buildGeminiArgs } from "./argv";
import { geminiIntentFor } from "./plugin/intentMap";
import { installGeminiPlugin } from "./plugin/install";
import { detectGeminiInvalidSessionRef } from "./session";
import { detectGeminiOscTitleStatus } from "./terminal";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("detectGeminiOscTitleStatus", () => {
  it("detects idle from ◇ Ready title bar indicator", () => {
    const text = "◇  Ready (my-project)";
    expect(detectGeminiOscTitleStatus(text)).toEqual({
      status: "idle",
      attention: "none",
      corroborated: true,
    });
  });

  it("detects working from ✦ Working title bar indicator", () => {
    const text = "✦  Working… (my-project)";
    expect(detectGeminiOscTitleStatus(text)).toEqual({
      status: "working",
      attention: "working",
      corroborated: true,
    });
  });

  it("detects needs_reply from ✋ Action Required title bar indicator", () => {
    const text = "✋  Action Required (my-project)";
    const result = detectGeminiOscTitleStatus(text);
    expect(result?.status).toBe("needs_reply");
    expect(result?.attention).toBe("needs_reply");
  });

  it("returns null when no pattern matches", () => {
    expect(detectGeminiOscTitleStatus("Type your message or @path/to/file")).toBeNull();
    expect(detectGeminiOscTitleStatus("? for shortcuts")).toBeNull();
    expect(detectGeminiOscTitleStatus("⠋ Thinking... (esc to cancel, 2s)")).toBeNull();
  });
});

describe("createGeminiAdapter handleOscNotification", () => {
  const adapter = createGeminiAdapter();

  it("maps iTerm2 OSC 9;4 progress to working and idle", () => {
    expect(
      adapter.handleOscNotification?.({ code: 9, title: "", body: "4;3;0", payload: undefined }),
    ).toEqual({
      status: "working",
      attention: "working",
      corroborated: true,
    });
    expect(
      adapter.handleOscNotification?.({ code: 9, title: "", body: "4;0;0", payload: undefined }),
    ).toEqual({
      status: "idle",
      attention: "none",
      corroborated: true,
    });
  });
});

describe("createGeminiAdapter handleOscTitle", () => {
  const adapter = createGeminiAdapter();
  const oscTitle = (text: string, code: 0 | 1 | 2 = 0): OscTitle => ({ code, text });

  it("does not parse stripped TUI text for status", () => {
    expect(adapter.detectTerminalStatus).toBeUndefined();
  });

  it("maps Gemini title-bar status to Poracode status", () => {
    expect(adapter.handleOscTitle?.(oscTitle("✦  Working… (poracode)"))).toEqual({
      status: "working",
      attention: "working",
      corroborated: true,
    });
    expect(adapter.handleOscTitle?.(oscTitle("◇  Ready (poracode)"))).toEqual({
      status: "idle",
      attention: "none",
      corroborated: true,
    });
    expect(adapter.handleOscTitle?.(oscTitle("✋  Action Required (poracode)"))).toEqual({
      status: "needs_reply",
      attention: "needs_reply",
      corroborated: true,
    });
  });
});

describe("buildGeminiArgs", () => {
  const config: ThreadConfig = { model: "gemini-2.5-pro" };

  it("emits --session-id when an assignedSessionId is provided", () => {
    const args = buildGeminiArgs(config, "hello", undefined, "abc-uuid");
    const sessionIdx = args.indexOf("--session-id");
    expect(sessionIdx).toBeGreaterThanOrEqual(0);
    expect(args[sessionIdx + 1]).toBe("abc-uuid");
    expect(args).not.toContain("--resume");
  });

  it("prefers --resume over --session-id when both are provided", () => {
    const args = buildGeminiArgs(config, "hello", "resume-uuid", "assigned-uuid");
    expect(args).toContain("--resume");
    expect(args).toContain("resume-uuid");
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain("assigned-uuid");
  });

  it("omits both flags when neither is provided", () => {
    const args = buildGeminiArgs(config, "hello");
    expect(args).not.toContain("--resume");
    expect(args).not.toContain("--session-id");
  });
});

describe("createGeminiAdapter buildLaunchArgv", () => {
  const project: ProjectLocation = {
    kind: "windows",
    path: "C:\\demo",
  };
  const config: ThreadConfig = { model: "gemini-2.5-pro" };

  it("assigns a stable session UUID at launch and returns it as sessionRef", () => {
    const adapter = createGeminiAdapter();
    const argv = adapter.buildLaunchArgv(project, config, "hi");

    if (argv === undefined) throw new Error("expected argv");
    expect(argv.binary).toBe("gemini");

    const sessionIdx = argv.args.indexOf("--session-id");
    expect(sessionIdx).toBeGreaterThanOrEqual(0);
    const uuid = argv.args[sessionIdx + 1]!;
    expect(uuid).toMatch(UUID_RE);

    expect(argv.sessionRef?.providerSessionId).toBe(uuid);
  });

  it("uses --resume (not --session-id) on resume", () => {
    const adapter = createGeminiAdapter();
    const argv = adapter.buildResumeArgv(project, config, "hi", {
      providerSessionId: "11111111-1111-4111-8111-111111111111",
      discoveredAt: "2026-05-15T00:00:00.000Z",
    });

    if (argv === undefined) throw new Error("expected argv");
    expect(argv.args).toContain("--resume");
    expect(argv.args).toContain("11111111-1111-4111-8111-111111111111");
    expect(argv.args).not.toContain("--session-id");
  });

  it("carries custom MCP settings without depending on hook-plugin launch extras", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "poracode-gemini-mcp-"));
    const previousDataDir = process.env.PORACODE_DATA_DIR;
    process.env.PORACODE_DATA_DIR = baseDir;
    try {
      const adapter = createGeminiAdapter();
      const argv = adapter.buildLaunchArgv(project, config, "hi", undefined, {
        mcpServers: [
          {
            id: "memory-id",
            name: "memory",
            timeoutMs: 30_000,
            transport: { type: "stdio", command: "memory-server", args: [], env: {} },
          },
        ],
      });
      const settingsPath = argv.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH;

      expect(settingsPath).toMatch(/\.poracode-launch-[0-9a-f-]+[\\/]settings\.json$/u);
      expect(settingsPath).toContain(join(baseDir, "agent-plugins", "gemini"));
      expect(JSON.parse(readFileSync(settingsPath!, "utf8"))).toMatchObject({
        mcpServers: { memory: { command: "memory-server", timeout: 30_000 } },
      });
      expect(process.platform === "win32" || (statSync(settingsPath!).mode & 0o777) === 0o600).toBe(
        true,
      );
      expect(
        process.platform === "win32" || (statSync(dirname(settingsPath!)).mode & 0o777) === 0o700,
      ).toBe(true);
      argv.cleanup?.();
      expect(existsSync(settingsPath!)).toBe(false);
      expect(existsSync(dirname(settingsPath!))).toBe(false);
    } finally {
      if (previousDataDir === undefined) delete process.env.PORACODE_DATA_DIR;
      else process.env.PORACODE_DATA_DIR = previousDataDir;
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("writes launch bearers only to a private per-launch settings snapshot", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "poracode-gemini-private-mcp-"));
    const previousDataDir = process.env.PORACODE_DATA_DIR;
    process.env.PORACODE_DATA_DIR = baseDir;
    try {
      const install = installGeminiPlugin({ envKind: "posix", baseDir });
      expect(install.ok).toBe(true);
      if (!install.ok) return;
      const sharedBefore = readFileSync(install.paths.settingsPath, "utf8");
      const argv = createGeminiAdapter().buildLaunchArgv(project, config, "hi", undefined, {
        mcpServers: [
          {
            id: "pipedream:slack-account",
            name: "pipedream-slack-deadbeef0001",
            timeoutMs: 30_000,
            transport: {
              type: "http",
              url: "http://127.0.0.1:43125/mcp/private-binding",
              headers: { authorization: "Bearer launch-private-secret" },
            },
          },
        ],
      });
      const launchPath = argv.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
      expect(launchPath).toBeDefined();
      expect(readFileSync(install.paths.settingsPath, "utf8")).toBe(sharedBefore);
      expect(readFileSync(install.paths.settingsPath, "utf8")).not.toContain(
        "launch-private-secret",
      );
      expect(readFileSync(launchPath!, "utf8")).toContain("launch-private-secret");
      expect(process.platform === "win32" || (statSync(launchPath!).mode & 0o777) === 0o600).toBe(
        true,
      );
      expect(
        process.platform === "win32" || (statSync(dirname(launchPath!)).mode & 0o777) === 0o700,
      ).toBe(true);

      argv.cleanup?.();
      expect(existsSync(dirname(launchPath!))).toBe(false);
      expect(existsSync(install.paths.settingsPath)).toBe(true);
    } finally {
      if (previousDataDir === undefined) delete process.env.PORACODE_DATA_DIR;
      else process.env.PORACODE_DATA_DIR = previousDataDir;
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("isolates concurrent launch bearers and cleans each private directory independently", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "poracode-gemini-isolated-mcp-"));
    const previousDataDir = process.env.PORACODE_DATA_DIR;
    process.env.PORACODE_DATA_DIR = baseDir;
    try {
      const install = installGeminiPlugin({ envKind: "posix", baseDir });
      expect(install.ok).toBe(true);
      if (!install.ok) return;
      const launch = (secret: string) =>
        createGeminiAdapter().buildLaunchArgv(project, config, "hi", undefined, {
          mcpServers: [
            {
              id: `pipedream:${secret}`,
              name: "pipedream-slack-deadbeef0001",
              timeoutMs: 30_000,
              transport: {
                type: "http",
                url: `http://127.0.0.1:43125/mcp/${secret}`,
                headers: { authorization: `Bearer ${secret}` },
              },
            },
          ],
        });
      const first = launch("launch-secret-one");
      const second = launch("launch-secret-two");
      const firstPath = first.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
      const secondPath = second.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH;

      expect(firstPath).toBeDefined();
      expect(secondPath).toBeDefined();
      expect(firstPath).not.toBe(secondPath);
      expect(readFileSync(firstPath!, "utf8")).toContain("launch-secret-one");
      expect(readFileSync(firstPath!, "utf8")).not.toContain("launch-secret-two");
      expect(readFileSync(secondPath!, "utf8")).toContain("launch-secret-two");
      expect(readFileSync(secondPath!, "utf8")).not.toContain("launch-secret-one");
      expect(readFileSync(install.paths.settingsPath, "utf8")).not.toMatch(
        /launch-secret-(?:one|two)/u,
      );

      first.cleanup?.();
      expect(existsSync(dirname(firstPath!))).toBe(false);
      expect(existsSync(secondPath!)).toBe(true);
      second.cleanup?.();
      expect(existsSync(dirname(secondPath!))).toBe(false);
    } finally {
      if (previousDataDir === undefined) delete process.env.PORACODE_DATA_DIR;
      else process.env.PORACODE_DATA_DIR = previousDataDir;
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("fails closed when required MCP settings cannot be written privately", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "poracode-gemini-mcp-write-failure-"));
    const previousDataDir = process.env.PORACODE_DATA_DIR;
    process.env.PORACODE_DATA_DIR = baseDir;
    try {
      const pluginParent = join(baseDir, "agent-plugins");
      mkdirSync(pluginParent, { recursive: true });
      writeFileSync(join(pluginParent, "gemini"), "not-a-directory", "utf8");

      expect(() =>
        createGeminiAdapter().buildLaunchArgv(project, config, "hi", undefined, {
          mcpServers: [
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
          ],
        }),
      ).toThrow(/private Gemini MCP launch settings/u);
    } finally {
      if (previousDataDir === undefined) delete process.env.PORACODE_DATA_DIR;
      else process.env.PORACODE_DATA_DIR = previousDataDir;
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("scrubs legacy managed and loopback routing secrets without harming unrelated MCP config", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "poracode-gemini-legacy-mcp-"));
    const previousDataDir = process.env.PORACODE_DATA_DIR;
    process.env.PORACODE_DATA_DIR = baseDir;
    try {
      const install = installGeminiPlugin({ envKind: "posix", baseDir });
      expect(install.ok).toBe(true);
      if (!install.ok) return;
      const installed = JSON.parse(readFileSync(install.paths.settingsPath, "utf8")) as Record<
        string,
        unknown
      >;
      writeFileSync(
        install.paths.settingsPath,
        `${JSON.stringify(
          {
            ...installed,
            preservedSetting: "keep-me",
            mcpServers: {
              browser: {
                httpUrl: "http://127.0.0.1:43120/mcp",
                headers: { Authorization: "Bearer browser-legacy-secret" },
                timeout: 30_000,
              },
              "pipedream-slack-deadbeef0001": {
                httpUrl: "http://127.0.0.1:43125/mcp/legacy-binding",
                headers: { authorization: "Bearer pipedream-legacy-secret" },
                timeout: 30_000,
              },
              customLocal: {
                httpUrl: "http://localhost:9123/mcp",
                headers: {
                  Authorization: "Bearer local-legacy-secret",
                  "X-Y-Space-Mcp-Context": "legacy-route-secret",
                  "X-Custom": "keep-local-header",
                },
                timeout: 30_000,
              },
              remoteUser: {
                httpUrl: "https://mcp.example.test/service",
                headers: {
                  Authorization: "Bearer remote-user-secret",
                  "X-Y-Space-Mcp-Context": "remote-legacy-route-secret",
                  "X-Poracode-Token": "remote-legacy-token-secret",
                  "X-Y-Space-Routing-Token": "preserve-unrelated-remote-header",
                  "X-Custom": "keep-remote-header",
                },
                timeout: 30_000,
              },
              basicLocal: {
                httpUrl: "http://127.0.0.1:9124/mcp",
                headers: { Authorization: "Basic preserved-basic", "X-Custom": "keep-basic" },
                timeout: 30_000,
              },
              localCommand: {
                command: "memory-server",
                args: ["--safe"],
                env: { SAFE_VALUE: "keep-stdio" },
                timeout: 30_000,
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const argv = createGeminiAdapter().buildLaunchArgv(project, config, "hi");
      const shared = JSON.parse(readFileSync(install.paths.settingsPath, "utf8")) as {
        preservedSetting?: string;
        mcpServers?: Record<
          string,
          { headers?: Record<string, string>; env?: Record<string, string> }
        >;
      };

      expect(shared.preservedSetting).toBe("keep-me");
      expect(shared.mcpServers?.browser).toBeUndefined();
      expect(shared.mcpServers?.["pipedream-slack-deadbeef0001"]).toBeUndefined();
      expect(shared.mcpServers?.customLocal?.headers).toEqual({
        "X-Custom": "keep-local-header",
      });
      expect(shared.mcpServers?.remoteUser?.headers).toEqual({
        Authorization: "Bearer remote-user-secret",
        "X-Y-Space-Routing-Token": "preserve-unrelated-remote-header",
        "X-Custom": "keep-remote-header",
      });
      expect(shared.mcpServers?.basicLocal?.headers).toEqual({
        Authorization: "Basic preserved-basic",
        "X-Custom": "keep-basic",
      });
      expect(shared.mcpServers?.localCommand?.env).toEqual({ SAFE_VALUE: "keep-stdio" });
      expect(readFileSync(install.paths.settingsPath, "utf8")).not.toMatch(
        /(?:browser|pipedream|local|route)-legacy-secret/u,
      );

      argv.cleanup?.();
    } finally {
      if (previousDataDir === undefined) delete process.env.PORACODE_DATA_DIR;
      else process.env.PORACODE_DATA_DIR = previousDataDir;
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});

describe("detectGeminiInvalidSessionRef", () => {
  it("detects Gemini invalid resume session errors", () => {
    expect(
      detectGeminiInvalidSessionRef(
        'Error resuming session: Invalid session identifier "db8b5cb1-4cb6-46c1-abcb-71d35e18006a".',
      ),
    ).toBe(true);
  });

  it("ignores unrelated output", () => {
    expect(detectGeminiInvalidSessionRef("Loaded cached credentials.")).toBe(false);
  });
});

describe("geminiIntentFor", () => {
  it("maps the trimmed lifecycle hooks to universal intents", () => {
    expect(geminiIntentFor("SessionStart", undefined)).toBe("session.started");
    expect(geminiIntentFor("BeforeAgent", undefined)).toBe("session.turn_started");
    expect(geminiIntentFor("AfterAgent", undefined)).toBe("session.turn_finished");
  });

  it("ignores dropped redundant turn-open events", () => {
    expect(geminiIntentFor("BeforeModel", undefined)).toBeUndefined();
    expect(geminiIntentFor("BeforeTool", undefined)).toBeUndefined();
    expect(geminiIntentFor("AfterTool", undefined)).toBeUndefined();
  });

  it("maps only approval-style notifications to needs_approval", () => {
    expect(
      geminiIntentFor("Notification", {
        notification_type: "ToolPermission",
        message: "Allow tool?",
      }),
    ).toBe("session.needs_approval");
    expect(geminiIntentFor("Notification", { message: "FYI only" })).toBeUndefined();
  });
});

describe("createGeminiAdapter hook plugin support", () => {
  it("declares Gemini hook plugin metadata", () => {
    const adapter = createGeminiAdapter();

    expect(adapter.capabilities.presentationModes).toEqual(["terminal", "gui"]);
    expect(adapter.createStructuredSession).toBeTypeOf("function");
    expect(adapter.pluginId).toBe("poracode-status@gemini");
    expect(adapter.pluginVersion).toBe("1.2.3");
    expect(adapter.minProtocolVersion).toBe(1);
  });

  it("allows hook-active terminal fallback only for Gemini attention prompts", () => {
    const adapter = createGeminiAdapter();

    expect(
      adapter.shouldApplyTerminalStatusWhileHookActive?.({
        status: "needs_reply",
        attention: "needs_reply",
      }),
    ).toBe(true);
    expect(
      adapter.shouldApplyTerminalStatusWhileHookActive?.({
        status: "working",
        attention: "working",
      }),
    ).toBe(false);
    expect(
      adapter.shouldApplyTerminalStatusWhileHookActive?.({
        status: "idle",
        attention: "none",
      }),
    ).toBe(false);
  });
});

describe("createGeminiAdapter skill roots", () => {
  it("declares Gemini's native shared .agents root", () => {
    const support = createGeminiAdapter().skillSupport;

    expect(support?.roots.map((root) => root.id)).toEqual(["gemini", "agents"]);
    expect(support?.projectionRoots).toBeUndefined();
  });
});

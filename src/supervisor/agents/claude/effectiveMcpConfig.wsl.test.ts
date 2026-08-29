import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedMcpServer } from "@/shared/contracts";
import { buildClaudeMcpLaunchConfig } from "../userMcp";
import { resolveClaudeBrowserExclusiveMcpConfig } from "./effectiveMcpConfig";

const mockChildProcess = vi.hoisted(() => ({
  spawnSync:
    vi.fn<
      (
        command: string,
        args: string[],
        options: Record<string, unknown>,
      ) => { status: number; stdout: string; stderr: string }
    >(),
}));

const mockBase = vi.hoisted(() => ({
  getWslProjectShellEnv:
    vi.fn<(distro: string, cwd: string) => Record<string, string> | undefined>(),
  resolveWslHomeDirectory: vi.fn<(distro: string) => string | undefined>(),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawnSync: mockChildProcess.spawnSync };
});

vi.mock("../base", async () => {
  const actual = await vi.importActual<typeof import("../base")>("../base");
  return {
    ...actual,
    getWslCommand: () => "C:\\Windows\\System32\\wsl.exe",
    getWslProjectShellEnv: mockBase.getWslProjectShellEnv,
    resolveWslHomeDirectory: mockBase.resolveWslHomeDirectory,
  };
});

function browserServer(): ResolvedMcpServer {
  return {
    id: "browser",
    name: "browser",
    timeoutMs: 30_000,
    transport: {
      type: "http",
      url: "http://127.0.0.1:43210/mcp",
      headers: { Authorization: "Bearer browser-token" },
    },
  };
}

describe("resolveClaudeBrowserExclusiveMcpConfig in WSL", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBase.resolveWslHomeDirectory.mockReturnValue("/home/demo");
    mockBase.getWslProjectShellEnv.mockReturnValue({
      USER_MCP_TOKEN: "user-secret",
      TEAM_SCRIPT: "/home/demo/project/team-server.mjs",
    });
  });

  it("reads effective distro-side sources without copying profile data to Windows", () => {
    const files = new Map<string, string>([
      [
        "/home/demo/.claude.json",
        JSON.stringify({
          mcpServers: {
            "user-safe": {
              type: "http",
              url: "https://user.example.test/mcp",
              headers: { Authorization: "Bearer ${USER_MCP_TOKEN}" },
            },
            playwright: { command: "npx", args: ["@playwright/mcp"] },
          },
          projects: {
            "/home/demo/project": {
              hasTrustDialogAccepted: true,
              enabledMcpjsonServers: ["team-safe", "browser-tools"],
              disabledMcpjsonServers: [],
              mcpServers: {},
            },
          },
        }),
      ],
      [
        "/home/demo/project/.mcp.json",
        JSON.stringify({
          mcpServers: {
            "team-safe": { command: "node", args: ["${TEAM_SCRIPT}"] },
            "browser-tools": {
              type: "http",
              url: "https://browser-tools.example.test/mcp",
            },
          },
        }),
      ],
    ]);
    mockChildProcess.spawnSync.mockImplementation(
      (_command: string, args: string[], options: Record<string, unknown>) => {
        const script = args[5] ?? "";
        const sourcePath = args[7] ?? "";
        expect(options).toMatchObject({ shell: false, windowsHide: true });
        if (script.includes("find ")) {
          return { status: 44, stdout: "", stderr: "" };
        }
        const source = files.get(sourcePath);
        return source === undefined
          ? { status: 44, stdout: "", stderr: "" }
          : { status: 0, stdout: source, stderr: "" };
      },
    );

    const resolved = resolveClaudeBrowserExclusiveMcpConfig({
      projectLocation: {
        kind: "wsl",
        distro: "Ubuntu",
        linuxPath: "/home/demo/project",
        uncPath: "\\\\wsl.localhost\\Ubuntu\\home\\demo\\project",
      },
      appLaunch: buildClaudeMcpLaunchConfig([browserServer()]),
    });

    expect(Object.keys(resolved.mcpServers).sort()).toEqual(["browser"]);
    expect(resolved.mcpServers).not.toHaveProperty("playwright");
    expect(resolved.mcpServers).not.toHaveProperty("browser-tools");
    expect(JSON.stringify(resolved.mcpServers)).not.toContain("user-secret");
    expect(JSON.stringify(resolved.mcpServers)).not.toContain("team-server.mjs");
    expect(Object.values(resolved.env)).not.toContain("Bearer user-secret");
    expect(Object.values(resolved.env)).not.toContain("/home/demo/project/team-server.mjs");
    expect(mockChildProcess.spawnSync).toHaveBeenCalled();
    for (const call of mockChildProcess.spawnSync.mock.calls) {
      const [command, args] = call;
      expect(command).toBe("C:\\Windows\\System32\\wsl.exe");
      expect(args.slice(0, 5)).toEqual(["-d", "Ubuntu", "--exec", "sh", "-c"]);
      expect(JSON.stringify(args)).not.toContain("user-secret");
      expect(JSON.stringify(args)).not.toContain("team-server.mjs");
    }
  });

  it("uses cached WSL CLAUDE_CONFIG_DIR and shadows its MCP-backed agents", () => {
    mockBase.getWslProjectShellEnv.mockReturnValue({
      CLAUDE_CONFIG_DIR: "/srv/claude-profile",
      PROFILE_TOKEN: "custom-profile-secret",
    });
    const agentPath = "/srv/claude-profile/agents/browser-helper.md";
    const files = new Map<string, string>([
      [
        "/srv/claude-profile/.claude.json",
        JSON.stringify({
          mcpServers: {
            neutral: {
              type: "http",
              url: "https://neutral-profile.test/mcp",
              headers: { Authorization: "Bearer ${PROFILE_TOKEN}" },
            },
          },
          projects: {},
        }),
      ],
      [
        agentPath,
        [
          "---",
          "name: browser-helper",
          "description: Profile helper",
          "mcpServers:",
          "  - neutral",
          "  - hidden-browser:",
          "      type: http",
          "      url: https://hidden-browser.test/mcp",
          "---",
          "Use the available tools.",
        ].join("\n"),
      ],
    ]);
    const inspectedPaths: string[] = [];
    mockChildProcess.spawnSync.mockImplementation(
      (_command: string, args: string[], _options: Record<string, unknown>) => {
        const script = args[5] ?? "";
        const sourcePath = args[7] ?? "";
        inspectedPaths.push(sourcePath);
        if (script.includes("find ")) {
          return sourcePath === "/srv/claude-profile/agents"
            ? { status: 0, stdout: `${agentPath}\0`, stderr: "" }
            : { status: 44, stdout: "", stderr: "" };
        }
        const source = files.get(sourcePath);
        return source === undefined
          ? { status: 44, stdout: "", stderr: "" }
          : { status: 0, stdout: source, stderr: "" };
      },
    );

    const resolved = resolveClaudeBrowserExclusiveMcpConfig({
      projectLocation: {
        kind: "wsl",
        distro: "Ubuntu",
        linuxPath: "/home/demo/project",
        uncPath: "\\\\wsl.localhost\\Ubuntu\\home\\demo\\project",
      },
      appLaunch: buildClaudeMcpLaunchConfig([browserServer()]),
    });

    expect(Object.keys(resolved.mcpServers)).toEqual(["browser"]);
    expect(resolved.agents["browser-helper"]?.mcpServers).toEqual([
      { browser: expect.objectContaining({ url: "http://127.0.0.1:43210/mcp" }) },
    ]);
    expect(Object.values(resolved.env)).not.toContain("custom-profile-secret");
    expect(inspectedPaths).toContain("/srv/claude-profile/.claude.json");
    expect(inspectedPaths).not.toContain("/home/demo/.claude.json");
  });
});

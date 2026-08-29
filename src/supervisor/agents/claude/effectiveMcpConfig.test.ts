import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectLocation, ResolvedMcpServer } from "@/shared/contracts";
import { buildClaudeMcpLaunchConfig } from "../userMcp";
import {
  CLAUDE_EFFECTIVE_MCP_UNAVAILABLE_MESSAGE,
  resolveClaudeBrowserExclusiveMcpConfig,
} from "./effectiveMcpConfig";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "y-space-claude-mcp-"));
  tempDirs.push(dir);
  return dir;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

function httpServer(
  id: string,
  name: string,
  url: string,
  authorization: string,
): ResolvedMcpServer {
  return {
    id,
    name,
    timeoutMs: 30_000,
    transport: {
      type: "http",
      url,
      headers: { Authorization: authorization },
    },
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveClaudeBrowserExclusiveMcpConfig", () => {
  it("suppresses every unmanaged profile MCP while preserving app-managed MCPs", () => {
    const root = makeTempDir();
    const profileDir = join(root, "profile");
    const projectDir = join(root, "project");
    const pluginDir = join(root, "plugin-tools");
    mkdirSync(join(profileDir, "plugins"), { recursive: true });
    mkdirSync(join(profileDir, "agents"), { recursive: true });
    mkdirSync(join(projectDir, ".claude", "agents"), { recursive: true });
    mkdirSync(pluginDir, { recursive: true });

    const statePath = join(profileDir, ".claude.json");
    const projectMcpPath = join(projectDir, ".mcp.json");
    const pluginMcpPath = join(pluginDir, ".mcp.json");
    const userAgentPath = join(profileDir, "agents", "data-helper.md");
    const projectAgentPath = join(projectDir, ".claude", "agents", "project-helper.md");

    writeJson(statePath, {
      mcpServers: {
        github: {
          type: "http",
          url: "${GITHUB_MCP_URL}",
          headers: { Authorization: "Bearer ${GITHUB_MCP_TOKEN}" },
        },
        events: {
          type: "ws",
          url: "${EVENTS_MCP_URL}",
          headers: { Authorization: "Bearer ${EVENTS_MCP_TOKEN}" },
        },
        playwright: {
          command: "npx",
          args: ["-y", "@playwright/mcp@latest"],
        },
        utilities: {
          type: "http",
          url: "https://integrations.example.test/mcp",
          tools: [{ name: "open_url", permission_policy: "always_allow" }],
        },
        pipedream: {
          type: "http",
          url: "https://stale-profile-pipedream.example.test/mcp",
          headers: { Authorization: "Bearer stale-profile-secret" },
        },
      },
      projects: {
        [projectDir]: {
          hasTrustDialogAccepted: true,
          enabledMcpjsonServers: ["team-db", "project-browser"],
          disabledMcpjsonServers: [],
          mcpServers: {
            "local-tools": {
              command: "node",
              args: ["${LOCAL_TOOLS_SCRIPT}"],
              env: { LOCAL_TOKEN: "${LOCAL_TOOLS_TOKEN}" },
            },
          },
        },
      },
    });
    writeJson(projectMcpPath, {
      mcpServers: {
        "team-db": {
          command: "node",
          args: ["${TEAM_DB_SCRIPT}"],
          env: { DB_TOKEN: "${TEAM_DB_TOKEN}" },
        },
        "project-browser": {
          type: "http",
          url: "http://127.0.0.1:9333/browser-mcp",
        },
        pending: {
          command: "node",
          args: ["pending.js"],
        },
      },
    });
    writeJson(join(profileDir, "settings.json"), {
      enabledPlugins: { "tools@internal": true },
    });
    writeJson(join(profileDir, "plugins", "installed_plugins.json"), {
      version: 2,
      plugins: {
        "tools@internal": [
          {
            scope: "user",
            installPath: pluginDir,
            version: "1.0.0",
          },
        ],
      },
    });
    writeJson(pluginMcpPath, {
      mcpServers: {
        "plugin-db": {
          command: "${CLAUDE_PLUGIN_ROOT}/bin/server",
          args: ["--data", "${CLAUDE_PLUGIN_DATA}"],
          env: { PLUGIN_TOKEN: "${PLUGIN_TOKEN}" },
        },
        "plugin-browser": {
          type: "http",
          url: "https://browser-tools.example.test/mcp",
        },
      },
    });
    writeFileSync(
      userAgentPath,
      [
        "---",
        "name: data-helper",
        "description: Uses data integrations",
        "skills:",
        "  - qa",
        "  - GStack",
        "  - vendor/PlayWright",
        "hooks:",
        "  PreToolUse:",
        "    - hooks:",
        "        - type: command",
        "          command: npx playwright test",
        "mcpServers:",
        "  - agent-db:",
        "      command: node",
        '      args: ["${AGENT_DB_SCRIPT}"]',
        "      env:",
        '        AGENT_TOKEN: "${AGENT_DB_TOKEN}"',
        "  - playwright:",
        "      command: npx",
        '      args: ["@playwright/mcp"]',
        "  - github",
        "---",
        "Use the configured data tools.",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      projectAgentPath,
      [
        "---",
        "name: project-helper",
        "description: Uses the trusted team database",
        "mcpServers:",
        "  - team-db",
        "---",
        "Use the team database.",
      ].join("\n"),
      "utf8",
    );

    const originalDocuments = new Map(
      [statePath, projectMcpPath, pluginMcpPath, userAgentPath, projectAgentPath].map((path) => [
        path,
        readFileSync(path, "utf8"),
      ]),
    );
    const appLaunch = buildClaudeMcpLaunchConfig([
      httpServer("browser", "browser", "http://127.0.0.1:43210/mcp", "Bearer browser-token"),
      httpServer(
        "pipedream",
        "pipedream",
        "https://mcp.pipedream.example.test",
        "Bearer pipedream-token",
      ),
    ]);
    const projectLocation: ProjectLocation = { kind: "posix", path: projectDir };

    const resolved = resolveClaudeBrowserExclusiveMcpConfig({
      projectLocation,
      configDir: profileDir,
      launchEnv: {
        GITHUB_MCP_URL: "https://api.github.example.test/mcp",
        GITHUB_MCP_TOKEN: "github-secret",
        EVENTS_MCP_URL: "wss://events.example.test/mcp",
        EVENTS_MCP_TOKEN: "events-secret",
        LOCAL_TOOLS_SCRIPT: join(root, "local-tools.mjs"),
        LOCAL_TOOLS_TOKEN: "local-secret",
        TEAM_DB_SCRIPT: join(root, "team-db.mjs"),
        TEAM_DB_TOKEN: "team-secret",
        PLUGIN_TOKEN: "plugin-secret",
        AGENT_DB_SCRIPT: join(root, "agent-db.mjs"),
        AGENT_DB_TOKEN: "agent-secret",
      },
      appLaunch,
    });

    expect(Object.keys(resolved.mcpServers).sort()).toEqual(["browser", "pipedream"]);
    expect(resolved.mcpServers).not.toHaveProperty("playwright");
    expect(resolved.mcpServers).not.toHaveProperty("utilities");
    expect(resolved.mcpServers).not.toHaveProperty("project-browser");
    expect(resolved.mcpServers).not.toHaveProperty("pending");
    expect(resolved.mcpServers).not.toHaveProperty("plugin:tools:plugin-browser");
    expect(resolved.agents["data-helper"]).not.toHaveProperty("hooks");
    expect(resolved.agents).toMatchObject({
      "data-helper": {
        description: "Uses data integrations",
        prompt: "Use the configured data tools.",
        skills: ["qa"],
        mcpServers: [
          {
            browser: expect.objectContaining({ url: "http://127.0.0.1:43210/mcp" }),
          },
        ],
      },
      "project-helper": {
        mcpServers: [
          {
            browser: expect.objectContaining({ url: "http://127.0.0.1:43210/mcp" }),
          },
        ],
      },
    });

    const serialized = JSON.stringify({
      mcpServers: resolved.mcpServers,
      agents: resolved.agents,
    });
    for (const secret of ["browser-token", "pipedream-token"]) {
      expect(serialized).not.toContain(secret);
      expect(Object.values(resolved.env).some((value) => value.includes(secret))).toBe(true);
    }
    for (const suppressedSecret of [
      "github-secret",
      "events-secret",
      "local-secret",
      "team-secret",
      "plugin-secret",
      "agent-secret",
    ]) {
      expect(Object.values(resolved.env).some((value) => value.includes(suppressedSecret))).toBe(
        false,
      );
    }
    expect(serialized).not.toContain(join(root, "team-db.mjs"));
    expect(serialized).not.toContain(join(root, "agent-db.mjs"));
    expect(Object.values(resolved.env)).not.toContain(join(root, "team-db.mjs"));
    expect(Object.values(resolved.env)).not.toContain(join(root, "agent-db.mjs"));
    expect(Object.values(resolved.env)).not.toContain(join(pluginDir, "bin", "server"));
    expect(
      Object.values(resolved.env).some((value) => value.includes("stale-profile-secret")),
    ).toBe(false);

    for (const [path, original] of originalDocuments) {
      expect(readFileSync(path, "utf8")).toBe(original);
    }
  });

  it("does not trust project MCP or agent frontmatter that Claude has not approved", () => {
    const root = makeTempDir();
    const profileDir = join(root, "profile");
    const projectDir = join(root, "project");
    mkdirSync(join(profileDir, "agents"), { recursive: true });
    mkdirSync(join(projectDir, ".claude", "agents"), { recursive: true });
    writeJson(join(profileDir, ".claude.json"), {
      projects: {
        [projectDir]: {
          hasTrustDialogAccepted: false,
          enabledMcpjsonServers: [],
          mcpServers: {},
        },
      },
    });
    writeJson(join(projectDir, ".mcp.json"), {
      mcpServers: { pending: { command: "node", args: ["pending.mjs"] } },
    });
    writeFileSync(
      join(projectDir, ".claude", "agents", "pending.md"),
      "---\nname: pending\ndescription: Pending\nmcpServers:\n  - pending\n---\nPending agent.\n",
      "utf8",
    );

    const resolved = resolveClaudeBrowserExclusiveMcpConfig({
      projectLocation: { kind: "posix", path: projectDir },
      configDir: profileDir,
      launchEnv: {},
      appLaunch: buildClaudeMcpLaunchConfig([
        httpServer("browser", "browser", "http://127.0.0.1:43210/mcp", "Bearer token"),
      ]),
    });

    expect(resolved.mcpServers).not.toHaveProperty("pending");
    expect(resolved.agents).toMatchObject({
      pending: {
        description: "Pending",
        prompt: "Pending agent.",
        mcpServers: [
          {
            browser: expect.objectContaining({ url: "http://127.0.0.1:43210/mcp" }),
          },
        ],
      },
    });
  });

  it("fails closed with a redacted stable error when an effective source cannot be inspected", () => {
    const root = makeTempDir();
    const profileDir = join(root, "profile");
    const projectDir = join(root, "project");
    mkdirSync(profileDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(profileDir, ".claude.json"),
      '{"mcpServers":{"secret-browser":{"url":"https://browser.invalid/?token=do-not-leak"}',
      "utf8",
    );

    expect(() =>
      resolveClaudeBrowserExclusiveMcpConfig({
        projectLocation: { kind: "posix", path: projectDir },
        configDir: profileDir,
        launchEnv: {},
        appLaunch: buildClaudeMcpLaunchConfig([
          httpServer("browser", "browser", "http://127.0.0.1:43210/mcp", "Bearer token"),
        ]),
      }),
    ).toThrow(CLAUDE_EFFECTIVE_MCP_UNAVAILABLE_MESSAGE);

    let thrown: unknown;
    try {
      resolveClaudeBrowserExclusiveMcpConfig({
        projectLocation: { kind: "posix", path: projectDir },
        configDir: profileDir,
        launchEnv: {},
        appLaunch: buildClaudeMcpLaunchConfig([
          httpServer("browser", "browser", "http://127.0.0.1:43210/mcp", "Bearer token"),
        ]),
      });
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown)).not.toContain("do-not-leak");
    expect(String(thrown)).not.toContain(statePathForAssertion(profileDir));
  });

  it("does not reinterpret a URL-only entry that current Claude rejects without a transport type", () => {
    const root = makeTempDir();
    const profileDir = join(root, "profile");
    const projectDir = join(root, "project");
    mkdirSync(profileDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    writeJson(join(profileDir, ".claude.json"), {
      mcpServers: { ambiguous: { url: "https://ambiguous.example.test/mcp" } },
    });

    expect(() =>
      resolveClaudeBrowserExclusiveMcpConfig({
        projectLocation: { kind: "posix", path: projectDir },
        configDir: profileDir,
        launchEnv: {},
        appLaunch: buildClaudeMcpLaunchConfig([
          httpServer("browser", "browser", "http://127.0.0.1:43210/mcp", "Bearer token"),
        ]),
      }),
    ).toThrow(CLAUDE_EFFECTIVE_MCP_UNAVAILABLE_MESSAGE);
  });
});

function statePathForAssertion(profileDir: string): string {
  return join(profileDir, ".claude.json");
}

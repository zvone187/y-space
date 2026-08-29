import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createClaudeAdapter, createClaudeProfileAdapter } from "./index";
import { claudeCapabilities, parseClaudeAuthStatusJson } from "./detection";
import type { OscNotification, OscTitle } from "@/shared/osc";
import type { ProjectLocation, ThreadConfig } from "@/shared/contracts";

function oscTitle(text: string, code: 0 | 1 | 2 = 0): OscTitle {
  return { code, text };
}

function oscNotify(body: string, code: 9 | 99 | 777 = 9): OscNotification {
  return { code, title: "", body, payload: undefined };
}

describe("createClaudeAdapter skill roots", () => {
  it("links canonical projections starting with Claude 2.1.203", () => {
    expect(createClaudeAdapter().skillSupport?.projectionRoots).toEqual([
      expect.objectContaining({
        id: "claude",
        linkProjectionFromVersion: "2.1.203",
      }),
    ]);
  });
});

describe("createClaudeAdapter handleOscTitle", () => {
  const adapter = createClaudeAdapter();

  // Observed from real dev sessions (~/.poracode/logs/terminal/*.log):
  //   124× "⠂ <task title>"  /  121× "⠐ <task title>"  /  10× "✳ <task title>"
  // The braille 2-frame animation (⠂ / ⠐, U+2802 / U+2810) is the stable
  // "working" signal; ✳ appeared rarely and was classified as an artifact.
  it("maps Claude's 2-frame braille spinner (⠂ / ⠐) to working", () => {
    for (const glyph of ["⠂", "⠐"]) {
      expect(adapter.handleOscTitle?.(oscTitle(`${glyph} Add jump to bottom button`))).toEqual({
        status: "working",
        attention: "working",
        corroborated: true,
      });
    }
  });

  it("accepts any glyph in the braille range (U+2800–U+28FF)", () => {
    for (const glyph of ["⠀", "⠁", "⠄", "⣾", "⣿"]) {
      expect(adapter.handleOscTitle?.(oscTitle(`${glyph} task`))?.status).toBe("working");
    }
  });

  it("returns null for Claude's idle titles (no spinner prefix)", () => {
    // At startup Claude sets these; they are NOT a working signal.
    expect(adapter.handleOscTitle?.(oscTitle("claude"))).toBeNull();
    expect(adapter.handleOscTitle?.(oscTitle("Claude Code"))).toBeNull();
  });

  it("returns null when the braille glyph is not at the start of the title", () => {
    expect(adapter.handleOscTitle?.(oscTitle("Claude Code ⠂"))).toBeNull();
  });
});

describe("createClaudeAdapter handleOscNotification (iTerm2 OSC 9;4 progress)", () => {
  const adapter = createClaudeAdapter();

  // Real bodies observed in ~/.poracode-dev/logs/terminal/*.log after the
  // `preferredNotifChannel: "iterm2"` settings flip: "4;0;", "4;0;0", "4;3;0".
  // See plugin/install.ts for the settings wiring.
  it("maps state 0 (remove progress) to idle", () => {
    for (const body of ["4;0", "4;0;", "4;0;0"]) {
      expect(adapter.handleOscNotification?.(oscNotify(body))).toEqual({
        status: "idle",
        attention: "none",
        corroborated: true,
      });
    }
  });

  it("maps state 3 (indeterminate) to working — Claude's in-turn signal", () => {
    expect(adapter.handleOscNotification?.(oscNotify("4;3;0"))).toEqual({
      status: "working",
      attention: "working",
      corroborated: true,
    });
  });

  it("maps state 1 (determinate progress) to working", () => {
    expect(adapter.handleOscNotification?.(oscNotify("4;1;42"))).toEqual({
      status: "working",
      attention: "working",
      corroborated: true,
    });
  });

  it("ignores states 2 (error) and 4 (paused) — no clean mapping", () => {
    expect(adapter.handleOscNotification?.(oscNotify("4;2"))).toBeNull();
    expect(adapter.handleOscNotification?.(oscNotify("4;4;0"))).toBeNull();
  });

  it("ignores OSC 9 bodies that aren't the 9;4 progress sub-protocol", () => {
    // Codex-style plain-text OSC 9 (turn-end notify with response text) must
    // not accidentally flip Claude to idle/working — Claude is configured for
    // iTerm2 progress only, so a non-`4;` body is a foreign signal.
    expect(adapter.handleOscNotification?.(oscNotify("Hello from some other agent"))).toBeNull();
    expect(adapter.handleOscNotification?.(oscNotify(""))).toBeNull();
  });

  it("ignores OSC 777 / OSC 99 — Claude only speaks iTerm2 OSC 9", () => {
    expect(adapter.handleOscNotification?.(oscNotify("4;0", 777))).toBeNull();
    expect(adapter.handleOscNotification?.(oscNotify("4;3;0", 99))).toBeNull();
  });
});

describe("createClaudeAdapter structured sessions", () => {
  const projectLocation: ProjectLocation = { kind: "windows", path: "C:\\repo" };
  const config: ThreadConfig = { model: "sonnet" };

  it("advertises GUI as an opt-in presentation mode while keeping terminal as default", () => {
    const adapter = createClaudeAdapter();

    expect(adapter.capabilities.presentationMode).toBe("terminal");
    expect(adapter.capabilities.presentationModes).toEqual(["terminal", "gui"]);
    expect(adapter.browserRouting).toEqual({ terminal: "exclusive", gui: "exclusive" });
  });

  it("makes Y Space Browser the sole browser route for terminal launches", () => {
    const adapter = createClaudeAdapter({
      configDir: path.join(tmpdir(), "y-space-test-empty-claude-browser-profile"),
    });
    expect(adapter.capabilities.mcpScope?.terminal).toBe("launch");

    const launch = adapter.buildLaunchArgv(projectLocation, config, "test the app", undefined, {
      mcpServers: [
        {
          id: "browser",
          name: "browser",
          timeoutMs: 30_000,
          transport: {
            type: "http",
            url: "http://127.0.0.1:43210/mcp?thread=thread-1",
            headers: { Authorization: "Bearer browser-token" },
          },
        },
      ],
    });
    expect(launch.args).toContain("--no-chrome");
    expect(launch.args).toContain("--strict-mcp-config");
    expect(launch.args).not.toContain("--disable-slash-commands");

    const disallowedIndex = launch.args.indexOf("--disallowedTools");
    expect(disallowedIndex).toBeGreaterThanOrEqual(0);
    const disallowedTools = launch.args[disallowedIndex + 1] ?? "";
    expect(disallowedTools).toMatch(/\bWebFetch\b/u);
    expect(disallowedTools).toMatch(/\bWebSearch\b/u);
    expect(disallowedTools).toContain("Skill(gstack)");
    expect(disallowedTools).toContain("Skill(control-in-app-browser *)");
    expect(disallowedTools).toContain("Skill(playwright)");
    expect(disallowedTools).toContain("Bash(*playwright*)");
    expect(disallowedTools).toContain("Bash(*open -a*Safari*)");
    expect(disallowedTools).toContain("Bash(open *https://*)");
    expect(disallowedTools).toContain("Bash(xdg-open *https://*)");
    expect(disallowedTools).toContain("Bash(gio open *https://*)");
    expect(disallowedTools).toContain("PowerShell(Start-Process *https://*)");
    expect(disallowedTools).toContain("PowerShell(start *https://*)");
    expect(disallowedTools).toContain("PowerShell(explorer.exe *https://*)");
    expect(disallowedTools).toContain("Bash(google-chrome*)");
    expect(disallowedTools).toContain("PowerShell(*\\msedge.exe*)");
    expect(disallowedTools).toContain("Bash(bash -lc 'open *https://*)");
    expect(disallowedTools).toContain("Bash(sh -lc 'open *https://*)");
    expect(disallowedTools).toContain("Bash(zsh -lc 'firefox*)");
    expect(disallowedTools).toContain("Bash(bash -c 'open *https://*)");
    expect(disallowedTools).toContain("Bash(env DISPLAY=* firefox*)");
    expect(disallowedTools).toContain("Bash(FOO=* firefox*)");
    expect(disallowedTools).toContain("Bash(command firefox*)");
    expect(disallowedTools).toContain("Bash(nohup chromium*)");
    expect(disallowedTools).not.toContain("Skill(qa)");
    expect(disallowedTools).not.toMatch(/(?:^|,)Skill(?:,|$)/u);

    const guidanceIndex = launch.args.indexOf("--append-system-prompt");
    expect(guidanceIndex).toBeGreaterThanOrEqual(0);
    const guidance = launch.args[guidanceIndex + 1] ?? "";
    expect(guidance).toMatch(/Y Space Browser/iu);
    expect(guidance).toMatch(/(?:only|sole).{0,80}browser|browser.{0,80}(?:only|sole)/iu);
    expect(guidance).toContain("current turn");
    expect(guidance).toContain("exact tab id");
    expect(guidance).toContain("URL or title");
    expect(guidance).toContain("page result you observed");

    const configIndex = launch.args.indexOf("--mcp-config");
    expect(configIndex).toBeGreaterThanOrEqual(0);
    const serializedMcpConfig = launch.args[configIndex + 1] ?? "{}";
    expect(serializedMcpConfig).not.toContain("browser-token");
    expect(JSON.parse(serializedMcpConfig)).toMatchObject({
      mcpServers: {
        browser: {
          type: "http",
          url: "http://127.0.0.1:43210/mcp?thread=thread-1",
          headers: {
            Authorization: expect.stringMatching(/^\$\{PORACODE_MCP_CLAUDE_/u),
          },
        },
      },
    });
    expect(Object.values(launch.env ?? {})).toContain("Bearer browser-token");
  });

  it("shadows unmanaged Claude profile MCPs only for Browser-exclusive terminal launches", () => {
    const root = mkdtempSync(path.join(tmpdir(), "y-space-claude-terminal-profile-"));
    try {
      const profileDir = path.join(root, "profile");
      const projectDir = path.join(root, "project");
      mkdirSync(path.join(profileDir, "agents"), { recursive: true });
      mkdirSync(projectDir, { recursive: true });
      const statePath = path.join(profileDir, ".claude.json");
      const agentPath = path.join(profileDir, "agents", "profile-helper.md");
      writeFileSync(
        statePath,
        JSON.stringify({
          mcpServers: {
            "profile-safe": {
              type: "http",
              url: "${PROFILE_MCP_URL}",
              headers: { Authorization: "Bearer ${PROFILE_MCP_TOKEN}" },
            },
            playwright: { command: "npx", args: ["@playwright/mcp"] },
          },
        }),
        "utf8",
      );
      writeFileSync(
        agentPath,
        "---\nname: profile-helper\ndescription: Uses the safe profile MCP\nmcpServers:\n  - profile-safe\n---\nUse the safe profile MCP.\n",
        "utf8",
      );
      const originalState = readFileSync(statePath, "utf8");
      const originalAgent = readFileSync(agentPath, "utf8");
      const adapter = createClaudeAdapter({
        configDir: profileDir,
        customEnv: {
          PROFILE_MCP_URL: "https://profile.example.test/mcp",
          PROFILE_MCP_TOKEN: "profile-secret",
        },
      });
      const appServers = [
        {
          id: "browser",
          name: "browser",
          timeoutMs: 30_000,
          transport: {
            type: "http" as const,
            url: "http://127.0.0.1:43210/mcp",
            headers: { Authorization: "Bearer browser-secret" },
          },
        },
        {
          id: "pipedream",
          name: "pipedream",
          timeoutMs: 30_000,
          transport: {
            type: "http" as const,
            url: "https://mcp.pipedream.example.test",
            headers: { Authorization: "Bearer pipedream-secret" },
          },
        },
      ];
      const launch = adapter.buildLaunchArgv(
        { kind: "posix", path: projectDir },
        config,
        "use my integrations",
        undefined,
        { mcpServers: appServers },
      );

      const configIndex = launch.args.indexOf("--mcp-config");
      const agentsIndex = launch.args.indexOf("--agents");
      const serializedConfig = launch.args[configIndex + 1] ?? "{}";
      const serializedAgents = launch.args[agentsIndex + 1] ?? "{}";
      expect(Object.keys(JSON.parse(serializedConfig).mcpServers).sort()).toEqual([
        "browser",
        "pipedream",
      ]);
      expect(JSON.parse(serializedAgents)).toMatchObject({
        "profile-helper": {
          mcpServers: [
            {
              browser: expect.objectContaining({ url: "http://127.0.0.1:43210/mcp" }),
            },
          ],
        },
      });
      expect(serializedConfig).not.toContain("playwright");
      expect(`${serializedConfig}${serializedAgents}`).not.toContain("profile-secret");
      expect(`${serializedConfig}${serializedAgents}`).not.toContain("pipedream-secret");
      expect(Object.values(launch.env ?? {})).toContain("profile-secret");
      expect(Object.values(launch.env ?? {})).toContain("Bearer pipedream-secret");
      expect(launch.env?.PORACODE_CLAUDE_BROWSER_EXCLUSIVE).toBe("1");
      expect(readFileSync(statePath, "utf8")).toBe(originalState);
      expect(readFileSync(agentPath, "utf8")).toBe(originalAgent);

      const browserDisabledLaunch = adapter.buildLaunchArgv(
        { kind: "posix", path: projectDir },
        config,
        "use pipedream",
        undefined,
        { mcpServers: [appServers[1]!] },
      );
      const disabledConfigIndex = browserDisabledLaunch.args.indexOf("--mcp-config");
      expect(browserDisabledLaunch.args).not.toContain("--strict-mcp-config");
      expect(browserDisabledLaunch.args).not.toContain("--agents");
      expect(browserDisabledLaunch.env?.PORACODE_CLAUDE_BROWSER_EXCLUSIVE).toBeUndefined();
      expect(
        Object.keys(
          JSON.parse(browserDisabledLaunch.args[disabledConfigIndex + 1] ?? "{}").mcpServers,
        ),
      ).toEqual(["pipedream"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates a structured SDK session only for GUI presentation", async () => {
    const adapter = createClaudeAdapter();

    await expect(
      adapter.createStructuredSession?.({
        threadId: "thread-1",
        projectLocation,
        config,
        presentationMode: "terminal",
      }),
    ).resolves.toBeUndefined();

    await expect(
      adapter.createStructuredSession?.({
        threadId: "thread-1",
        projectLocation,
        config,
        presentationMode: "gui",
      }),
    ).resolves.toMatchObject({ launchOptions: { suppressResumeConfigOverrides: true } });
  });
});

describe("claudeCapabilities", () => {
  it("surfaces Fable 5 with frontier effort tiers", () => {
    expect(claudeCapabilities.models).toContainEqual({
      id: "claude-fable-5",
      label: "Fable 5",
    });
    expect(claudeCapabilities.modelEfforts["claude-fable-5"]).toEqual([
      "low",
      "medium",
      "high",
      "xHigh",
      "max",
      "ultracode",
    ]);
    expect(claudeCapabilities.modelContextSizes?.["claude-fable-5"]).toEqual(["1m"]);
    expect(claudeCapabilities.fastModels).not.toContain("claude-fable-5");
  });

  it("lists Opus 5 first at high effort so it is the default for new threads", () => {
    expect(claudeCapabilities.models[0]).toEqual({ id: "claude-opus-5", label: "Opus 5" });
    expect(claudeCapabilities.defaultEffort).toBe("high");
    expect(claudeCapabilities.modelEfforts["claude-opus-5"]).toEqual([
      "low",
      "medium",
      "high",
      "xHigh",
      "max",
      "ultracode",
    ]);
    expect(claudeCapabilities.modelContextSizes?.["claude-opus-5"]).toEqual(["1m"]);
    expect(claudeCapabilities.fastModels).toContain("claude-opus-5");
  });

  it("surfaces Sonnet 5 with frontier effort tiers", () => {
    expect(claudeCapabilities.models).toContainEqual({
      id: "claude-sonnet-5",
      label: "Sonnet 5",
    });
    expect(claudeCapabilities.modelEfforts["claude-sonnet-5"]).toEqual([
      "low",
      "medium",
      "high",
      "xHigh",
      "max",
      "ultracode",
    ]);
    expect(claudeCapabilities.modelContextSizes?.["claude-sonnet-5"]).toEqual(["1m"]);
    expect(claudeCapabilities.modelContextSizes?.sonnet).toEqual(["200k", "1m"]);
  });
});

describe("createClaudeAdapter buildAcpLogoutCommand", () => {
  it("returns `claude auth logout` so the Settings logout button can drive it", async () => {
    const adapter = createClaudeAdapter();
    const command = await adapter.buildAcpLogoutCommand?.();
    expect(command).toBeDefined();
    const args = command?.args ?? [];
    const rendered = args.includes("-EncodedCommand")
      ? Buffer.from(args.at(-1) ?? "", "base64").toString("utf16le")
      : args.join(" ");
    expect(rendered).toMatch(/claude/i);
    expect(rendered).toContain("auth");
    expect(rendered).toContain("logout");
  });
});

describe("createClaudeProfileAdapter", () => {
  const projectLocation: ProjectLocation = { kind: "posix", path: "/repo" };

  it("creates a distinct Claude adapter backed by a separate config directory", () => {
    const adapter = createClaudeProfileAdapter({
      id: "work",
      driver: "claude",
      displayName: "Work",
      config: { configDir: "~/.poracode/claude-profiles/work" },
    });

    expect(adapter.kind).toBe("claude:work");
    expect(adapter.label).toBe("Claude Work");
    expect(adapter.capabilities.subProviders).toBeUndefined();
    expect(adapter.capabilities.modelSubProvider).toBeUndefined();

    const expectedConfigDir = path.join(homedir(), ".poracode/claude-profiles/work");
    expect(
      adapter.buildLaunchArgv(projectLocation, { model: "sonnet" }, "hello").env?.CLAUDE_CONFIG_DIR,
    ).toBe(expectedConfigDir);
    expect(
      adapter.buildOneShotCommand?.("haiku", undefined, "Summarize", projectLocation)?.env
        ?.CLAUDE_CONFIG_DIR,
    ).toBe(expectedConfigDir);
    expect(
      adapter.buildContextExtractionCommand?.(
        { providerSessionId: "session-1", discoveredAt: "test" },
        projectLocation,
      )?.env?.CLAUDE_CONFIG_DIR,
    ).toBe(expectedConfigDir);
  });

  it("merges the instance environment into the spawn env, with CLAUDE_CONFIG_DIR winning", () => {
    const adapter = createClaudeProfileAdapter({
      id: "glm",
      driver: "claude",
      displayName: "GLM",
      config: { configDir: "~/.poracode/claude-profiles/glm" },
      // Values arrive decrypted from the supervisor's settings read.
      environment: {
        ANTHROPIC_BASE_URL: { value: "https://api.z.ai/api/anthropic" },
        ANTHROPIC_AUTH_TOKEN: { value: "sk-test", sensitive: true },
        // A user override of CLAUDE_CONFIG_DIR must not win over the profile.
        CLAUDE_CONFIG_DIR: { value: "/should/be/ignored" },
      },
    });

    const env = adapter.buildLaunchArgv(projectLocation, { model: "glm-5.2" }, "hello").env;
    const expectedConfigDir = path.join(homedir(), ".poracode/claude-profiles/glm");
    expect(env?.ANTHROPIC_BASE_URL).toBe("https://api.z.ai/api/anthropic");
    expect(env?.ANTHROPIC_AUTH_TOKEN).toBe("sk-test");
    expect(env?.CLAUDE_CONFIG_DIR).toBe(expectedConfigDir);
  });

  it("appends configured models to the built-in list", () => {
    const adapter = createClaudeProfileAdapter({
      id: "glm",
      driver: "claude",
      displayName: "GLM",
      config: {
        configDir: "~/.poracode/claude-profiles/glm",
        models: [{ id: "glm-5.2", label: "GLM 5.2" }, { id: "glm-4.5-air" }],
      },
    });

    const ids = adapter.capabilities.models.map((model) => model.id);
    // Built-in Claude models stay selectable; custom ones are appended.
    expect(ids).toEqual([
      ...claudeCapabilities.models.map((model) => model.id),
      "glm-5.2",
      "glm-4.5-air",
    ]);
    expect(adapter.capabilities.models).toContainEqual({ id: "glm-5.2", label: "GLM 5.2" });
    expect(adapter.capabilities.models).toContainEqual({
      id: "glm-4.5-air",
      label: "glm-4.5-air",
    });
    // Built-in per-model maps are preserved (Claude models still work).
    expect(adapter.capabilities.modelEfforts).toEqual(claudeCapabilities.modelEfforts);
  });

  it("does not duplicate a configured model that matches a built-in id", () => {
    const adapter = createClaudeProfileAdapter({
      id: "glm",
      driver: "claude",
      displayName: "GLM",
      config: {
        configDir: "~/.poracode/claude-profiles/glm",
        models: [{ id: "claude-sonnet-5", label: "Sonnet (custom)" }],
      },
    });

    const sonnetEntries = adapter.capabilities.models.filter(
      (model) => model.id === "claude-sonnet-5",
    );
    expect(sonnetEntries).toEqual([{ id: "claude-sonnet-5", label: "Sonnet 5" }]);
  });

  it("does not duplicate repeated configured model ids", () => {
    const adapter = createClaudeProfileAdapter({
      id: "glm",
      driver: "claude",
      displayName: "GLM",
      config: {
        configDir: "~/.poracode/claude-profiles/glm",
        models: [{ id: "glm-5.2" }, { id: "glm-5.2", label: "GLM duplicate" }],
      },
    });

    const customEntries = adapter.capabilities.models.filter((model) => model.id === "glm-5.2");
    expect(customEntries).toEqual([{ id: "glm-5.2", label: "glm-5.2" }]);
  });

  it("restricts the effort allow-list and keeps an allowed default", () => {
    const adapter = createClaudeProfileAdapter({
      id: "glm",
      driver: "claude",
      displayName: "GLM",
      config: { configDir: "~/.poracode/claude-profiles/glm", efforts: ["high", "max"] },
    });

    expect(adapter.capabilities.efforts).toEqual(["high", "max"]);
    expect(adapter.capabilities.defaultEffort).toBe("high");
  });

  it("applies an external provider's default and per-model effort choices", () => {
    const adapter = createClaudeProfileAdapter({
      id: "kimi",
      driver: "claude",
      displayName: "Kimi",
      config: {
        configDir: "~/.poracode/claude-profiles/kimi",
        models: [{ id: "k3[1m]", label: "Kimi K3" }],
        efforts: ["low", "high", "max", "ultracode"],
        defaultEffort: "max",
        modelEfforts: { "k3[1m]": ["low", "high", "max", "ultracode"] },
      },
    });

    expect(adapter.capabilities.defaultEffort).toBe("max");
    expect(adapter.capabilities.modelEfforts["k3[1m]"]).toEqual([
      "low",
      "high",
      "max",
      "ultracode",
    ]);
  });

  it("re-homes the default effort to the first allowed tier when disabled", () => {
    const adapter = createClaudeProfileAdapter({
      id: "glm",
      driver: "claude",
      displayName: "GLM",
      config: { configDir: "~/.poracode/claude-profiles/glm", efforts: ["max", "ultracode"] },
    });

    expect(adapter.capabilities.efforts).toEqual(["max", "ultracode"]);
    expect(adapter.capabilities.defaultEffort).toBe("max");
  });

  it("leaves the built-in adapter capabilities untouched", () => {
    expect(createClaudeAdapter().capabilities.models).toEqual(claudeCapabilities.models);
    expect(createClaudeAdapter().capabilities.efforts).toEqual(claudeCapabilities.efforts);
  });

  it("falls back to the built-in efforts when an allow-list has no known tiers", () => {
    // Guards a hand-edited config: an all-unknown allow-list must not leave the
    // picker with zero effort options.
    const adapter = createClaudeProfileAdapter({
      id: "glm",
      driver: "claude",
      displayName: "GLM",
      config: { configDir: "~/.poracode/claude-profiles/glm", efforts: ["bogus", "nope"] },
    });

    expect(adapter.capabilities.efforts).toEqual(claudeCapabilities.efforts);
    expect(adapter.capabilities.defaultEffort).toBe(claudeCapabilities.defaultEffort);
  });
});

describe("parseClaudeAuthStatusJson", () => {
  it("extracts account metadata from Claude's auth-status JSON", () => {
    expect(
      parseClaudeAuthStatusJson(`{
        "loggedIn": true,
        "authMethod": "claude.ai",
        "email": "user@example.com",
        "orgName": "Yieldmo",
        "subscriptionType": "team"
      }`),
    ).toEqual({
      authState: "authenticated",
      providerMetadata: {
        authenticatedAs: "user@example.com",
        organization: "Yieldmo",
        plan: "Team Subscription",
        authMethod: "Claude.ai",
      },
    });
  });

  it("returns undefined for non-JSON output", () => {
    expect(parseClaudeAuthStatusJson("not json")).toBeUndefined();
  });
});

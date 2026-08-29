import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentAdapter } from "@/supervisor/agents/base";
import {
  createLiveProviderProfileSandbox,
  isolateCodexAdapterProfile,
  isolatedLiveProviderRuntimeSettings,
} from "./providerProfileSandbox";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function write(path: string, contents: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents, { mode: 0o600 });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("live provider profile sandbox", () => {
  it("forces Codex launch, resume, and detection onto the isolated environment", async () => {
    const adapter = {
      kind: "codex",
      label: "Codex",
      capabilities: {},
      detectInstall: async () => {
        throw new Error("canonical Codex detection must not run");
      },
      pluginId: "fixture-plugin",
      pluginVersion: "1.0.0",
      installPlugin: async () => ({ ok: true as const, version: "1.0.0" }),
      isPluginInstalled: async () => ({ installed: true, version: "1.0.0" }),
      buildLaunchArgv: () => ({
        binary: "codex",
        args: ["launch"],
        env: { KEEP: "yes", HOME: "/canonical/home" },
      }),
      buildResumeArgv: () => ({
        binary: "codex",
        args: ["resume"],
        env: { KEEP: "yes", CODEX_HOME: "/canonical/codex" },
      }),
    } as unknown as AgentAdapter;
    const environment = {
      HOME: "/isolated/home",
      USERPROFILE: "/isolated/home",
      CLAUDE_CONFIG_DIR: "/isolated/home/.claude",
      CODEX_HOME: "/isolated/home/.codex",
    };

    const isolated = isolateCodexAdapterProfile(
      adapter,
      environment,
      async () => "/isolated/bin/codex",
    );
    const project = { kind: "posix" as const, path: "/workspace" };
    const launch = isolated.buildLaunchArgv(project, { model: "fixture" }, "hello");
    const resume = isolated.buildResumeArgv(project, { model: "fixture" }, "", {
      providerSessionId: "session",
      discoveredAt: new Date(0).toISOString(),
    });

    expect(launch.env).toEqual({ KEEP: "yes", ...environment });
    expect(resume.env).toEqual({ KEEP: "yes", ...environment });
    expect(isolated.installPlugin).toBeUndefined();
    expect(isolated.isPluginInstalled).toBeUndefined();
    expect(isolated.pluginId).toBeUndefined();
    expect(isolated.pluginVersion).toBeUndefined();
    await expect(isolated.detectInstall()).resolves.toMatchObject({
      installed: true,
      executablePath: "/isolated/bin/codex",
      authState: "unknown",
    });
    expect(isolatedLiveProviderRuntimeSettings(false)).toEqual({
      disableCliHookPlugin: false,
      disabledBuiltInMcpServers: { browser: true },
    });
  });

  it("uses independent regular-file snapshots and restores the process environment", async () => {
    const sourceHome = makeTempDir("y-space-profile-source-");
    const tempParent = makeTempDir("y-space-profile-sandbox-parent-");
    const claudeState = join(sourceHome, ".claude.json");
    const claudeSettings = join(sourceHome, ".claude", "settings.json");
    const claudeCredentials = join(sourceHome, ".claude", ".credentials.json");
    const codexConfig = join(sourceHome, ".codex", "config.toml");
    const codexAuth = join(sourceHome, ".codex", "auth.json");
    const trustedProject = join(sourceHome, "trusted-project");
    write(
      claudeState,
      JSON.stringify({
        hasCompletedOnboarding: true,
        lastOnboardingVersion: "fixture-version",
        userID: "fixture-user",
        oauthAccount: { accountUuid: "fixture-account" },
        mcpServers: { unsafe: { command: "credential-exfiltrator" } },
        projects: {
          [trustedProject]: {
            hasTrustDialogAccepted: true,
            mcpServers: { unsafe: { command: "credential-exfiltrator" } },
          },
        },
      }),
    );
    write(
      claudeSettings,
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "unsafe-hook" }] }] },
        enabledPlugins: { "unsafe-plugin": true },
      }),
    );
    write(claudeCredentials, '{"token":"fixture-only"}\n');
    write(
      codexConfig,
      '[mcp_servers.unsafe]\ncommand = "credential-exfiltrator"\nnotify = ["unsafe-hook"]\n',
    );
    write(codexAuth, '{"token":"fixture-only"}\n');

    const originalEnv = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      CODEX_HOME: process.env.CODEX_HOME,
      PATH: process.env.PATH,
    };
    const sandbox = createLiveProviderProfileSandbox({
      sourceHome,
      sourceClaudeConfigDir: join(sourceHome, ".claude"),
      sourceClaudeStatePath: claudeState,
      sourceCodexHome: join(sourceHome, ".codex"),
      tempParent,
      trustedClaudeProjectPaths: [trustedProject],
    });

    try {
      await sandbox.withIsolatedProfiles(async () => {
        expect(process.env.HOME).toBe(sandbox.paths.home);
        expect(process.env.USERPROFILE).toBe(sandbox.paths.home);
        expect(homedir()).toBe(sandbox.paths.home);
        expect(process.env.CLAUDE_CONFIG_DIR).toBe(sandbox.paths.claudeConfigDir);
        expect(process.env.CODEX_HOME).toBe(sandbox.paths.codexHome);
        expect(process.env.PATH).toBe(originalEnv.PATH);

        const snapshots = [
          [claudeState, join(sandbox.paths.claudeConfigDir, ".claude.json")],
          [claudeSettings, join(sandbox.paths.claudeConfigDir, "settings.json")],
          [claudeCredentials, join(sandbox.paths.claudeConfigDir, ".credentials.json")],
          [codexConfig, join(sandbox.paths.codexHome, "config.toml")],
          [codexAuth, join(sandbox.paths.codexHome, "auth.json")],
        ] as const;
        for (const [source, target] of snapshots) {
          expect(lstatSync(target).isSymbolicLink()).toBe(false);
          expect(lstatSync(target).isFile()).toBe(true);
          const sourceStat = statSync(source);
          const targetStat = statSync(target);
          expect(
            sourceStat.ino === 0 ||
              targetStat.ino === 0 ||
              sourceStat.dev !== targetStat.dev ||
              sourceStat.ino !== targetStat.ino,
          ).toBe(true);
        }

        expect(
          JSON.parse(readFileSync(join(sandbox.paths.claudeConfigDir, ".claude.json"), "utf8")),
        ).toEqual({
          hasCompletedOnboarding: true,
          lastOnboardingVersion: "fixture-version",
          userID: "fixture-user",
          oauthAccount: { accountUuid: "fixture-account" },
          projects: { [trustedProject]: { hasTrustDialogAccepted: true } },
        });
        expect(
          JSON.parse(readFileSync(join(sandbox.paths.claudeConfigDir, "settings.json"), "utf8")),
        ).toEqual({});
        expect(readFileSync(join(sandbox.paths.codexHome, "config.toml"), "utf8")).toBe("");
        expect(readFileSync(join(sandbox.paths.claudeConfigDir, ".credentials.json"), "utf8")).toBe(
          readFileSync(claudeCredentials, "utf8"),
        );
        expect(readFileSync(join(sandbox.paths.codexHome, "auth.json"), "utf8")).toBe(
          readFileSync(codexAuth, "utf8"),
        );

        writeFileSync(join(sandbox.paths.codexHome, "config.toml"), 'model = "isolated"\n');
        writeFileSync(join(sandbox.paths.claudeConfigDir, ".claude.json"), '{"isolated":true}\n');
        expect(readFileSync(codexConfig, "utf8")).toBe(
          '[mcp_servers.unsafe]\ncommand = "credential-exfiltrator"\nnotify = ["unsafe-hook"]\n',
        );
        expect(JSON.parse(readFileSync(claudeState, "utf8"))).toMatchObject({
          mcpServers: { unsafe: { command: "credential-exfiltrator" } },
        });
      });

      expect(process.env.HOME).toBe(originalEnv.HOME);
      expect(process.env.USERPROFILE).toBe(originalEnv.USERPROFILE);
      expect(process.env.CLAUDE_CONFIG_DIR).toBe(originalEnv.CLAUDE_CONFIG_DIR);
      expect(process.env.CODEX_HOME).toBe(originalEnv.CODEX_HOME);
      expect(process.env.PATH).toBe(originalEnv.PATH);
      expect(() => sandbox.assertSourceProfilesUnchanged()).not.toThrow();
    } finally {
      sandbox.dispose();
    }
  });

  it("fails when a canonical mutable source profile changes", () => {
    const sourceHome = makeTempDir("y-space-profile-invariant-");
    const tempParent = makeTempDir("y-space-profile-invariant-parent-");
    const claudeState = join(sourceHome, ".claude.json");
    write(claudeState, '{"before":true}\n');
    const sandbox = createLiveProviderProfileSandbox({
      sourceHome,
      sourceClaudeConfigDir: join(sourceHome, ".claude"),
      sourceClaudeStatePath: claudeState,
      sourceCodexHome: join(sourceHome, ".codex"),
      tempParent,
    });

    try {
      writeFileSync(claudeState, '{"after":true}\n');
      expect(() => sandbox.assertSourceProfilesUnchanged()).toThrow(
        "provider profile changed during live integration test",
      );
      writeFileSync(claudeState, '{"before":true}\n');
    } finally {
      sandbox.dispose();
    }
  });
});

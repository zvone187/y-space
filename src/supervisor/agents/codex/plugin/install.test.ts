import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockExecFileSync = vi.hoisted(() =>
  vi.fn<(command: string, args?: string[], options?: Record<string, unknown>) => string | Buffer>(),
);
const mockExecInWsl = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string>>());
const mockStagePluginAssetsToWsl = vi.hoisted(() => vi.fn<(...args: unknown[]) => unknown>());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: mockExecFileSync,
  };
});
vi.mock("../../base", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../base")>()),
  execInWsl: mockExecInWsl,
}));
vi.mock("../../plugin/installerBase", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugin/installerBase")>()),
  stagePluginAssetsToWsl: mockStagePluginAssetsToWsl,
}));

import {
  codexHooksFeatureFlagForSemver,
  getCodexPluginPaths,
  isCodexSemverSupportedForGoals,
  isCodexSemverSupportedForHooks,
  installCodexPlugin,
  mergeCodexHooksDocument,
  parseCodexVersionLine,
  probeCodexCliSemver,
  resolveNativeCodexSqliteHome,
  seedNativeCodexHome,
  seedWslCodexHome,
  buildWslCodexHomeSeedScript,
} from "./install";
import { buildNativeHookCommandHead } from "../../plugin/installerBase";

const forwardPath = "C:\\Users\\demo\\.poracode\\agent-plugins\\codex\\forward.mjs";
const forwardPathUnix = "/home/demo/.poracode/agent-plugins/codex/forward.mjs";

/**
 * Test helpers build a `commandHead` matching one of the two shapes
 * `mergeCodexHooksDocument` accepts: WSL (`<node-path> <forward-mjs-path>`)
 * or native (`<wrapper-path>`). The merger doesn't care which shape it
 * gets — it just appends ` <event>`.
 */
function wslCommandHead(fp: string): string {
  return `${JSON.stringify("/home/demo/.nvm/versions/node/v22.11.0/bin/node")} ${JSON.stringify(fp)}`;
}

function nativeCommandHead(wrapperPath: string): string {
  return buildNativeHookCommandHead(wrapperPath);
}

function commandFor(head: string, event: string): string {
  return `${head} ${event}`;
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function expectIndependentFile(source: string, target: string): void {
  expect(lstatSync(target).isSymbolicLink()).toBe(false);
  const sourceStat = statSync(source);
  const targetStat = statSync(target);
  expect(sourceStat.isFile()).toBe(true);
  expect(targetStat.isFile()).toBe(true);
  expect(sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino).toBe(false);
}

const originalPlatform = process.platform;
const originalHome = process.env.HOME;
const originalCodexHome = process.env.CODEX_HOME;
const originalCodexSqliteHome = process.env.CODEX_SQLITE_HOME;
const tempDirs: string[] = [];

beforeEach(() => {
  mockExecFileSync.mockReset();
  mockExecInWsl.mockReset().mockResolvedValue("");
  mockStagePluginAssetsToWsl.mockReset();
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  if (originalCodexSqliteHome === undefined) delete process.env.CODEX_SQLITE_HOME;
  else process.env.CODEX_SQLITE_HOME = originalCodexSqliteHome;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("getCodexPluginPaths", () => {
  it("keeps SQLite state in the effective profile instead of the private hook home", () => {
    const root = mkdtempSync(join(tmpdir(), "y-space-codex-sqlite-home-"));
    tempDirs.push(root);
    const profileHome = join(root, "profile");
    const sqliteHome = join(root, "sqlite");
    process.env.CODEX_HOME = profileHome;
    process.env.CODEX_SQLITE_HOME = sqliteHome;

    expect(resolveNativeCodexSqliteHome()).toBe(sqliteHome);

    delete process.env.CODEX_SQLITE_HOME;
    expect(resolveNativeCodexSqliteHome()).toBe(profileHome);
  });

  it("places Codex hooks under Poracode's private CODEX_HOME", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "poracode-codex-paths-"));
    tempDirs.push(baseDir);
    const paths = getCodexPluginPaths({ envKind: "posix", baseDir });

    expect(paths.pluginDir).toBe(join(baseDir, "agent-plugins", "codex"));
    expect(paths.codexHomeDir).toBe(join(baseDir, "agent-plugins", "codex", "home"));
    expect(paths.codexHooksPath).toBe(
      join(baseDir, "agent-plugins", "codex", "home", "hooks.json"),
    );
  });

  it("preserves global skills and plugins through the private hook home", () => {
    const root = mkdtempSync(join(tmpdir(), "y-space-codex-private-home-"));
    tempDirs.push(root);
    const globalCodexHome = join(root, "global", ".codex");
    const privateCodexHome = join(root, "private", "home");
    const skill = join(globalCodexHome, "skills", "code-review", "SKILL.md");
    const plugin = join(globalCodexHome, "plugins", "cache", "acme", "plugin.json");
    mkdirSync(join(skill, ".."), { recursive: true });
    mkdirSync(join(plugin, ".."), { recursive: true });
    writeFileSync(skill, "---\nname: code-review\n---\n");
    writeFileSync(plugin, '{"name":"acme"}\n');

    seedNativeCodexHome(privateCodexHome, globalCodexHome);

    expect(readFileSync(join(privateCodexHome, "skills", "code-review", "SKILL.md"), "utf8")).toBe(
      "---\nname: code-review\n---\n",
    );
    expect(
      readFileSync(join(privateCodexHome, "plugins", "cache", "acme", "plugin.json"), "utf8"),
    ).toBe('{"name":"acme"}\n');
    expect(readFileSync(skill, "utf8")).toBe("---\nname: code-review\n---\n");
    expect(readFileSync(plugin, "utf8")).toBe('{"name":"acme"}\n');
  });

  it("seeds native installs from the effective custom CODEX_HOME without touching ~/.codex", async () => {
    const root = mkdtempSync(join(tmpdir(), "y-space-codex-custom-home-"));
    tempDirs.push(root);
    const fallbackHome = join(root, "fallback-home");
    const customCodexHome = join(root, "custom-codex-home");
    const baseDir = join(root, "y-space-data");
    const skill = join(customCodexHome, "skills", "custom", "SKILL.md");
    mkdirSync(join(skill, ".."), { recursive: true });
    writeFileSync(skill, "custom profile skill\n");
    process.env.HOME = fallbackHome;
    process.env.CODEX_HOME = customCodexHome;

    const result = await installCodexPlugin({ envKind: "posix", baseDir });

    expect(result.ok).toBe(true);
    expect(
      readFileSync(
        join(baseDir, "agent-plugins", "codex", "home", "skills", "custom", "SKILL.md"),
        "utf8",
      ),
    ).toBe("custom profile skill\n");
    expect(existsSync(join(fallbackHome, ".codex"))).toBe(false);
  });

  it("seeds native config.toml as an independent copy that cannot mutate the profile", () => {
    const root = mkdtempSync(join(tmpdir(), "y-space-codex-config-copy-"));
    tempDirs.push(root);
    const profileHome = join(root, "profile");
    const privateHome = join(root, "private");
    const profileConfig = join(profileHome, "config.toml");
    const privateConfig = join(privateHome, "config.toml");
    const originalConfig = 'model = "gpt-5.6"\n\n[features]\napps = true\n';
    mkdirSync(profileHome, { recursive: true });
    writeFileSync(profileConfig, originalConfig);
    const originalHash = fileSha256(profileConfig);

    seedNativeCodexHome(privateHome, profileHome);

    expectIndependentFile(profileConfig, privateConfig);
    expect(readFileSync(privateConfig, "utf8")).toBe(originalConfig);

    writeFileSync(
      privateConfig,
      `${originalConfig}\n[model_providers.y_space_private]\nname = "Y Space"\n`,
    );
    expect(readFileSync(profileConfig, "utf8")).toBe(originalConfig);
    expect(fileSha256(profileConfig)).toBe(originalHash);
  });

  it("refreshes an untouched native config copy without clobbering private provider updates", () => {
    const root = mkdtempSync(join(tmpdir(), "y-space-codex-config-refresh-"));
    tempDirs.push(root);
    const profileHome = join(root, "profile");
    const privateHome = join(root, "private");
    const profileConfig = join(profileHome, "config.toml");
    const privateConfig = join(privateHome, "config.toml");
    mkdirSync(profileHome, { recursive: true });
    writeFileSync(profileConfig, 'model = "gpt-5.5"\n');
    seedNativeCodexHome(privateHome, profileHome);

    const refreshedProfile = 'model = "gpt-5.6"\n\n[features]\napps = true\n';
    writeFileSync(profileConfig, refreshedProfile);
    seedNativeCodexHome(privateHome, profileHome);
    expect(readFileSync(privateConfig, "utf8")).toBe(refreshedProfile);

    const privateProviderConfig = `${refreshedProfile}\n[model_providers.y_space_private]\nname = "Y Space"\n`;
    writeFileSync(privateConfig, privateProviderConfig);
    const newerProfile = `${refreshedProfile}\n[plugins.example]\nenabled = true\n`;
    writeFileSync(profileConfig, newerProfile);
    seedNativeCodexHome(privateHome, profileHome);

    expectIndependentFile(profileConfig, privateConfig);
    expect(readFileSync(privateConfig, "utf8")).toBe(privateProviderConfig);
    expect(readFileSync(profileConfig, "utf8")).toBe(newerProfile);
  });

  it("removes an untouched native config copy and baseline when the profile source is removed", () => {
    const root = mkdtempSync(join(tmpdir(), "y-space-codex-config-source-removed-"));
    tempDirs.push(root);
    const profileHome = join(root, "profile");
    const privateHome = join(root, "private");
    const profileConfig = join(profileHome, "config.toml");
    const privateConfig = join(privateHome, "config.toml");
    const baseline = join(privateHome, ".y-space-config-source.toml");
    mkdirSync(profileHome, { recursive: true });
    writeFileSync(profileConfig, 'model = "gpt-5.6"\n');
    seedNativeCodexHome(privateHome, profileHome);

    rmSync(profileConfig);
    seedNativeCodexHome(privateHome, profileHome);

    expect(existsSync(privateConfig)).toBe(false);
    expect(existsSync(baseline)).toBe(false);
  });

  it("preserves a diverged native config copy when the profile source is removed", () => {
    const root = mkdtempSync(join(tmpdir(), "y-space-codex-config-source-removed-diverged-"));
    tempDirs.push(root);
    const profileHome = join(root, "profile");
    const privateHome = join(root, "private");
    const profileConfig = join(profileHome, "config.toml");
    const privateConfig = join(privateHome, "config.toml");
    const baseline = join(privateHome, ".y-space-config-source.toml");
    const profileContent = 'model = "gpt-5.6"\n';
    const privateContent = `${profileContent}\n[model_providers.y_space_private]\nname = "Y Space"\n`;
    mkdirSync(profileHome, { recursive: true });
    writeFileSync(profileConfig, profileContent);
    seedNativeCodexHome(privateHome, profileHome);
    writeFileSync(privateConfig, privateContent);

    rmSync(profileConfig);
    seedNativeCodexHome(privateHome, profileHome);

    expect(readFileSync(privateConfig, "utf8")).toBe(privateContent);
    expect(readFileSync(baseline, "utf8")).toBe(profileContent);
  });

  it.each(["symlink", "hardlink"] as const)(
    "detaches a legacy native config %s without changing its profile source",
    (linkKind) => {
      const root = mkdtempSync(join(tmpdir(), `y-space-codex-config-${linkKind}-`));
      tempDirs.push(root);
      const profileHome = join(root, "profile");
      const privateHome = join(root, "private");
      const profileConfig = join(profileHome, "config.toml");
      const privateConfig = join(privateHome, "config.toml");
      const profileContent = 'model = "gpt-5.6"\n';
      mkdirSync(profileHome, { recursive: true });
      mkdirSync(privateHome, { recursive: true });
      writeFileSync(profileConfig, profileContent);
      if (linkKind === "symlink") symlinkSync(profileConfig, privateConfig);
      else linkSync(profileConfig, privateConfig);

      seedNativeCodexHome(privateHome, profileHome);

      expectIndependentFile(profileConfig, privateConfig);
      writeFileSync(privateConfig, `${profileContent}\n[model_providers.y_space_private]\n`);
      expect(readFileSync(profileConfig, "utf8")).toBe(profileContent);
    },
  );

  it("preserves pre-existing private skills and plugins beside read-only profile links", () => {
    const root = mkdtempSync(join(tmpdir(), "y-space-codex-private-upgrade-"));
    tempDirs.push(root);
    const profileHome = join(root, "profile");
    const privateHome = join(root, "private");
    for (const [path, content] of [
      [join(profileHome, "skills", "profile", "SKILL.md"), "profile skill\n"],
      [join(profileHome, "plugins", "profile", "plugin.json"), "profile plugin\n"],
      [join(privateHome, "skills", "private", "SKILL.md"), "private skill\n"],
      [join(privateHome, "plugins", "private", "plugin.json"), "private plugin\n"],
    ] as const) {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, content);
    }

    const profileSkill = readFileSync(join(profileHome, "skills", "profile", "SKILL.md"), "utf8");
    const profilePlugin = readFileSync(
      join(profileHome, "plugins", "profile", "plugin.json"),
      "utf8",
    );

    seedNativeCodexHome(privateHome, profileHome);
    seedNativeCodexHome(privateHome, profileHome);

    expect(readFileSync(join(privateHome, "skills", "profile", "SKILL.md"), "utf8")).toBe(
      "profile skill\n",
    );
    expect(
      readFileSync(join(privateHome, "skills.y-space-private", "private", "SKILL.md"), "utf8"),
    ).toBe("private skill\n");
    expect(readFileSync(join(privateHome, "plugins", "profile", "plugin.json"), "utf8")).toBe(
      "profile plugin\n",
    );
    expect(
      readFileSync(join(privateHome, "plugins.y-space-private", "private", "plugin.json"), "utf8"),
    ).toBe("private plugin\n");
    expect(existsSync(join(privateHome, "skills.y-space-private-1"))).toBe(false);
    expect(existsSync(join(privateHome, "plugins.y-space-private-1"))).toBe(false);
    expect(existsSync(join(profileHome, "skills", "private"))).toBe(false);
    expect(existsSync(join(profileHome, "plugins", "private"))).toBe(false);
    expect(readFileSync(join(profileHome, "skills", "profile", "SKILL.md"), "utf8")).toBe(
      profileSkill,
    );
    expect(readFileSync(join(profileHome, "plugins", "profile", "plugin.json"), "utf8")).toBe(
      profilePlugin,
    );
    expect(existsSync(join(profileHome, "sessions"))).toBe(false);
    expect(existsSync(join(profileHome, "session_index.jsonl"))).toBe(false);
  });

  it("preserves global skills and plugins in the WSL private-home seed", () => {
    const script = buildWslCodexHomeSeedScript(
      "/home/demo",
      "/home/demo/.poracode/agent-plugins/codex/home",
    );

    expect(script).toContain("/home/demo/.codex/skills");
    expect(script).toContain("/home/demo/.codex/plugins");
    expect(script).toContain("/home/demo/.poracode/agent-plugins/codex/home/skills");
    expect(script).toContain("/home/demo/.poracode/agent-plugins/codex/home/plugins");
  });

  it("uses a custom WSL CODEX_HOME without referencing the default profile", () => {
    const script = buildWslCodexHomeSeedScript(
      "/home/demo",
      "/home/demo/.poracode/agent-plugins/codex/home",
      "/srv/codex-profile",
    );

    expect(script).toContain("/srv/codex-profile/skills");
    expect(script).toContain("/srv/codex-profile/plugins");
    expect(script).not.toContain("/home/demo/.codex");
  });

  it("keeps a custom WSL SQLite home separate from the private hook home", async () => {
    mockExecInWsl
      .mockResolvedValueOnce("/srv/codex-profile\0/var/lib/codex-sqlite")
      .mockResolvedValueOnce("");

    const homes = await seedWslCodexHome(
      "Ubuntu",
      "/home/demo",
      "/home/demo/.poracode/agent-plugins/codex/home",
    );

    expect(homes).toEqual({
      profileHome: "/srv/codex-profile",
      sqliteHome: "/var/lib/codex-sqlite",
    });
    expect(mockExecInWsl.mock.calls[1]?.[3]).toEqual([
      "-lc",
      expect.stringContaining("/srv/codex-profile/sessions"),
    ]);
  });

  it("preserves pre-existing WSL private trees beside read-only profile links", () => {
    const root = mkdtempSync(join(tmpdir(), "y-space-codex-wsl-upgrade-"));
    tempDirs.push(root);
    const profileHome = join(root, "profile");
    const privateHome = join(root, "private");
    for (const [path, content] of [
      [join(profileHome, "skills", "profile", "SKILL.md"), "profile skill\n"],
      [join(profileHome, "plugins", "profile", "plugin.json"), "profile plugin\n"],
      [join(privateHome, "skills", "private", "SKILL.md"), "private skill\n"],
      [join(privateHome, "plugins", "private", "plugin.json"), "private plugin\n"],
    ] as const) {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, content);
    }
    const script = buildWslCodexHomeSeedScript(root, privateHome, profileHome);

    const result = spawnSync("/bin/sh", ["-c", script], { encoding: "utf8" });
    const repeated = spawnSync("/bin/sh", ["-c", script], { encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(repeated.status).toBe(0);
    expect(readFileSync(join(privateHome, "skills", "profile", "SKILL.md"), "utf8")).toBe(
      "profile skill\n",
    );
    expect(
      readFileSync(join(privateHome, "skills.y-space-private", "private", "SKILL.md"), "utf8"),
    ).toBe("private skill\n");
    expect(
      readFileSync(join(privateHome, "plugins.y-space-private", "private", "plugin.json"), "utf8"),
    ).toBe("private plugin\n");
    expect(existsSync(join(privateHome, "skills.y-space-private-1"))).toBe(false);
    expect(existsSync(join(privateHome, "plugins.y-space-private-1"))).toBe(false);
    expect(existsSync(join(profileHome, "skills", "private"))).toBe(false);
    expect(existsSync(join(profileHome, "plugins", "private"))).toBe(false);
    expect(existsSync(join(profileHome, "sessions"))).toBe(false);
    expect(existsSync(join(profileHome, "session_index.jsonl"))).toBe(false);
  });

  it("seeds WSL config.toml as an independent copy that cannot mutate the profile", () => {
    const root = mkdtempSync(join(tmpdir(), "y-space-codex-wsl-config-copy-"));
    tempDirs.push(root);
    const profileHome = join(root, "profile");
    const privateHome = join(root, "private");
    const profileConfig = join(profileHome, "config.toml");
    const privateConfig = join(privateHome, "config.toml");
    const originalConfig = 'model = "gpt-5.6"\n\n[features]\napps = true\n';
    mkdirSync(profileHome, { recursive: true });
    writeFileSync(profileConfig, originalConfig);

    const result = spawnSync(
      "/bin/sh",
      ["-c", buildWslCodexHomeSeedScript(root, privateHome, profileHome)],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expectIndependentFile(profileConfig, privateConfig);
    const originalHash = fileSha256(profileConfig);
    writeFileSync(
      privateConfig,
      `${originalConfig}\n[model_providers.y_space_private]\nname = "Y Space"\n`,
    );
    expect(readFileSync(profileConfig, "utf8")).toBe(originalConfig);
    expect(fileSha256(profileConfig)).toBe(originalHash);
  });

  it("refreshes an untouched WSL config copy without clobbering private provider updates", () => {
    const root = mkdtempSync(join(tmpdir(), "y-space-codex-wsl-config-refresh-"));
    tempDirs.push(root);
    const profileHome = join(root, "profile");
    const privateHome = join(root, "private");
    const profileConfig = join(profileHome, "config.toml");
    const privateConfig = join(privateHome, "config.toml");
    const script = buildWslCodexHomeSeedScript(root, privateHome, profileHome);
    mkdirSync(profileHome, { recursive: true });
    writeFileSync(profileConfig, 'model = "gpt-5.5"\n');
    expect(spawnSync("/bin/sh", ["-c", script]).status).toBe(0);

    const refreshedProfile = 'model = "gpt-5.6"\n\n[features]\napps = true\n';
    writeFileSync(profileConfig, refreshedProfile);
    expect(spawnSync("/bin/sh", ["-c", script]).status).toBe(0);
    expect(readFileSync(privateConfig, "utf8")).toBe(refreshedProfile);

    const privateProviderConfig = `${refreshedProfile}\n[model_providers.y_space_private]\nname = "Y Space"\n`;
    writeFileSync(privateConfig, privateProviderConfig);
    const newerProfile = `${refreshedProfile}\n[plugins.example]\nenabled = true\n`;
    writeFileSync(profileConfig, newerProfile);
    expect(spawnSync("/bin/sh", ["-c", script]).status).toBe(0);

    expectIndependentFile(profileConfig, privateConfig);
    expect(readFileSync(privateConfig, "utf8")).toBe(privateProviderConfig);
    expect(readFileSync(profileConfig, "utf8")).toBe(newerProfile);
  });

  it("removes an untouched WSL config copy and baseline when the profile source is removed", () => {
    const root = mkdtempSync(join(tmpdir(), "y-space-codex-wsl-config-source-removed-"));
    tempDirs.push(root);
    const profileHome = join(root, "profile");
    const privateHome = join(root, "private");
    const profileConfig = join(profileHome, "config.toml");
    const privateConfig = join(privateHome, "config.toml");
    const baseline = join(privateHome, ".y-space-config-source.toml");
    const script = buildWslCodexHomeSeedScript(root, privateHome, profileHome);
    mkdirSync(profileHome, { recursive: true });
    writeFileSync(profileConfig, 'model = "gpt-5.6"\n');
    expect(spawnSync("/bin/sh", ["-c", script]).status).toBe(0);

    rmSync(profileConfig);
    expect(spawnSync("/bin/sh", ["-c", script]).status).toBe(0);

    expect(existsSync(privateConfig)).toBe(false);
    expect(existsSync(baseline)).toBe(false);
  });

  it("preserves a diverged WSL config copy when the profile source is removed", () => {
    const root = mkdtempSync(join(tmpdir(), "y-space-codex-wsl-config-source-removed-diverged-"));
    tempDirs.push(root);
    const profileHome = join(root, "profile");
    const privateHome = join(root, "private");
    const profileConfig = join(profileHome, "config.toml");
    const privateConfig = join(privateHome, "config.toml");
    const baseline = join(privateHome, ".y-space-config-source.toml");
    const profileContent = 'model = "gpt-5.6"\n';
    const privateContent = `${profileContent}\n[model_providers.y_space_private]\nname = "Y Space"\n`;
    const script = buildWslCodexHomeSeedScript(root, privateHome, profileHome);
    mkdirSync(profileHome, { recursive: true });
    writeFileSync(profileConfig, profileContent);
    expect(spawnSync("/bin/sh", ["-c", script]).status).toBe(0);
    writeFileSync(privateConfig, privateContent);

    rmSync(profileConfig);
    expect(spawnSync("/bin/sh", ["-c", script]).status).toBe(0);

    expect(readFileSync(privateConfig, "utf8")).toBe(privateContent);
    expect(readFileSync(baseline, "utf8")).toBe(profileContent);
  });

  it.each(["symlink", "hardlink"] as const)(
    "detaches a legacy WSL config %s without changing its profile source",
    (linkKind) => {
      const root = mkdtempSync(join(tmpdir(), `y-space-codex-wsl-config-${linkKind}-`));
      tempDirs.push(root);
      const profileHome = join(root, "profile");
      const privateHome = join(root, "private");
      const profileConfig = join(profileHome, "config.toml");
      const privateConfig = join(privateHome, "config.toml");
      const profileContent = 'model = "gpt-5.6"\n';
      mkdirSync(profileHome, { recursive: true });
      mkdirSync(privateHome, { recursive: true });
      writeFileSync(profileConfig, profileContent);
      if (linkKind === "symlink") symlinkSync(profileConfig, privateConfig);
      else linkSync(profileConfig, privateConfig);

      const result = spawnSync(
        "/bin/sh",
        ["-c", buildWslCodexHomeSeedScript(root, privateHome, profileHome)],
        { encoding: "utf8" },
      );

      expect(result.status).toBe(0);
      expectIndependentFile(profileConfig, privateConfig);
      writeFileSync(privateConfig, `${profileContent}\n[model_providers.y_space_private]\n`);
      expect(readFileSync(profileConfig, "utf8")).toBe(profileContent);
    },
  );

  it("fails WSL seeding closed when profile resolution or linking fails", async () => {
    mockExecInWsl
      .mockResolvedValueOnce("/srv/codex-profile")
      .mockRejectedValueOnce(new Error("link failed"));

    await expect(
      seedWslCodexHome("Ubuntu", "/home/demo", "/home/demo/.poracode/agent-plugins/codex/home"),
    ).rejects.toThrow("link failed");
  });

  it("reports WSL seed/link failure as an unsuccessful plugin install", async () => {
    mockStagePluginAssetsToWsl.mockReturnValue({
      ok: true,
      deploy: { home: "/home/demo", linuxBaseDir: "/home/demo/.poracode" },
      linuxPluginDir: "/home/demo/.poracode/agent-plugins/codex",
    });
    mockExecInWsl
      .mockResolvedValueOnce("/srv/codex-profile")
      .mockRejectedValueOnce(new Error("link failed"));

    const result = await installCodexPlugin(
      { envKind: "wsl", wslDistro: "Ubuntu" },
      { resolvedNodePath: "/usr/bin/node" },
    );

    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining("failed to seed private Codex home in wsl distro Ubuntu"),
    });
  });
});

describe("probeCodexCliSemver", () => {
  it("does not use shell:true for Windows version probes", () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    mockExecFileSync.mockReturnValue("codex-cli 0.130.0");

    expect(probeCodexCliSemver()).toEqual([0, 130, 0]);

    const options = mockExecFileSync.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(options).toMatchObject({
      encoding: "utf8",
      timeout: 8000,
      windowsHide: true,
    });
    expect(options).not.toHaveProperty("shell");
  });
});

describe("parseCodexVersionLine + isCodexSemverSupportedForHooks", () => {
  it("parses codex-cli semver lines", () => {
    expect(parseCodexVersionLine("codex-cli 0.122.0")).toEqual([0, 122, 0]);
    expect(parseCodexVersionLine("codex-cli 0.121.99")).toEqual([0, 121, 99]);
    expect(parseCodexVersionLine("  codex-cli 1.0.0  ")).toEqual([1, 0, 0]);
  });

  it("returns null for unexpected output", () => {
    expect(parseCodexVersionLine("codex 0.122.0")).toBeNull();
    expect(parseCodexVersionLine("")).toBeNull();
  });

  it("gates hooks support at 0.122.0", () => {
    expect(isCodexSemverSupportedForHooks([0, 121, 0])).toBe(false);
    expect(isCodexSemverSupportedForHooks([0, 121, 99])).toBe(false);
    expect(isCodexSemverSupportedForHooks([0, 122, 0])).toBe(true);
    expect(isCodexSemverSupportedForHooks([0, 123, 0])).toBe(true);
    expect(isCodexSemverSupportedForHooks(null)).toBe(false);
  });

  it("uses the renamed hooks feature flag from 0.130.0 onward", () => {
    expect(codexHooksFeatureFlagForSemver([0, 129, 99])).toBe("codex_hooks");
    expect(codexHooksFeatureFlagForSemver([0, 130, 0])).toBe("hooks");
    expect(codexHooksFeatureFlagForSemver([0, 131, 0])).toBe("hooks");
    expect(codexHooksFeatureFlagForSemver([1, 0, 0])).toBe("hooks");
    expect(codexHooksFeatureFlagForSemver(null)).toBe("codex_hooks");
  });

  it("gates the goals feature flag at 0.130.0", () => {
    expect(isCodexSemverSupportedForGoals([0, 129, 99])).toBe(false);
    expect(isCodexSemverSupportedForGoals([0, 130, 0])).toBe(true);
    expect(isCodexSemverSupportedForGoals([1, 0, 0])).toBe(true);
    expect(isCodexSemverSupportedForGoals(null)).toBe(false);
  });
});

describe("mergeCodexHooksDocument", () => {
  it("creates only Poracode entries when hooks.json was absent (WSL shape)", () => {
    const head = wslCommandHead(forwardPath);
    const doc = mergeCodexHooksDocument(null, head);
    expect(Object.keys(doc.hooks)).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "PermissionRequest",
      "Stop",
    ]);
    const stop = doc.hooks.Stop as unknown[];
    expect(stop).toHaveLength(1);
    const stopHook = (stop[0] as { hooks: { command: string }[] }).hooks[0];
    expect(stopHook?.command).toBe(commandFor(head, "Stop"));
  });

  it("preserves user matcher groups and appends Poracode", () => {
    const head = wslCommandHead(forwardPath);
    const userGroup = {
      matcher: "*",
      hooks: [{ type: "command", command: "node user-script.js" }],
    };
    const existing = {
      hooks: {
        Stop: [userGroup],
        SessionStart: [],
      },
    };
    const doc = mergeCodexHooksDocument(existing, head);
    const stop = doc.hooks.Stop as unknown[];
    expect(stop).toHaveLength(2);
    expect(stop[0]).toEqual(userGroup);
    const lc = (stop[1] as { hooks: { command: string }[] }).hooks[0];
    expect(lc?.command).toBe(commandFor(head, "Stop"));
  });

  it("prunes stale Poracode groups by forward.mjs path fingerprint and replaces", () => {
    const head = wslCommandHead(forwardPath);
    const stale = {
      hooks: [
        {
          type: "command",
          command: `node "C:\\old\\.poracode\\agent-plugins\\codex\\forward.mjs" Stop`,
        },
      ],
    };
    const existing = { hooks: { Stop: [stale] } };
    const doc = mergeCodexHooksDocument(existing, head);
    const stop = doc.hooks.Stop as unknown[];
    expect(stop).toHaveLength(1);
    const h = (stop[0] as { hooks: { command: string }[] }).hooks[0];
    expect(h?.command).toBe(commandFor(head, "Stop"));
  });

  it("prunes legacy Lightcode groups by native wrapper fingerprint", () => {
    const head = nativeCommandHead(
      "C:\\Users\\demo\\.poracode\\agent-plugins\\codex\\poracode-hook.cmd",
    );
    const stale = {
      hooks: [
        {
          type: "command",
          command: `"C:\\old\\.poracode\\agent-plugins\\codex\\lightcode-hook.cmd" Stop`,
        },
      ],
    };
    const existing = { hooks: { Stop: [stale] } };
    const doc = mergeCodexHooksDocument(existing, head);
    const stop = doc.hooks.Stop as unknown[];
    expect(stop).toHaveLength(1);
    const h = (stop[0] as { hooks: { command: string }[] }).hooks[0];
    expect(h?.command).toBe(commandFor(head, "Stop"));
  });

  it("is idempotent when re-run with the same command head", () => {
    const head = wslCommandHead(forwardPathUnix);
    const first = mergeCodexHooksDocument(null, head);
    const second = mergeCodexHooksDocument(first, head);
    expect(second).toEqual(first);
  });

  it("is idempotent when re-run with the same Windows forward path", () => {
    const first = mergeCodexHooksDocument(null, forwardPath);
    const second = mergeCodexHooksDocument(first, forwardPath);
    expect(second).toEqual(first);
  });

  it("uses matcher only for SessionStart, PreToolUse, PostToolUse", () => {
    const doc = mergeCodexHooksDocument(null, forwardPath);
    expect((doc.hooks.SessionStart as { matcher?: string }[])[0]).toMatchObject({
      matcher: "*",
    });
    expect((doc.hooks.UserPromptSubmit as { matcher?: string }[])[0]?.matcher).toBeUndefined();
    expect((doc.hooks.PermissionRequest as { matcher?: string }[])[0]?.matcher).toBeUndefined();
    expect((doc.hooks.Stop as { matcher?: string }[])[0]?.matcher).toBeUndefined();
  });
});

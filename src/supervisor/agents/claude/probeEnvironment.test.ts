import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockBase = vi.hoisted(() => ({
  readWslLoginShellCommandOutputAsync:
    vi.fn<typeof import("../base").readWslLoginShellCommandOutputAsync>(),
  resolveWslHomeDirectoryAsync: vi.fn<typeof import("../base").resolveWslHomeDirectoryAsync>(),
}));

vi.mock("../base", async () => {
  const actual = await vi.importActual<typeof import("../base")>("../base");
  return {
    ...actual,
    readWslLoginShellCommandOutputAsync: mockBase.readWslLoginShellCommandOutputAsync,
    resolveWslHomeDirectoryAsync: mockBase.resolveWslHomeDirectoryAsync,
  };
});

import { resolveClaudeProbeEnvironment } from "./probeEnvironment";

const tempDirs: string[] = [];

beforeEach(() => {
  mockBase.readWslLoginShellCommandOutputAsync.mockReset();
  mockBase.resolveWslHomeDirectoryAsync.mockReset();
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveClaudeProbeEnvironment", () => {
  it("creates a stable private native config while retaining default secure-storage auth", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "y-space-claude-probe-native-"));
    tempDirs.push(baseDir);

    const first = await resolveClaudeProbeEnvironment({
      adapterKind: "claude",
      baseDir,
      location: { kind: "posix", path: "/repo" },
    });
    const second = await resolveClaudeProbeEnvironment({
      adapterKind: "claude",
      baseDir,
      location: { kind: "posix", path: "/another-repo" },
    });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      ok: true,
      probeEnv: {
        CLAUDE_SECURESTORAGE_CONFIG_DIR: "",
      },
    });
    if (!first.ok) throw new Error("expected native probe isolation");
    expect(first.probeEnv.CLAUDE_CONFIG_DIR).toBe(
      join(baseDir, "cache", "claude-probes", "default", "config"),
    );
    expect(first).not.toHaveProperty("authEnv");
    const configMode = statSync(first.probeEnv.CLAUDE_CONFIG_DIR).mode & 0o777;
    const identityMode = statSync(dirname(first.probeEnv.CLAUDE_CONFIG_DIR)).mode & 0o777;
    expect(configMode).toBe(process.platform === "win32" ? configMode : 0o700);
    expect(identityMode).toBe(process.platform === "win32" ? identityMode : 0o700);
  });

  it("keeps explicit-profile auth in its original secure storage without copying secrets", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "y-space-claude-probe-profile-"));
    tempDirs.push(baseDir);
    const profileDir = join(baseDir, "real-profile");

    const result = await resolveClaudeProbeEnvironment({
      adapterKind: "claude:work",
      baseDir,
      location: { kind: "posix", path: "/repo" },
      profileConfigDir: profileDir,
      customEnv: {
        ANTHROPIC_AUTH_TOKEN: "test-token-never-written",
        CLAUDE_CONFIG_DIR: "/must-not-win",
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected profile probe isolation");
    expect(result.probeEnv).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: "test-token-never-written",
      CLAUDE_SECURESTORAGE_CONFIG_DIR: profileDir,
    });
    expect(result.probeEnv.CLAUDE_CONFIG_DIR).not.toBe(profileDir);
    expect(result.probeEnv.CLAUDE_CONFIG_DIR).not.toBe("/must-not-win");
    expect(result.authEnv).toEqual({
      ANTHROPIC_AUTH_TOKEN: "test-token-never-written",
      CLAUDE_CONFIG_DIR: profileDir,
    });
  });

  it("creates the stable private directory inside the WSL-owned Y Space data root", async () => {
    mockBase.resolveWslHomeDirectoryAsync.mockResolvedValue("/home/demo");
    mockBase.readWslLoginShellCommandOutputAsync.mockResolvedValue({
      ok: true,
      stdout: "",
      stderr: "",
    });

    const result = await resolveClaudeProbeEnvironment({
      adapterKind: "claude:work",
      location: {
        kind: "wsl",
        distro: "Ubuntu",
        linuxPath: "/repo",
        uncPath: "\\\\wsl$\\Ubuntu\\repo",
      },
      profileConfigDir: "~/.claude-work",
      customEnv: { ANTHROPIC_BASE_URL: "https://example.invalid" },
    });

    expect(result).toMatchObject({
      ok: true,
      probeEnv: {
        ANTHROPIC_BASE_URL: "https://example.invalid",
        CLAUDE_SECURESTORAGE_CONFIG_DIR: "/home/demo/.claude-work",
      },
      authEnv: {
        ANTHROPIC_BASE_URL: "https://example.invalid",
        CLAUDE_CONFIG_DIR: "/home/demo/.claude-work",
      },
    });
    if (!result.ok) throw new Error("expected WSL probe isolation");
    expect(result.probeEnv.CLAUDE_CONFIG_DIR).toMatch(
      /^\/home\/demo\/\.poracode\/cache\/claude-probes\/profile-[a-f0-9]{16}\/config$/u,
    );
    expect(mockBase.readWslLoginShellCommandOutputAsync).toHaveBeenCalledWith(
      "Ubuntu",
      "/",
      "sh",
      expect.arrayContaining([result.probeEnv.CLAUDE_CONFIG_DIR]),
      expect.objectContaining({ timeout: 5_000 }),
    );
  });

  it("fails closed when the WSL-owned private directory cannot be created", async () => {
    mockBase.resolveWslHomeDirectoryAsync.mockResolvedValue("/home/demo");
    mockBase.readWslLoginShellCommandOutputAsync.mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "permission denied",
    });

    await expect(
      resolveClaudeProbeEnvironment({
        adapterKind: "claude",
        location: {
          kind: "wsl",
          distro: "Ubuntu",
          linuxPath: "/repo",
          uncPath: "\\\\wsl$\\Ubuntu\\repo",
        },
      }),
    ).resolves.toEqual({ ok: false });
  });
});

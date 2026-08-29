import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStatus } from "@/shared/contracts";
import type { DetectionSpec, DetectProbeCtx } from "../base";

const mockBase = vi.hoisted(() => ({
  detectAgentInstall: vi.fn<typeof import("../base").detectAgentInstall>(),
}));
const mockProbe = vi.hoisted(() => ({
  probeClaudeCapabilities: vi.fn<typeof import("./probe").probeClaudeCapabilities>(),
}));

vi.mock("../base", async () => {
  const actual = await vi.importActual<typeof import("../base")>("../base");
  return { ...actual, detectAgentInstall: mockBase.detectAgentInstall };
});

vi.mock("./probe", async () => {
  const actual = await vi.importActual<typeof import("./probe")>("./probe");
  return { ...actual, probeClaudeCapabilities: mockProbe.probeClaudeCapabilities };
});

import { createClaudeAdapter, createClaudeProfileAdapter } from "./index";

const tempDirs: string[] = [];

beforeEach(() => {
  mockBase.detectAgentInstall.mockReset();
  mockBase.detectAgentInstall.mockImplementation(async (_ctx, spec: DetectionSpec) => {
    return {
      kind: spec.kind,
      label: spec.label,
      installed: true,
      authState: "unknown",
      capabilities: spec.capabilities,
    } satisfies AgentStatus;
  });
  mockProbe.probeClaudeCapabilities.mockReset();
  mockProbe.probeClaudeCapabilities.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function capturedSpec(): DetectionSpec {
  const spec = mockBase.detectAgentInstall.mock.calls.at(-1)?.[1] as DetectionSpec | undefined;
  if (!spec) throw new Error("detectAgentInstall did not receive a spec");
  return spec;
}

describe("Claude adapter detection isolation", () => {
  it("uses a private app-owned config for default detection only", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "y-space-default-detection-"));
    tempDirs.push(baseDir);
    const adapter = createClaudeAdapter();

    await adapter.detectInstall({ envKind: "posix", baseDir });

    const spec = capturedSpec();
    expect(spec.probeEnv).toEqual({
      CLAUDE_CONFIG_DIR: join(baseDir, "cache", "claude-probes", "default", "config"),
      CLAUDE_SECURESTORAGE_CONFIG_DIR: "",
    });
    expect(
      adapter.buildLaunchArgv({ kind: "posix", path: "/repo" }, { model: "sonnet" }, "hello").env,
    ).toBe(undefined);
  });

  it("keeps profile auth env on login while using the private env for SDK probing", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "y-space-profile-detection-"));
    tempDirs.push(baseDir);
    const profileDir = join(baseDir, "actual-profile");
    const adapter = createClaudeProfileAdapter({
      id: "work",
      driver: "claude",
      displayName: "Work",
      config: { configDir: profileDir },
      environment: {
        ANTHROPIC_BASE_URL: { value: "https://profile.example.invalid" },
      },
    });

    await adapter.detectInstall({ envKind: "posix", baseDir });

    const spec = capturedSpec();
    expect(spec.probeEnv).toMatchObject({
      ANTHROPIC_BASE_URL: "https://profile.example.invalid",
      CLAUDE_SECURESTORAGE_CONFIG_DIR: profileDir,
    });
    expect(spec.probeEnv?.CLAUDE_CONFIG_DIR).not.toBe(profileDir);

    const probeCtx: DetectProbeCtx = {
      location: { kind: "posix", path: "/repo" },
      executablePath: "/usr/local/bin/claude",
      version: "2.1.219",
      probeEnv: spec.probeEnv,
    };
    await spec.capabilitiesProbe?.(probeCtx);
    expect(mockProbe.probeClaudeCapabilities).toHaveBeenCalledWith(probeCtx, {
      env: spec.probeEnv,
      authMethodEnv: {
        ANTHROPIC_BASE_URL: "https://profile.example.invalid",
        CLAUDE_CONFIG_DIR: profileDir,
      },
    });

    expect(
      adapter.buildLaunchArgv({ kind: "posix", path: "/repo" }, { model: "sonnet" }, "hello").env,
    ).toEqual({
      ANTHROPIC_BASE_URL: "https://profile.example.invalid",
      CLAUDE_CONFIG_DIR: profileDir,
    });
  });

  it("skips every Claude process probe when the private target cannot be provisioned", async () => {
    const root = mkdtempSync(join(tmpdir(), "y-space-failed-detection-"));
    tempDirs.push(root);
    const invalidBaseDir = join(root, "not-a-directory");
    writeFileSync(invalidBaseDir, "file blocks directory creation", "utf8");

    await createClaudeAdapter().detectInstall({ envKind: "posix", baseDir: invalidBaseDir });

    const spec = capturedSpec();
    const probeCtx: DetectProbeCtx = {
      location: { kind: "posix", path: "/repo" },
      executablePath: "/usr/local/bin/claude",
    };
    await expect(spec.versionProbe?.(probeCtx)).resolves.toBeUndefined();
    await expect(spec.statusProbe?.(probeCtx)).resolves.toBeUndefined();
    await expect(spec.capabilitiesProbe?.(probeCtx)).resolves.toBeUndefined();
    expect(spec.probeEnv).toBeUndefined();
    expect(mockProbe.probeClaudeCapabilities).not.toHaveBeenCalled();
  });
});

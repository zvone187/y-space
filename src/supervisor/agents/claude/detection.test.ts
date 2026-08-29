import { beforeEach, describe, expect, it, vi } from "vitest";

const mockBase = vi.hoisted(() => ({
  readAgentCommandOutput: vi.fn<typeof import("../base").readAgentCommandOutput>(),
}));
const mockProbe = vi.hoisted(() => ({
  probeClaudeCapabilities: vi.fn<typeof import("./probe").probeClaudeCapabilities>(),
}));

vi.mock("../base", async () => {
  const actual = await vi.importActual<typeof import("../base")>("../base");
  return { ...actual, readAgentCommandOutput: mockBase.readAgentCommandOutput };
});

vi.mock("./probe", () => ({
  probeClaudeCapabilities: mockProbe.probeClaudeCapabilities,
}));

import { claudeDetectionSpec } from "./detection";

beforeEach(() => {
  mockBase.readAgentCommandOutput.mockReset();
  mockBase.readAgentCommandOutput.mockResolvedValue({
    ok: true,
    stdout: '{"loggedIn":true}',
    stderr: "",
  });
  mockProbe.probeClaudeCapabilities.mockReset();
  mockProbe.probeClaudeCapabilities.mockResolvedValue(undefined);
});

describe("claudeDetectionSpec", () => {
  it("forwards the merged detection-only environment to status and capability probes", async () => {
    const probeEnv = {
      CLAUDE_CONFIG_DIR: "/private/y-space/claude-probe/config",
      CLAUDE_SECURESTORAGE_CONFIG_DIR: "",
    };
    const ctx = {
      location: { kind: "posix" as const, path: "/repo" },
      executablePath: "/usr/local/bin/claude",
      version: "2.1.219",
      probeEnv,
    };

    await claudeDetectionSpec.statusProbe?.(ctx);
    await claudeDetectionSpec.capabilitiesProbe?.(ctx);

    expect(mockBase.readAgentCommandOutput).toHaveBeenCalledWith(
      ctx.location,
      ctx.executablePath,
      ["auth", "status"],
      expect.objectContaining({ env: probeEnv }),
    );
    expect(mockProbe.probeClaudeCapabilities).toHaveBeenCalledWith(ctx, { env: probeEnv });
  });
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const shellEnv = vi.hoisted(() => ({ current: undefined as Record<string, string> | undefined }));

vi.mock("../base", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../base")>()),
  getProjectShellEnv: vi.fn<(cwd: string) => Record<string, string> | undefined>(
    () => shellEnv.current,
  ),
}));

import { createOpenCodeAdapter } from ".";

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("OpenCode terminal effective profile policy", () => {
  it("scans the primed login-shell config env inherited by the native process", () => {
    const project = mkdtempSync(join(tmpdir(), "y-space-opencode-shell-env-"));
    tempDirs.push(project);
    const shellSelectedConfig = join(project, "shell-selected-opencode.jsonc");
    writeFileSync(
      shellSelectedConfig,
      `{
        mcp: {
          e2e: { type: "local", command: ["npx", "-y", "@playwright/mcp@latest"] },
          github: { type: "remote", url: "https://api.github.test/mcp" },
        },
      }`,
    );
    shellEnv.current = { ...process.env, OPENCODE_CONFIG: shellSelectedConfig };

    const argv = createOpenCodeAdapter().buildLaunchArgv(
      { kind: "posix", path: project },
      { model: "opencode/big-pickle" },
      "",
      undefined,
      {
        mcpServers: [
          {
            id: "browser",
            name: "browser",
            timeoutMs: 30_000,
            transport: {
              type: "http",
              url: "http://127.0.0.1:43210/mcp",
              headers: {},
            },
          },
        ],
      },
    );
    const launchConfig = JSON.parse(argv.env?.OPENCODE_CONFIG_CONTENT ?? "{}") as {
      mcp?: Record<string, { enabled?: boolean }>;
    };

    expect(launchConfig.mcp?.e2e).toMatchObject({ enabled: false });
    expect(launchConfig.mcp?.github).toMatchObject({ enabled: false });
    expect(argv.env?.PORACODE_OPENCODE_BROWSER_EXCLUSIVE).toBe("1");
  });

  it("restores the provider profile when the canonical Browser is absent", () => {
    const project = mkdtempSync(join(tmpdir(), "y-space-opencode-profile-restored-"));
    tempDirs.push(project);
    const shellSelectedConfig = join(project, "shell-selected-opencode.jsonc");
    writeFileSync(
      shellSelectedConfig,
      `{ mcp: { neutral: { type: "remote", url: "https://neutral.test/mcp" } } }`,
    );
    shellEnv.current = { ...process.env, OPENCODE_CONFIG: shellSelectedConfig };

    const argv = createOpenCodeAdapter().buildLaunchArgv(
      { kind: "posix", path: project },
      { model: "opencode/big-pickle", browserMcp: false },
      "",
      undefined,
      { mcpServers: [] },
    );

    expect(argv.env).toBeUndefined();
  });
});

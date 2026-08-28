import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PIPEDREAM_ENV_FILE_MAX_BYTES, type PipedreamBootstrap } from "@/shared/pipedreamBootstrap";
import {
  applyPersistedPipedreamEnvFile,
  clearPipedreamEnvFilePath,
  readPipedreamEnvFilePath,
  writePipedreamEnvFilePath,
} from "./pipedreamEnvFileSettings";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "y-space-pipedream-settings-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Pipedream env-file settings", () => {
  it("persists only an absolute selected path with owner-only permissions", () => {
    const root = tempRoot();
    const selectedPath = join(root, ".env.pipedream");

    writePipedreamEnvFilePath(root, selectedPath);

    expect(readPipedreamEnvFilePath(root)).toBe(selectedPath);
    const settingsPath = join(root, "pipedream-env-file.json");
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      version: 1,
      envFilePath: selectedPath,
    });
    const ownerOnly = (statSync(settingsPath).mode & 0o077) === 0;
    expect(process.platform === "win32" || ownerOnly).toBe(true);
  });

  it("ignores invalid or non-absolute persisted metadata", () => {
    const root = tempRoot();
    const settingsPath = join(root, "pipedream-env-file.json");
    writeFileSync(settingsPath, JSON.stringify({ version: 1, envFilePath: "relative.env" }));
    chmodSync(settingsPath, 0o600);

    expect(readPipedreamEnvFilePath(root)).toBeUndefined();
  });

  it("forgets only the path metadata", () => {
    const root = tempRoot();
    const selectedPath = join(root, ".env.pipedream");
    writeFileSync(selectedPath, "PIPEDREAM_CLIENT_ID=still-owned-by-user\n", { mode: 0o600 });
    writePipedreamEnvFilePath(root, selectedPath);

    clearPipedreamEnvFilePath(root);

    expect(readPipedreamEnvFilePath(root)).toBeUndefined();
    expect(readFileSync(selectedPath, "utf8")).toContain("still-owned-by-user");
  });

  it("reapplies a selected env file after restart without persisting its values", () => {
    const root = tempRoot();
    const selectedPath = join(root, ".env.pipedream");
    writeFileSync(
      selectedPath,
      [
        "PIPEDREAM_CLIENT_ID=restart-client-id",
        "PIPEDREAM_CLIENT_SECRET=restart-client-secret",
        "PIPEDREAM_PROJECT_ID=proj_Restart123",
        "PIPEDREAM_ENVIRONMENT=production",
      ].join("\n"),
      { mode: 0o600 },
    );
    writePipedreamEnvFilePath(root, selectedPath);

    const result = applyPersistedPipedreamEnvFile(root, { state: "absent" });

    expect(result).toMatchObject({
      state: "ready",
      credentials: { projectId: "proj_Restart123", environment: "production" },
    });
    expect(readFileSync(join(root, "pipedream-env-file.json"), "utf8")).not.toContain(
      "restart-client-secret",
    );
  });

  it("preserves an explicit startup bootstrap ahead of persisted metadata", () => {
    const root = tempRoot();
    const selectedPath = join(root, ".env.pipedream");
    writeFileSync(selectedPath, "PIPEDREAM_CLIENT_ID=ignored\n", { mode: 0o600 });
    writePipedreamEnvFilePath(root, selectedPath);
    const explicit: PipedreamBootstrap = {
      state: "partial",
      missingKeys: ["PIPEDREAM_PROJECT_ID"],
    };

    expect(applyPersistedPipedreamEnvFile(root, explicit)).toBe(explicit);
  });

  it("does not read an oversized selected file during restart", () => {
    const root = tempRoot();
    const selectedPath = join(root, ".env.pipedream");
    writeFileSync(selectedPath, "x".repeat(PIPEDREAM_ENV_FILE_MAX_BYTES + 1), { mode: 0o600 });
    writePipedreamEnvFilePath(root, selectedPath);
    const absent: PipedreamBootstrap = { state: "absent" };

    expect(applyPersistedPipedreamEnvFile(root, absent)).toBe(absent);
  });
});

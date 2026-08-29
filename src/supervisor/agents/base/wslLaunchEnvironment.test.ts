import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDirectWslEnvironmentCommandArgs,
  cleanupTrackedWslLaunchEnvironmentFiles,
  createWslLaunchEnvironmentFile,
  partitionWslLaunchEnvironment,
} from "./wslLaunchEnvironment";

describe("WSL launch environment files", () => {
  it("isolates every explicit launch value in a mode-0600 launch-scoped file", () => {
    const secret = "wsl-launch-file-secret-sentinel";
    const partitioned = partitionWslLaunchEnvironment({
      SAFE_FLAG: "1",
      PORACODE_MCP_CLAUDE_BROWSER_ABC_HEADER_AUTHORIZATION_DEF: secret,
    });

    expect(partitioned.inline).toEqual({});
    expect(partitioned.protected).toEqual({
      SAFE_FLAG: "1",
      PORACODE_MCP_CLAUDE_BROWSER_ABC_HEADER_AUTHORIZATION_DEF: secret,
    });

    const launchFile = createWslLaunchEnvironmentFile(partitioned.protected);
    expect(launchFile).toBeDefined();
    expect(launchFile?.sourcePrefix).not.toContain(secret);
    expect(launchFile?.sourcePrefix).not.toContain("SAFE_FLAG=1");
    expect(readFileSync(launchFile!.hostPath, "utf8")).toContain(secret);
    expect(readFileSync(launchFile!.hostPath, "utf8")).toContain("SAFE_FLAG='1'");
    expect(statSync(launchFile!.hostPath).mode & 0o777).toBe(0o600);

    launchFile?.cleanup();
  });

  it("sources the protected environment and removes its launch artifacts under POSIX sh", () => {
    const secret = "wsl-shell-source-secret-sentinel";
    const variable = "PORACODE_MCP_CLAUDE_BROWSER_ABC_HEADER_AUTHORIZATION_DEF";
    const launchFile = createWslLaunchEnvironmentFile({ [variable]: secret })!;
    const directory = dirname(launchFile.hostPath);

    const result = spawnSync(
      "/bin/sh",
      ["-c", `${launchFile.sourcePrefix}printf '%s' "$${variable}"`],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(secret);
    expect(result.stderr).toBe("");
    expect(existsSync(launchFile.hostPath)).toBe(false);
    expect(existsSync(directory)).toBe(false);

    launchFile.cleanup();
  });

  it("keeps every WSL launch value, including non-MCP passwords, out of argv", () => {
    const password = "opencode-server-password-sentinel";
    const direct = buildDirectWslEnvironmentCommandArgs("opencode", ["serve"], {
      PATH: "/usr/bin:/bin",
      OPENCODE_SERVER_PASSWORD: password,
    });

    expect(JSON.stringify(direct.args)).not.toContain(password);
    expect(JSON.stringify(direct.args)).not.toContain("/usr/bin:/bin");
    expect(direct.cleanup).toEqual(expect.any(Function));

    direct.cleanup?.();
  });

  it("restores the provider argv after sourcing the complete launch environment", () => {
    const direct = buildDirectWslEnvironmentCommandArgs(
      "/bin/sh",
      ["-c", `printf '%s|%s' "$SAFE_FLAG" "$OPENCODE_SERVER_PASSWORD"`],
      {
        SAFE_FLAG: "ready",
        OPENCODE_SERVER_PASSWORD: "password-from-file",
      },
    );

    const result = spawnSync(direct.args[0]!, direct.args.slice(1), { encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("ready|password-from-file");
    expect(result.stderr).toBe("");

    direct.cleanup?.();
  });

  it("does not start the provider when the launch directory cannot be removed", () => {
    const launchFile = createWslLaunchEnvironmentFile({ SAFE_FLAG: "1" })!;
    const directory = dirname(launchFile.hostPath);
    writeFileSync(join(directory, "unexpected-entry"), "blocks rmdir", { flag: "wx" });

    const result = spawnSync(
      "/bin/sh",
      ["-c", `${launchFile.sourcePrefix}printf '%s' 'provider-started'`],
      { encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("provider-started");
    expect(existsSync(launchFile.hostPath)).toBe(false);
    expect(existsSync(directory)).toBe(true);

    launchFile.cleanup();
    expect(existsSync(directory)).toBe(false);
  });

  it("cleans every tracked launch file during synchronous process shutdown cleanup", () => {
    const first = createWslLaunchEnvironmentFile({ FIRST: "one" })!;
    const second = createWslLaunchEnvironmentFile({ SECOND: "two" })!;
    const directories = [dirname(first.hostPath), dirname(second.hostPath)];

    cleanupTrackedWslLaunchEnvironmentFiles();

    expect(existsSync(first.hostPath)).toBe(false);
    expect(existsSync(second.hostPath)).toBe(false);
    expect(directories.every((directory) => !existsSync(directory))).toBe(true);

    first.cleanup();
    second.cleanup();
  });
});

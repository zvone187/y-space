import { describe, expect, it } from "vitest";
import type { ProjectLocation } from "@/shared/contracts";
import { getWslCommand } from "../base";
import { buildAcpTerminalLaunch, resolveAcpTerminalCwd } from "./sessionTerminalLaunch";

const wslProject: ProjectLocation = {
  kind: "wsl",
  distro: "Ubuntu",
  linuxPath: "/home/demo/project",
  uncPath: "\\\\wsl.localhost\\Ubuntu\\home\\demo\\project",
};

describe.skipIf(process.platform !== "win32")("buildAcpTerminalLaunch", () => {
  it("uses the shared WSL login-shell command without default-shell reparsing", () => {
    const launch = buildAcpTerminalLaunch(
      wslProject,
      "/home/demo/project",
      "node",
      ["-p", "line1\nline2 `$(ignored)` 'single' \"double\""],
      {},
    );

    expect(launch.command).toBe(getWslCommand());
    expect(launch.args).toEqual([
      "-d",
      "Ubuntu",
      "--cd",
      "/home/demo/project",
      "--exec",
      expect.any(String),
      "-l",
      "-i",
      "-c",
      "export TERM='xterm-256color'; exec 'node' '-p' 'line1\nline2 `$(ignored)` '\\''single'\\'' \"double\"'",
    ]);
  });
});

describe("resolveAcpTerminalCwd", () => {
  it("rejects a cwd outside a regular project", () => {
    expect(() => resolveAcpTerminalCwd(wslProject, "/tmp/elsewhere")).toThrow("Invalid params");
  });

  it("allows any cwd when the workspace is Home", () => {
    expect(
      resolveAcpTerminalCwd(
        {
          kind: "wsl",
          distro: "Ubuntu",
          linuxPath: "/home/demo",
          uncPath: "\\\\wsl.localhost\\Ubuntu\\home\\demo",
        },
        "/tmp/elsewhere",
      ),
    ).toBe("/tmp/elsewhere");
    expect(
      resolveAcpTerminalCwd({ kind: "windows", path: "C:\\Users\\me" }, "E:\\work\\repo"),
    ).toBe("E:\\work\\repo");
  });
});

describe("buildAcpTerminalLaunch privileged environment isolation", () => {
  it("strips ambient and request-supplied Pipedream/MCP credentials", () => {
    const saved = process.env.PIPEDREAM_CLIENT_SECRET;
    process.env.PIPEDREAM_CLIENT_SECRET = "ambient-developer-secret";
    try {
      const launch = buildAcpTerminalLaunch(
        { kind: "posix", path: "/tmp/project" },
        "/tmp/project",
        "/usr/bin/env",
        [],
        {
          SAFE_REQUEST_VALUE: "kept",
          PORACODE_APP_CONTROLS_MCP_TOKEN: "app-root",
          PIPEDREAM_PROJECT_ID: "project-secret",
        },
      );

      expect(launch.env.SAFE_REQUEST_VALUE).toBe("kept");
      expect(launch.env.PIPEDREAM_CLIENT_SECRET).toBeUndefined();
      expect(launch.env.PIPEDREAM_PROJECT_ID).toBeUndefined();
      expect(launch.env.PORACODE_APP_CONTROLS_MCP_TOKEN).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.PIPEDREAM_CLIENT_SECRET;
      else process.env.PIPEDREAM_CLIENT_SECRET = saved;
    }
  });
});

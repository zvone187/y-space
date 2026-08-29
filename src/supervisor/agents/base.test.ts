import { describe, expect, it } from "vitest";
import type { ProjectLocation } from "@/shared/contracts";
import { posixPrivilegedEnvironmentUnsetPrefix } from "@/supervisor/privilegedChildEnvironment";
import { getWslCommand, injectWslEnv, buildAgentCommand } from "./base";

const wslProject: ProjectLocation = {
  kind: "wsl",
  distro: "Ubuntu",
  linuxPath: "/home/demo/project",
  uncPath: "\\\\wsl.localhost\\Ubuntu\\home\\demo\\project",
};

describe.skipIf(process.platform !== "win32")("buildAgentCommand", () => {
  it("launches WSL agent commands through the resolved login shell", () => {
    expect(buildAgentCommand(wslProject, "codex", ["--version"])).toEqual({
      command: getWslCommand(),
      args: [
        "-d",
        "Ubuntu",
        "--cd",
        "/home/demo/project",
        "--exec",
        expect.any(String),
        "-l",
        "-i",
        "-c",
        "exec 'codex' '--version'",
      ],
    });
  });

  it("uses the detected executable path inside a login shell when available", () => {
    expect(
      buildAgentCommand(
        wslProject,
        "codex",
        ["resume", "session-1"],
        "/home/demo/.nvm/versions/node/v24/bin/codex",
      ),
    ).toEqual({
      command: getWslCommand(),
      args: [
        "-d",
        "Ubuntu",
        "--cd",
        "/home/demo/project",
        "--exec",
        expect.any(String),
        "-l",
        "-i",
        "-c",
        "exec '/home/demo/.nvm/versions/node/v24/bin/codex' 'resume' 'session-1'",
      ],
    });
  });

  it("stages env vars outside the host-visible WSL shell argv", () => {
    const value = "claude-no-flicker-sentinel";
    const spec = buildAgentCommand(wslProject, "claude", ["--print"], undefined, {
      CLAUDE_CODE_NO_FLICKER: value,
    });
    const script = spec.args[spec.args.length - 1]!;
    expect(JSON.stringify(spec.args)).not.toContain(value);
    expect(script).toContain("__y_space_launch_env_file");
    expect(script).toContain("exec 'claude' '--print'");
    expect(spec.cleanup).toEqual(expect.any(Function));

    spec.cleanup?.();
  });
});

describe("injectWslEnv", () => {
  it("stages injected values outside the WSL script argv", () => {
    const original = buildAgentCommand(wslProject, "claude", ["--version"]);
    const patched = injectWslEnv(original, wslProject, {
      CLAUDE_CODE_NO_FLICKER: "no-flicker-sentinel",
      ANOTHER_VAR: "another-value-sentinel",
    });

    // Original is unchanged
    expect(original.args[original.args.length - 1]).toBe(
      `${posixPrivilegedEnvironmentUnsetPrefix()}exec 'claude' '--version'`,
    );

    const script = patched.args[patched.args.length - 1]!;
    expect(JSON.stringify(patched.args)).not.toContain("no-flicker-sentinel");
    expect(JSON.stringify(patched.args)).not.toContain("another-value-sentinel");
    expect(script).toContain("__y_space_launch_env_file");
    expect(script).toContain("exec 'claude' '--version'");
    expect(patched.cleanup).toEqual(expect.any(Function));

    patched.cleanup?.();
  });

  it("returns the spec unchanged for non-WSL locations", () => {
    const windowsProject: ProjectLocation = { kind: "windows", path: "C:\\project" };
    const original = { command: "claude", args: ["--version"] };
    const result = injectWslEnv(original, windowsProject, { FOO: "1" });
    expect(result).toBe(original);
  });

  it("returns the spec unchanged when env is empty", () => {
    const original = buildAgentCommand(wslProject, "claude", ["--version"]);
    const result = injectWslEnv(original, wslProject, {});
    expect(result).toBe(original);
  });
});

describe("WSL launch credential isolation", () => {
  it("keeps MCP, provider-profile, and hook credentials out of host-visible argv", () => {
    const mcpSecret = "claude-wsl-mcp-secret-sentinel";
    const profileSecret = "claude-wsl-profile-token-sentinel";
    const hookSecret = "claude-wsl-hook-secret-sentinel";
    const spec = buildAgentCommand(wslProject, "claude", ["--print"], undefined, {
      CLAUDE_CODE_NO_FLICKER: "1",
      ANTHROPIC_AUTH_TOKEN: profileSecret,
      PORACODE_HOOK_SECRET: hookSecret,
      PORACODE_MCP_CLAUDE_BROWSER_ABC_HEADER_AUTHORIZATION_DEF: mcpSecret,
    });

    expect(JSON.stringify(spec.args)).not.toContain(mcpSecret);
    expect(JSON.stringify(spec.args)).not.toContain(profileSecret);
    expect(JSON.stringify(spec.args)).not.toContain(hookSecret);
    expect(JSON.stringify(spec.args)).not.toContain("CLAUDE_CODE_NO_FLICKER='1'");
    expect(spec.args.at(-1)).toContain("__y_space_launch_env_file");
    expect(spec.cleanup).toEqual(expect.any(Function));

    spec.cleanup?.();
  });
});

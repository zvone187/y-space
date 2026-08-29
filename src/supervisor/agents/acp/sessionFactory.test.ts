import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupTrackedWslLaunchEnvironmentFiles,
  type CreateStructuredSessionInput,
} from "../base";
import { AcpStructuredSession } from "./session";
import { createAcpStructuredSession } from "./sessionFactory";

function makeInput(
  overrides: Partial<CreateStructuredSessionInput> = {},
): CreateStructuredSessionInput {
  return {
    threadId: "thread-1",
    projectLocation: { kind: "windows", path: "C:\\repo" },
    config: { model: "test-model" },
    ...overrides,
  };
}

// The ACP child is spawned from `command.env` (session.ts spreads it into the
// child env), so the command `AcpStructuredSession.create` receives IS the
// proof that the provider's baseSpawnEnv reaches the spawn.
describe("createAcpStructuredSession baseSpawnEnv merge", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    cleanupTrackedWslLaunchEnvironmentFiles();
  });

  function spyOnCreate() {
    return vi
      .spyOn(AcpStructuredSession, "create")
      .mockReturnValue({ sessionId: "session-1" } as unknown as AcpStructuredSession);
  }

  it("applies input.baseSpawnEnv to the spawned ACP command", () => {
    const createSpy = spyOnCreate();

    createAcpStructuredSession(
      { command: "droid", args: ["exec", "--output-format", "acp"] },
      makeInput({ baseSpawnEnv: { DROID_DISABLE_AUTO_UPDATE: "true" } }),
    );

    expect(createSpy.mock.calls[0]?.[0]).toEqual({
      command: "droid",
      args: ["exec", "--output-format", "acp"],
      env: { DROID_DISABLE_AUTO_UPDATE: "true" },
    });
  });

  it("lets command-declared env win over the base env", () => {
    const createSpy = spyOnCreate();

    createAcpStructuredSession(
      {
        command: "droid",
        args: ["exec"],
        env: { DROID_DISABLE_AUTO_UPDATE: "false", EXTRA: "kept" },
      },
      makeInput({ baseSpawnEnv: { DROID_DISABLE_AUTO_UPDATE: "true" } }),
    );

    expect(createSpy.mock.calls[0]?.[0]).toMatchObject({
      env: { DROID_DISABLE_AUTO_UPDATE: "false", EXTRA: "kept" },
    });
  });

  it("stages merged environment outside WSL argv before launching the ACP agent", () => {
    const createSpy = spyOnCreate();

    createAcpStructuredSession(
      {
        command: "wsl.exe",
        args: [
          "-d",
          "Ubuntu",
          "--cd",
          "/repo",
          "--exec",
          "/bin/bash",
          "-l",
          "-i",
          "-c",
          "cursor-agent acp",
        ],
      },
      makeInput({
        projectLocation: {
          kind: "wsl",
          distro: "Ubuntu",
          linuxPath: "/repo",
          uncPath: "\\\\wsl.localhost\\Ubuntu\\repo",
        },
        baseSpawnEnv: { CURSOR_API_KEY: "profile-key" },
      }),
    );

    const command = createSpy.mock.calls[0]?.[0];
    const serializedArgs = JSON.stringify(command?.args ?? []);
    const script = String(command?.args.at(-1));
    expect(command?.env).toEqual({ CURSOR_API_KEY: "profile-key" });
    expect(serializedArgs).not.toContain("CURSOR_API_KEY");
    expect(serializedArgs).not.toContain("profile-key");
    expect(script).toContain("__y_space_launch_env_file");
    expect(script).toContain('/bin/rm -f -- "$1"');
    expect(script).toContain('/bin/rmdir -- "$2"');
    expect(script).toContain("cursor-agent acp");
    expect(command?.cleanup).toEqual(expect.any(Function));

    command?.cleanup?.();
  });

  it("passes the command through unchanged when nothing contributes env", () => {
    const createSpy = spyOnCreate();
    const command = { command: "droid", args: ["exec"] };

    createAcpStructuredSession(command, makeInput());

    expect(createSpy.mock.calls[0]?.[0]).toBe(command);
  });

  it("forwards adapter initialize metadata to the ACP session", () => {
    const createSpy = spyOnCreate();

    createAcpStructuredSession(
      { command: "qwen", args: ["--acp"] },
      makeInput({ acpInitializeMeta: { "qwen.daemon.activeWorkHeartbeat": { v: 1 } } }),
    );

    expect(createSpy.mock.calls[0]?.[3]).toMatchObject({
      initializeMeta: { "qwen.daemon.activeWorkHeartbeat": { v: 1 } },
    });
  });
});

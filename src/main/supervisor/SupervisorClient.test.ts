import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupervisorEvent } from "@/shared/ipc";
import {
  SUPERVISOR_BOOTSTRAP_FAILURE_CODE,
  SUPERVISOR_SECRET_BOOTSTRAP_PROTOCOL_VERSION,
} from "@/shared/supervisorSecretBootstrap";

const forkMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => unknown>());
const terminateChildProcessTreeMock = vi.hoisted(() => vi.fn<() => void>());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, fork: forkMock };
});

vi.mock("@/shared/processTree", () => ({
  terminateChildProcessTree: terminateChildProcessTreeMock,
}));

import { SupervisorClient, type SupervisorClientOptions } from "./SupervisorClient";

type SendCallback = (error?: Error | null) => void;

interface FakeChild extends EventEmitter {
  connected: boolean;
  pid?: number;
  stdout: null;
  stderr: null;
  send: ReturnType<typeof vi.fn<(message: unknown, callback?: SendCallback) => boolean>>;
  kill: ReturnType<typeof vi.fn<() => boolean>>;
}

function makeFakeChild(
  options: {
    autoAcknowledgeBootstrap?: boolean;
    bootstrapFailureCode?: string;
  } = {},
): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.connected = true;
  child.stdout = null;
  child.stderr = null;
  child.send = vi.fn<(message: unknown, callback?: SendCallback) => boolean>(
    (message, callback) => {
      callback?.();
      if (
        options.autoAcknowledgeBootstrap !== false &&
        typeof message === "object" &&
        message !== null &&
        "kind" in message &&
        message.kind === "supervisor-secret-bootstrap" &&
        "id" in message &&
        typeof message.id === "string"
      ) {
        queueMicrotask(() => {
          child.emit(
            "message",
            options.bootstrapFailureCode
              ? {
                  kind: "supervisor-secret-bootstrap-reply",
                  replyTo: message.id,
                  ok: false,
                  error: "Supervisor security bootstrap failed.",
                  failureCode: options.bootstrapFailureCode,
                }
              : {
                  kind: "supervisor-secret-bootstrap-reply",
                  replyTo: message.id,
                  ok: true,
                  data: { version: SUPERVISOR_SECRET_BOOTSTRAP_PROTOCOL_VERSION, ready: true },
                },
          );
        });
      }
      if (
        typeof message === "object" &&
        message !== null &&
        "kind" in message &&
        message.kind === "pipedream-privileged-bootstrap" &&
        "id" in message &&
        typeof message.id === "string"
      ) {
        queueMicrotask(() => {
          child.emit("message", {
            kind: "pipedream-privileged-reply",
            replyTo: message.id,
            ok: true,
            data: {
              personalMcp: { enabled: false, authenticated: false, serverName: "pd" },
              connect: { state: "absent" },
            },
          });
        });
      }
      return true;
    },
  );
  child.kill = vi.fn<() => boolean>();
  return child;
}

function makeClient(
  options: Pick<
    SupervisorClientOptions,
    | "prepareStartThread"
    | "resolveExtraEnv"
    | "resolvePipedreamPrivilegedBootstrap"
    | "recoverStartupFailure"
  > = {},
  childOptions: {
    autoAcknowledgeBootstrap?: boolean;
    bootstrapFailureCode?: string;
  } = {},
) {
  const child = makeFakeChild(childOptions);
  forkMock.mockReturnValue(child);
  const onStarted = vi.fn<() => void>();
  const client = new SupervisorClient({
    appVersion: "test",
    isDev: true,
    supervisorPath: "/fake/supervisor.cjs",
    wslHelpersDir: "/fake/wsl",
    secretStorageKey: Buffer.alloc(32, 19).toString("base64"),
    allowPipedreamOauthPersistence: false,
    onEvent: vi.fn<(event: SupervisorEvent) => void>(),
    onReset: vi.fn<() => void>(),
    onStarted,
    ...options,
  });
  client.start("/base");
  return { client, child, onStarted };
}

const epipe = () => Object.assign(new Error("write EPIPE"), { code: "EPIPE" });

/** Capture the request id passed to `send`, replying via the provided callback. */
function captureSentId(child: FakeChild): () => string {
  let id = "";
  child.send.mockImplementation((message, callback) => {
    id = (message as { id: string }).id;
    callback?.();
    return true;
  });
  return () => id;
}

describe("SupervisorClient.call", () => {
  beforeEach(() => {
    forkMock.mockReset();
    terminateChildProcessTreeMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("exposes successful supervisor readiness", async () => {
    const { client } = makeClient();

    await expect(client.waitUntilReady()).resolves.toBeUndefined();

    client.dispose();
  });

  it("rejects exposed readiness when the OAuth store blocks bootstrap", async () => {
    const { client } = makeClient(
      {},
      {
        bootstrapFailureCode: SUPERVISOR_BOOTSTRAP_FAILURE_CODE.MCP_OAUTH_STORE_UNAVAILABLE,
      },
    );

    await expect(client.waitUntilReady()).rejects.toThrow("Supervisor security bootstrap failed.");

    client.dispose();
  });

  it("rejects (does not orphan the caller) when send fails with EPIPE", async () => {
    const { client, child } = makeClient();
    child.send.mockImplementation((_message, callback) => {
      callback?.(epipe());
      return true;
    });
    await expect(client.call("any" as never, undefined as never)).rejects.toThrow("EPIPE");
  });

  it("rejects when send throws synchronously with EPIPE", async () => {
    const { client, child } = makeClient();
    child.send.mockImplementation(() => {
      throw epipe();
    });
    await expect(client.call("any" as never, undefined as never)).rejects.toThrow("EPIPE");
  });

  it("rejects on a non-EPIPE send error", async () => {
    const { client, child } = makeClient();
    child.send.mockImplementation((_message, callback) => {
      callback?.(new Error("boom"));
      return true;
    });
    await expect(client.call("any" as never, undefined as never)).rejects.toThrow("boom");
  });

  it("resolves when a matching reply arrives", async () => {
    const { client, child, onStarted } = makeClient();
    await vi.waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
    child.send.mockClear();
    const getId = captureSentId(child);
    const promise = client.call("any" as never, undefined as never);
    await vi.waitFor(() => expect(child.send).toHaveBeenCalled());
    child.emit("message", { replyTo: getId(), ok: true, data: "result-value" });
    await expect(promise).resolves.toBe("result-value");
  });

  it("applies main-process start invariants before sending the request", async () => {
    const { client, child } = makeClient({
      prepareStartThread: (payload) => ({
        ...payload,
        invariantDisabledBuiltInMcpServerIds: ["crossagents"],
      }),
    });
    let request: { id: string; payload: unknown } | undefined;
    child.send.mockImplementation((message, callback) => {
      request = message as { id: string; payload: unknown };
      callback?.();
      return true;
    });
    const promise = client.call("startThread", {
      threadId: "child-thread",
      projectLocation: { kind: "windows", path: "C:\\repo" },
      agentKind: "codex",
      config: { model: "test" },
      prompt: "Inspect this.",
      initialSize: { cols: 120, rows: 40 },
    });
    await vi.waitFor(() => expect(request).toBeDefined());
    expect(request?.payload).toMatchObject({
      invariantDisabledBuiltInMcpServerIds: ["crossagents"],
    });
    child.emit("message", { replyTo: request!.id, ok: true, data: { threadId: "child-thread" } });
    await expect(promise).resolves.toEqual({ threadId: "child-thread" });
  });

  it("rejects when the reply reports failure", async () => {
    const { client, child, onStarted } = makeClient();
    await vi.waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
    child.send.mockClear();
    const getId = captureSentId(child);
    const promise = client.call("any" as never, undefined as never);
    await vi.waitFor(() => expect(child.send).toHaveBeenCalled());
    child.emit("message", { replyTo: getId(), ok: false, error: "handler failed" });
    await expect(promise).rejects.toThrow("handler failed");
  });

  it("times out a request whose reply never arrives", async () => {
    vi.useFakeTimers();
    const { client, child } = makeClient();
    captureSentId(child);
    const promise = client.call("slow" as never, undefined as never);
    // Capture the eventual rejection now so it is never an unhandled rejection.
    const guarded = promise.catch((error: unknown) => error);
    // Flush the `await startedGate` continuation so the request + timer register…
    await vi.advanceTimersByTimeAsync(0);
    expect(child.send).toHaveBeenCalled();
    // …then advance past the timeout window.
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);
    const error = await guarded;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/timed out/);
  });

  it("clears the timeout once resolved (no late rejection)", async () => {
    vi.useFakeTimers();
    const { client, child } = makeClient();
    const getId = captureSentId(child);
    const promise = client.call("any" as never, undefined as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(child.send).toHaveBeenCalled();
    child.emit("message", { replyTo: getId(), ok: true, data: "ok" });
    await expect(promise).resolves.toBe("ok");
    // Advancing past the timeout window must not produce a late rejection.
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);
  });
});

describe("SupervisorClient lifecycle", () => {
  beforeEach(() => {
    forkMock.mockReset();
    terminateChildProcessTreeMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("terminates the supervisor tree without restarting it when disposed", async () => {
    vi.useFakeTimers();
    const { client, child } = makeClient();

    client.dispose();
    child.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(terminateChildProcessTreeMock).toHaveBeenCalledExactlyOnceWith(child);
    expect(forkMock).toHaveBeenCalledOnce();
  });

  it("does not run a crash restart that was scheduled before disposal", async () => {
    vi.useFakeTimers();
    const { client, child } = makeClient();

    child.emit("exit", 1);
    client.dispose();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(forkMock).toHaveBeenCalledOnce();
  });

  it("sends Pipedream credentials only after the secret handshake, never in child env", async () => {
    const { child, onStarted } = makeClient({
      resolvePipedreamPrivilegedBootstrap: () => ({
        bootstrap: {
          state: "ready",
          source: "environment",
          credentials: {
            clientId: "client-id-private",
            clientSecret: "client-secret-private",
            projectId: "proj_Test123",
            environment: "development",
          },
        },
        externalUserId: "y-space-install-private-id",
      }),
    });

    const forkOptions = forkMock.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv };
    expect(JSON.stringify(forkOptions.env)).not.toMatch(/PIPEDREAM|client-secret-private/);
    expect(forkOptions.env).not.toHaveProperty("PORACODE_SECRET_STORAGE_KEY");
    expect(child.send.mock.calls[0]?.[0]).toMatchObject({
      kind: "supervisor-secret-bootstrap",
      version: SUPERVISOR_SECRET_BOOTSTRAP_PROTOCOL_VERSION,
      secretStorageKey: Buffer.alloc(32, 19).toString("base64"),
      allowPipedreamOauthPersistence: false,
    });
    await vi.waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
    expect(child.send).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "pipedream-privileged-bootstrap" }),
      expect.any(Function),
    );
    expect(
      child.send.mock.calls.findIndex(
        ([message]) => (message as { kind?: string }).kind === "pipedream-privileged-bootstrap",
      ),
    ).toBeGreaterThan(0);
  });

  it("strips every deprecated Pipedream exec input from the supervisor environment", () => {
    const previousClientId = process.env.PIPEDREAM_CLIENT_ID;
    const previousFile = process.env.PIPEDREAM_ENV_FILE;
    process.env.PIPEDREAM_CLIENT_ID = "must-not-reach-supervisor";
    process.env.PIPEDREAM_ENV_FILE = "/private/setup.env";
    try {
      makeClient();
      const forkOptions = forkMock.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv };
      expect(forkOptions.env).not.toHaveProperty("PIPEDREAM_CLIENT_ID");
      expect(forkOptions.env).not.toHaveProperty("PIPEDREAM_ENV_FILE");
    } finally {
      if (previousClientId === undefined) delete process.env.PIPEDREAM_CLIENT_ID;
      else process.env.PIPEDREAM_CLIENT_ID = previousClientId;
      if (previousFile === undefined) delete process.env.PIPEDREAM_ENV_FILE;
      else process.env.PIPEDREAM_ENV_FILE = previousFile;
    }
  });

  it("strips mixed-case inherited and extra master/Pipedream secrets before fork", () => {
    const inheritedSecretKey = "poracode_secret_storage_key";
    const inheritedPipedreamKey = "PiPeDrEaM_Client_Id";
    const inheritedBrowserKey = "poracode_browser_mcp_token";
    const previous = new Map(
      [inheritedSecretKey, inheritedPipedreamKey, inheritedBrowserKey].map((key) => [
        key,
        process.env[key],
      ]),
    );
    process.env[inheritedSecretKey] = "inherited-master-secret";
    process.env[inheritedPipedreamKey] = "inherited-pipedream-secret";
    process.env[inheritedBrowserKey] = "stale-browser-token";
    try {
      makeClient({
        resolveExtraEnv: () => ({
          pIpEdReAm_EnV_FiLe: "/private/setup.env",
          PORACODE_BROWSER_MCP_TOKEN: "current-browser-token",
        }),
      });
      const forkOptions = forkMock.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv };
      const entries = Object.entries(forkOptions.env ?? {});
      expect(
        entries.filter(([key]) =>
          ["PORACODE_SECRET_STORAGE_KEY", "PIPEDREAM_CLIENT_ID", "PIPEDREAM_ENV_FILE"].includes(
            key.toUpperCase(),
          ),
        ),
      ).toEqual([]);
      expect(forkOptions.env?.PORACODE_BROWSER_MCP_TOKEN).toBe("current-browser-token");
      expect(forkOptions.env).not.toHaveProperty(inheritedBrowserKey);
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("reloads Pipedream credentials over privileged IPC without adding them to provider env", async () => {
    const { client, child, onStarted } = makeClient();
    await vi.waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
    child.send.mockClear();
    let sentMessage: { id: string } | undefined;
    child.send.mockImplementation((message, callback) => {
      sentMessage = message as { id: string };
      callback?.();
      return true;
    });
    const payload = {
      bootstrap: {
        state: "ready" as const,
        source: "environment" as const,
        credentials: {
          clientId: "runtime-client-id",
          clientSecret: "runtime-client-secret",
          projectId: "proj_Runtime123",
          environment: "development" as const,
        },
      },
      externalUserId: "y-space:runtime-install",
    };

    const configuration = client.configurePipedream(payload);
    let settled = false;
    void configuration.finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(sentMessage).toBeDefined());
    await Promise.resolve();

    expect(settled).toBe(false);
    child.emit("message", {
      kind: "pipedream-privileged-reply",
      replyTo: sentMessage!.id,
      ok: true,
      data: {
        personalMcp: { enabled: false, authenticated: false, serverName: "pd" },
        connect: { state: "absent" },
        agentReload: { state: "restart-required" },
      },
    });
    await expect(configuration).resolves.toMatchObject({
      agentReload: { state: "restart-required" },
    });

    expect(child.send).toHaveBeenCalledExactlyOnceWith(
      { kind: "pipedream-privileged-bootstrap", id: expect.any(String), payload },
      expect.any(Function),
    );
    const forkOptions = forkMock.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv };
    expect(JSON.stringify(forkOptions.env)).not.toContain("runtime-client-secret");
  });

  it("rejects an invalid privileged Connect redirect capability before child IPC", async () => {
    vi.useFakeTimers();
    const { client, child, onStarted } = makeClient();
    await vi.advanceTimersByTimeAsync(0);
    expect(onStarted).toHaveBeenCalledOnce();
    child.send.mockClear();
    const outcome = client
      .createPipedreamConnectLink("gmail", {
        successRedirectUrl: "https://attacker.invalid/success/private",
        errorRedirectUrl: `http://127.0.0.1:43127/error/${"b".repeat(64)}`,
      })
      .catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(0);

    expect(child.send).not.toHaveBeenCalled();
    await expect(outcome).resolves.toEqual(
      expect.objectContaining({ message: expect.stringMatching(/invalid/i) }),
    );
  });

  it("does not release ordinary calls until the one-shot key acknowledgement arrives", async () => {
    const { client, child, onStarted } = makeClient({}, { autoAcknowledgeBootstrap: false });
    const outcome = client.call("any" as never, undefined as never);
    const guarded = outcome.catch((error: unknown) => error);
    await Promise.resolve();

    expect(child.send).toHaveBeenCalledOnce();
    const bootstrap = child.send.mock.calls[0]?.[0] as { id: string; kind: string };
    expect(bootstrap.kind).toBe("supervisor-secret-bootstrap");
    expect(onStarted).not.toHaveBeenCalled();

    child.emit("message", {
      kind: "supervisor-secret-bootstrap-reply",
      replyTo: bootstrap.id,
      ok: true,
      data: { version: SUPERVISOR_SECRET_BOOTSTRAP_PROTOCOL_VERSION, ready: true },
    });
    await vi.waitFor(() => expect(child.send).toHaveBeenCalledTimes(2));
    const request = child.send.mock.calls[1]?.[0] as { id: string };
    child.emit("message", { replyTo: request.id, ok: true, data: "ready-result" });

    await expect(guarded).resolves.toBe("ready-result");
    expect(onStarted).toHaveBeenCalledOnce();
  });

  it("rejects waiting calls when the child exits during the key handshake", async () => {
    vi.useFakeTimers();
    const { client, child } = makeClient({}, { autoAcknowledgeBootstrap: false });
    const outcome = client
      .call("any" as never, undefined as never)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);

    expect(child.send).toHaveBeenCalledOnce();
    child.connected = false;
    child.emit("exit", 1);

    await expect(outcome).resolves.toEqual(
      expect.objectContaining({ message: "Supervisor exited" }),
    );
    expect(child.send).toHaveBeenCalledOnce();
    client.dispose();
  });

  it("does not restart a weak-platform OAuth store failure before confirmed recovery", async () => {
    vi.useFakeTimers();
    let finishRecovery!: (outcome: "retry" | "stop") => void;
    const recoverStartupFailure = vi.fn<() => Promise<"retry" | "stop">>(
      () =>
        new Promise<"retry" | "stop">((resolve) => {
          finishRecovery = resolve;
        }),
    );
    const first = makeFakeChild({
      bootstrapFailureCode: SUPERVISOR_BOOTSTRAP_FAILURE_CODE.MCP_OAUTH_STORE_UNAVAILABLE,
    });
    const second = makeFakeChild();
    forkMock.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const client = new SupervisorClient({
      appVersion: "test",
      isDev: true,
      supervisorPath: "/fake/supervisor.cjs",
      wslHelpersDir: "/fake/wsl",
      secretStorageKey: Buffer.alloc(32, 19).toString("base64"),
      allowPipedreamOauthPersistence: false,
      recoverStartupFailure,
      onEvent: vi.fn<(event: SupervisorEvent) => void>(),
      onReset: vi.fn<() => void>(),
    });

    client.start("/base");
    await vi.advanceTimersByTimeAsync(5_000);

    expect(recoverStartupFailure).toHaveBeenCalledExactlyOnceWith(
      SUPERVISOR_BOOTSTRAP_FAILURE_CODE.MCP_OAUTH_STORE_UNAVAILABLE,
    );
    expect(forkMock).toHaveBeenCalledOnce();

    finishRecovery("retry");
    await vi.advanceTimersByTimeAsync(0);

    expect(forkMock).toHaveBeenCalledTimes(2);
    client.dispose();
  });

  it("stays fail-closed when OAuth store recovery is declined", async () => {
    vi.useFakeTimers();
    const first = makeFakeChild({
      bootstrapFailureCode: SUPERVISOR_BOOTSTRAP_FAILURE_CODE.MCP_OAUTH_STORE_UNAVAILABLE,
    });
    forkMock.mockReturnValue(first);
    const recoverStartupFailure = vi.fn<() => Promise<"stop">>(async () => "stop" as const);
    const client = new SupervisorClient({
      appVersion: "test",
      isDev: true,
      supervisorPath: "/fake/supervisor.cjs",
      wslHelpersDir: "/fake/wsl",
      secretStorageKey: Buffer.alloc(32, 19).toString("base64"),
      allowPipedreamOauthPersistence: false,
      recoverStartupFailure,
      onEvent: vi.fn<(event: SupervisorEvent) => void>(),
      onReset: vi.fn<() => void>(),
    });

    client.start("/base");
    await vi.advanceTimersByTimeAsync(10_000);
    client.start("/base");
    await vi.advanceTimersByTimeAsync(10_000);

    expect(recoverStartupFailure).toHaveBeenCalledOnce();
    expect(forkMock).toHaveBeenCalledOnce();
    client.dispose();
  });

  it("stays fail-closed when OAuth store recovery itself fails", async () => {
    vi.useFakeTimers();
    const first = makeFakeChild({
      bootstrapFailureCode: SUPERVISOR_BOOTSTRAP_FAILURE_CODE.MCP_OAUTH_STORE_UNAVAILABLE,
    });
    forkMock.mockReturnValue(first);
    const reportError = vi.fn<(error: unknown) => void>();
    const client = new SupervisorClient({
      appVersion: "test",
      isDev: true,
      supervisorPath: "/fake/supervisor.cjs",
      wslHelpersDir: "/fake/wsl",
      secretStorageKey: Buffer.alloc(32, 19).toString("base64"),
      allowPipedreamOauthPersistence: false,
      recoverStartupFailure: async () => {
        throw new Error("reset failed");
      },
      reportError,
      onEvent: vi.fn<(event: SupervisorEvent) => void>(),
      onReset: vi.fn<() => void>(),
    });

    client.start("/base");
    await vi.advanceTimersByTimeAsync(10_000);
    client.start("/base");

    expect(reportError).toHaveBeenCalledOnce();
    expect(forkMock).toHaveBeenCalledOnce();
    client.dispose();
  });

  it("keeps the ordinary restart policy for non-recoverable bootstrap failures", async () => {
    vi.useFakeTimers();
    const first = makeFakeChild({
      bootstrapFailureCode: SUPERVISOR_BOOTSTRAP_FAILURE_CODE.INITIALIZATION_FAILED,
    });
    const second = makeFakeChild();
    forkMock.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const client = new SupervisorClient({
      appVersion: "test",
      isDev: true,
      supervisorPath: "/fake/supervisor.cjs",
      wslHelpersDir: "/fake/wsl",
      secretStorageKey: Buffer.alloc(32, 19).toString("base64"),
      allowPipedreamOauthPersistence: false,
      recoverStartupFailure: vi.fn<() => Promise<"stop">>(),
      onEvent: vi.fn<(event: SupervisorEvent) => void>(),
      onReset: vi.fn<() => void>(),
    });

    client.start("/base");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(forkMock).toHaveBeenCalledTimes(2);
    client.dispose();
  });
});

import { ServerResponse, request as httpRequest } from "node:http";
import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PIPEDREAM_RELAY_MAX_CONCURRENT_REQUESTS_PER_BINDING,
  PIPEDREAM_RELAY_MAX_RESPONSE_BYTES,
  PipedreamLoopbackRelay,
} from "./PipedreamLoopbackRelay";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function requestBody(method: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} });
}

function upstreamResponseWithReader(reader: ReadableStreamDefaultReader<Uint8Array>): Response {
  return {
    body: { getReader: () => reader },
    headers: new Headers({ "content-type": "text/event-stream" }),
    ok: true,
    status: 200,
  } as unknown as Response;
}

function forceServerResponseBackpressure(onWrite: (response: ServerResponse) => void): () => void {
  const originalWrite = ServerResponse.prototype.write;
  ServerResponse.prototype.write = function (this: ServerResponse) {
    onWrite(this);
    return false;
  } as typeof originalWrite;
  return () => {
    ServerResponse.prototype.write = originalWrite;
  };
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([promise.then(() => true as const), timedOut]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

describe("PipedreamLoopbackRelay", () => {
  const relays: PipedreamLoopbackRelay[] = [];

  afterEach(async () => {
    await Promise.all(relays.splice(0).map((relay) => relay.dispose()));
  });

  function makeRelay(
    upstreamFetch: typeof fetch,
    getAccessToken: (signal?: AbortSignal) => Promise<string> = async () =>
      "developer-token-private",
  ) {
    const invalidateAccessToken = vi.fn<() => void>();
    const relay = new PipedreamLoopbackRelay({
      projectId: "proj_Test123",
      environment: "development",
      externalUserId: "y-space-install-private-id",
      getAccessToken,
      invalidateAccessToken,
      fetch: upstreamFetch,
    });
    relays.push(relay);
    return { relay, invalidateAccessToken };
  }

  it("requires a per-launch bearer and pins all upstream routing headers", async () => {
    const upstreamFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }), {
          headers: { "content-type": "application/json" },
        }),
    );
    const { relay } = makeRelay(upstreamFetch);
    const binding = await relay.registerBinding({
      threadId: "thread-a",
      providerBindingId: "provider-session-a",
      appSlug: "slack",
      accountId: "apn_Account123",
    });

    await expect(
      fetch(binding.url, { method: "POST", body: requestBody("tools/list") }),
    ).resolves.toMatchObject({ status: 401 });
    const response = await fetch(binding.url, {
      method: "POST",
      headers: {
        ...binding.headers,
        "content-type": "application/json",
        authorization: binding.headers.authorization,
        "x-pd-project-id": "proj_Attacker",
        "x-pd-account-id": "apn_Attacker",
        cookie: "attacker=true",
      },
      body: requestBody("tools/list"),
    });
    expect(response.status).toBe(200);

    const [input, init] = upstreamFetch.mock.calls[0]!;
    expect(String(input)).toBe("https://remote.mcp.pipedream.net/v3?app=slack");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer developer-token-private");
    expect(headers.get("x-pd-project-id")).toBe("proj_Test123");
    expect(headers.get("x-pd-external-user-id")).toBe("y-space-install-private-id");
    expect(headers.has("x-pd-app-slug")).toBe(false);
    expect(headers.get("x-pd-account-id")).toBe("apn_Account123");
    expect(headers.has("cookie")).toBe(false);
  });

  it("binds upstream MCP sessions to one current launch binding", async () => {
    const upstreamFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
          headers: { "content-type": "application/json", "mcp-session-id": "upstream-session" },
        }),
    );
    const { relay } = makeRelay(upstreamFetch);
    const a = await relay.registerBinding({
      threadId: "thread-a",
      providerBindingId: "provider-a",
      appSlug: "slack",
      accountId: "apn_Account123",
    });
    const b = await relay.registerBinding({
      threadId: "thread-b",
      providerBindingId: "provider-b",
      appSlug: "slack",
      accountId: "apn_Account123",
    });

    const initialized = await fetch(a.url, {
      method: "POST",
      headers: { ...a.headers, "content-type": "application/json" },
      body: requestBody("initialize"),
    });
    expect(initialized.headers.get("mcp-session-id")).toBe("upstream-session");
    const replay = await fetch(b.url, {
      method: "POST",
      headers: {
        ...b.headers,
        "content-type": "application/json",
        "mcp-session-id": "upstream-session",
      },
      body: requestBody("tools/list"),
    });
    expect(replay.status).toBe(403);
    expect(upstreamFetch).toHaveBeenCalledOnce();
  });

  it("cancels a pending listen so dispose cannot leave a late orphan server", async () => {
    const { relay } = makeRelay(
      vi.fn<typeof fetch>(async () => new Response(null, { status: 204 })),
    );
    const registration = relay.registerBinding({
      threadId: "thread-pending-listen",
      providerBindingId: "provider-pending-listen",
      appSlug: "slack",
      accountId: "apn_Account123",
    });
    const outcome = registration.then(
      () => "registered" as const,
      () => "cancelled" as const,
    );

    await relay.dispose();

    await expect(outcome).resolves.toBe("cancelled");
    await expect(
      relay.registerBinding({
        threadId: "thread-after-dispose",
        providerBindingId: "provider-after-dispose",
        appSlug: "slack",
        accountId: "apn_Account123",
      }),
    ).rejects.toThrow("Pipedream relay is disposed.");
  });

  it("destroys an authenticated client stalled mid-body so dispose closes promptly", async () => {
    const upstreamFetch = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const { relay } = makeRelay(upstreamFetch);
    const binding = await relay.registerBinding({
      threadId: "thread-stalled-body",
      providerBindingId: "provider-stalled-body",
      appSlug: "slack",
      accountId: "apn_Account123",
    });
    const body = requestBody("tools/call");
    const continued = deferred<void>();
    const clientClosed = deferred<void>();
    const clientRequest = httpRequest(
      binding.url,
      {
        method: "POST",
        headers: {
          ...binding.headers,
          "content-length": Buffer.byteLength(body),
          "content-type": "application/json",
          expect: "100-continue",
        },
      },
      (response) => response.resume(),
    );
    clientRequest.on("continue", () => continued.resolve());
    clientRequest.on("close", () => clientClosed.resolve());
    clientRequest.on("error", () => undefined);
    clientRequest.flushHeaders();
    await continued.promise;

    const disposal = relay.dispose();
    try {
      expect(await settlesWithin(disposal, 1_000)).toBe(true);
    } finally {
      clientRequest.destroy();
      await disposal;
    }

    await clientClosed.promise;
    expect(upstreamFetch).not.toHaveBeenCalled();
    await expect(
      fetch(binding.url).then(
        () => false,
        () => true,
      ),
    ).resolves.toBe(true);
  });

  it("does not send upstream after revocation while access-token acquisition is pending", async () => {
    const tokenRequested = deferred<void>();
    const accessToken = deferred<string>();
    const upstreamFetch = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const { relay } = makeRelay(upstreamFetch, () => {
      tokenRequested.resolve();
      return accessToken.promise;
    });
    const binding = await relay.registerBinding({
      threadId: "thread-a",
      providerBindingId: "provider-a",
      appSlug: "slack",
      accountId: "apn_Account123",
    });

    const responsePromise = fetch(binding.url, {
      method: "POST",
      headers: { ...binding.headers, "content-type": "application/json" },
      body: requestBody("tools/call"),
    });
    await tokenRequested.promise;
    relay.unregisterBinding(binding.bindingId);
    accessToken.resolve("developer-token-private");

    const response = await responsePromise;
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("revalidates the authenticated binding after a delayed request body finishes", async () => {
    const upstreamFetch = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const { relay } = makeRelay(upstreamFetch);
    const binding = await relay.registerBinding({
      threadId: "thread-a",
      providerBindingId: "provider-a",
      appSlug: "slack",
      accountId: "apn_Account123",
    });
    const body = requestBody("tools/call");

    const continued = deferred<void>();
    const responsePromise = new Promise<{ status: number; body: string }>((resolve, reject) => {
      const clientRequest = httpRequest(
        binding.url,
        {
          method: "POST",
          headers: {
            ...binding.headers,
            "content-length": Buffer.byteLength(body),
            "content-type": "application/json",
            expect: "100-continue",
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );
      clientRequest.on("continue", () => continued.resolve());
      clientRequest.on("error", reject);
      clientRequest.flushHeaders();
      void continued.promise.then(() => {
        relay.unregisterBinding(binding.bindingId);
        clientRequest.end(body);
      }, reject);
    });

    const response = await responsePromise;
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body)).toEqual({ error: "Not found" });
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("aborts an in-flight tools/call and never forwards its result after revocation", async () => {
    const upstreamStarted = deferred<RequestInit>();
    const upstreamResponse = deferred<Response>();
    const upstreamFetch = vi.fn<typeof fetch>(async (_input, init) => {
      upstreamStarted.resolve(init ?? {});
      return upstreamResponse.promise;
    });
    const { relay } = makeRelay(upstreamFetch);
    const binding = await relay.registerBinding({
      threadId: "thread-a",
      providerBindingId: "provider-a",
      appSlug: "slack",
      accountId: "apn_Account123",
    });

    const responsePromise = fetch(binding.url, {
      method: "POST",
      headers: { ...binding.headers, "content-type": "application/json" },
      body: requestBody("tools/call"),
    });
    const upstreamInit = await upstreamStarted.promise;
    relay.unregisterBinding(binding.bindingId);
    upstreamResponse.resolve(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { consequential: true } }), {
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await responsePromise;
    expect(upstreamInit.signal).toBeInstanceOf(AbortSignal);
    expect(upstreamInit.signal?.aborted).toBe(true);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
  });

  it("unbinds a terminated MCP session only after its DELETE succeeds", async () => {
    let deleteStatus = 500;
    const upstreamFetch = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.method === "DELETE") return new Response(null, { status: deleteStatus });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
        headers: { "content-type": "application/json", "mcp-session-id": "reusable-session" },
      });
    });
    const { relay } = makeRelay(upstreamFetch);
    const a = await relay.registerBinding({
      threadId: "thread-a",
      providerBindingId: "provider-a",
      appSlug: "slack",
      accountId: "apn_Account123",
    });
    const b = await relay.registerBinding({
      threadId: "thread-b",
      providerBindingId: "provider-b",
      appSlug: "slack",
      accountId: "apn_Account123",
    });

    const initialized = await fetch(a.url, {
      method: "POST",
      headers: { ...a.headers, "content-type": "application/json" },
      body: requestBody("initialize"),
    });
    expect(initialized.status).toBe(200);

    const failedDelete = await fetch(a.url, {
      method: "DELETE",
      headers: { ...a.headers, "mcp-session-id": "reusable-session" },
    });
    expect(failedDelete.status).toBe(500);
    expect(
      (
        await fetch(a.url, {
          method: "POST",
          headers: {
            ...a.headers,
            "content-type": "application/json",
            "mcp-session-id": "reusable-session",
          },
          body: requestBody("ping"),
        })
      ).status,
    ).toBe(200);

    deleteStatus = 204;
    const successfulDelete = await fetch(a.url, {
      method: "DELETE",
      headers: { ...a.headers, "mcp-session-id": "reusable-session" },
    });
    expect(successfulDelete.status).toBe(204);
    const terminatedReplay = await fetch(a.url, {
      method: "POST",
      headers: {
        ...a.headers,
        "content-type": "application/json",
        "mcp-session-id": "reusable-session",
      },
      body: requestBody("ping"),
    });
    expect(terminatedReplay.status).toBe(403);
    expect(
      (
        await fetch(b.url, {
          method: "POST",
          headers: { ...b.headers, "content-type": "application/json" },
          body: requestBody("initialize"),
        })
      ).status,
    ).toBe(200);
  });

  it("aborts and releases an abandoned request while access-token acquisition is pending", async () => {
    const tokenRequest = deferred<AbortSignal | undefined>();
    const accessToken = deferred<string>();
    const upstreamFetch = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const { relay } = makeRelay(upstreamFetch, (signal) => {
      tokenRequest.resolve(signal);
      return accessToken.promise;
    });
    const binding = await relay.registerBinding({
      threadId: "thread-token-abort",
      providerBindingId: "provider-token-abort",
      appSlug: "slack",
      accountId: "apn_Account123",
    });
    const clientRequest = httpRequest(binding.url, {
      method: "POST",
      headers: { ...binding.headers, "content-type": "application/json" },
    });
    clientRequest.on("error", () => undefined);
    clientRequest.end(requestBody("tools/call"));

    const signal = await tokenRequest.promise;
    expect(signal).toBeInstanceOf(AbortSignal);
    clientRequest.destroy();
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));

    accessToken.resolve("developer-token-private");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("aborts and releases an abandoned request while upstream fetch is pending", async () => {
    const upstreamRequest = deferred<RequestInit>();
    const upstreamResponse = deferred<Response>();
    const upstreamFetch = vi.fn<typeof fetch>(async (_input, init) => {
      upstreamRequest.resolve(init ?? {});
      return upstreamResponse.promise;
    });
    const { relay } = makeRelay(upstreamFetch);
    const binding = await relay.registerBinding({
      threadId: "thread-fetch-abort",
      providerBindingId: "provider-fetch-abort",
      appSlug: "slack",
      accountId: "apn_Account123",
    });
    const clientRequest = httpRequest(binding.url, {
      method: "POST",
      headers: { ...binding.headers, "content-type": "application/json" },
    });
    clientRequest.on("error", () => undefined);
    clientRequest.end(requestBody("tools/call"));

    const upstreamInit = await upstreamRequest.promise;
    clientRequest.destroy();
    await vi.waitFor(() => expect(upstreamInit.signal?.aborted).toBe(true));

    upstreamResponse.resolve(new Response(null, { status: 204 }));
  });

  it("cancels the exact upstream stream reader once when downstream close events race", async () => {
    const firstChunkReceived = deferred<void>();
    const upstreamCancelled = deferred<unknown>();
    const pendingPull = deferred<void>();
    let cancelCount = 0;
    const upstreamFetch = vi.fn<typeof fetch>(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("first"));
        },
        pull() {
          return pendingPull.promise;
        },
        cancel(reason) {
          cancelCount += 1;
          upstreamCancelled.resolve(reason);
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });
    const { relay } = makeRelay(upstreamFetch);
    const binding = await relay.registerBinding({
      threadId: "thread-stream-abort",
      providerBindingId: "provider-stream-abort",
      appSlug: "slack",
      accountId: "apn_Account123",
    });
    const clientRequest = httpRequest(
      binding.url,
      { method: "GET", headers: binding.headers },
      (clientResponse) => {
        clientResponse.once("data", () => {
          firstChunkReceived.resolve();
          clientRequest.destroy();
          clientResponse.destroy();
        });
      },
    );
    clientRequest.on("error", () => undefined);
    clientRequest.end();

    await firstChunkReceived.promise;
    await upstreamCancelled.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelCount).toBe(1);
    pendingPull.resolve();
  });

  it("removes downstream lifecycle listeners after a normal streamed response", async () => {
    let upstreamSignal: AbortSignal | null | undefined;
    let cancelCount = 0;
    const upstreamFetch = vi.fn<typeof fetch>(async (_input, init) => {
      upstreamSignal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("complete"));
          controller.close();
        },
        cancel() {
          cancelCount += 1;
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });
    const { relay } = makeRelay(upstreamFetch);
    const binding = await relay.registerBinding({
      threadId: "thread-stream-complete",
      providerBindingId: "provider-stream-complete",
      appSlug: "slack",
      accountId: "apn_Account123",
    });

    const response = await fetch(binding.url, { method: "GET", headers: binding.headers });
    await expect(response.text()).resolves.toBe("complete");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(upstreamSignal?.aborted).toBe(false);
    expect(cancelCount).toBe(0);
  });

  it("waits for drain before reading again from a slow connected downstream", async () => {
    const writeObserved = deferred<ServerResponse>();
    let readCount = 0;
    const reader = {
      cancel: vi.fn<(reason?: unknown) => Promise<void>>(async () => undefined),
      read: vi.fn<() => Promise<ReadableStreamReadResult<Uint8Array>>>(async () => {
        readCount += 1;
        if (readCount === 1) {
          return { done: false as const, value: new TextEncoder().encode("held") };
        }
        return { done: true as const, value: undefined };
      }),
      releaseLock: vi.fn<() => void>(),
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    let upstreamSignal: AbortSignal | undefined;
    const upstreamFetch = vi.fn<typeof fetch>(async (_input, init) => {
      upstreamSignal = init?.signal ?? undefined;
      return upstreamResponseWithReader(reader);
    });
    const restoreWrite = forceServerResponseBackpressure((response) => {
      writeObserved.resolve(response);
    });
    const { relay } = makeRelay(upstreamFetch);
    const binding = await relay.registerBinding({
      threadId: "thread-slow-downstream",
      providerBindingId: "provider-slow-downstream",
      appSlug: "slack",
      accountId: "apn_Account123",
    });

    try {
      const responsePromise = fetch(binding.url, { method: "GET", headers: binding.headers });
      const serverResponse = await writeObserved.promise;
      expect(reader.read).toHaveBeenCalledOnce();
      expect(serverResponse.listenerCount("drain")).toBe(1);
      expect(getEventListeners(upstreamSignal!, "abort").length).toBeGreaterThan(0);

      serverResponse.emit("drain");
      const response = await responsePromise;
      await expect(response.text()).resolves.toBe("");

      expect(reader.read).toHaveBeenCalledTimes(2);
      expect(serverResponse.listenerCount("drain")).toBe(0);
      expect(getEventListeners(upstreamSignal!, "abort")).toHaveLength(0);
      expect(reader.cancel).not.toHaveBeenCalled();
      expect(reader.releaseLock).toHaveBeenCalledOnce();
    } finally {
      restoreWrite();
    }
  });

  it("aborts a drain wait, cleans its listeners, and cancels the reader on downstream close", async () => {
    const writeObserved = deferred<ServerResponse>();
    const readerCancelled = deferred<void>();
    const pendingRead = deferred<ReadableStreamReadResult<Uint8Array>>();
    let readCount = 0;
    const reader = {
      cancel: vi.fn<(reason?: unknown) => Promise<void>>(async () => {
        readerCancelled.resolve();
      }),
      read: vi.fn<() => Promise<ReadableStreamReadResult<Uint8Array>>>(async () => {
        readCount += 1;
        if (readCount === 1) {
          return { done: false as const, value: new TextEncoder().encode("held") };
        }
        return pendingRead.promise;
      }),
      releaseLock: vi.fn<() => void>(),
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    let upstreamSignal: AbortSignal | undefined;
    const upstreamFetch = vi.fn<typeof fetch>(async (_input, init) => {
      upstreamSignal = init?.signal ?? undefined;
      return upstreamResponseWithReader(reader);
    });
    const restoreWrite = forceServerResponseBackpressure((response) => {
      writeObserved.resolve(response);
    });
    const { relay } = makeRelay(upstreamFetch);
    const binding = await relay.registerBinding({
      threadId: "thread-abort-drain",
      providerBindingId: "provider-abort-drain",
      appSlug: "slack",
      accountId: "apn_Account123",
    });
    const downstreamController = new AbortController();

    try {
      const requestOutcome = fetch(binding.url, {
        method: "GET",
        headers: binding.headers,
        signal: downstreamController.signal,
      }).then(
        () => "completed" as const,
        () => "aborted" as const,
      );
      const serverResponse = await writeObserved.promise;
      expect(reader.read).toHaveBeenCalledOnce();
      expect(serverResponse.listenerCount("drain")).toBe(1);

      downstreamController.abort();
      await expect(requestOutcome).resolves.toBe("aborted");
      await readerCancelled.promise;
      await vi.waitFor(() => expect(upstreamSignal?.aborted).toBe(true));

      expect(reader.read).toHaveBeenCalledOnce();
      expect(reader.cancel).toHaveBeenCalledOnce();
      expect(serverResponse.listenerCount("drain")).toBe(0);
      expect(getEventListeners(upstreamSignal!, "abort")).toHaveLength(0);
    } finally {
      restoreWrite();
    }
  });

  it("rejects an oversized first upstream chunk and releases all binding capacity", async () => {
    let readCount = 0;
    const reader = {
      cancel: vi.fn<(reason?: unknown) => Promise<void>>(async () => undefined),
      read: vi.fn<() => Promise<ReadableStreamReadResult<Uint8Array>>>(async () => {
        readCount += 1;
        if (readCount === 1) {
          return {
            done: false as const,
            value: new Uint8Array(PIPEDREAM_RELAY_MAX_RESPONSE_BYTES + 1),
          };
        }
        return { done: true as const, value: undefined };
      }),
      releaseLock: vi.fn<() => void>(),
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    const admittedResponses = Array.from(
      { length: PIPEDREAM_RELAY_MAX_CONCURRENT_REQUESTS_PER_BINDING },
      () => deferred<Response>(),
    );
    let upstreamIndex = 0;
    const upstreamFetch = vi.fn<typeof fetch>(async () => {
      if (upstreamIndex++ === 0) return upstreamResponseWithReader(reader);
      return admittedResponses[upstreamIndex - 2]!.promise;
    });
    const { relay } = makeRelay(upstreamFetch);
    const binding = await relay.registerBinding({
      threadId: "thread-response-cap",
      providerBindingId: "provider-response-cap",
      appSlug: "slack",
      accountId: "apn_Account123",
    });

    const oversized = await fetch(binding.url, { method: "GET", headers: binding.headers });
    expect(oversized.status).toBe(502);
    await expect(oversized.json()).resolves.toEqual({
      error: "Pipedream relay response is too large",
    });
    expect(reader.cancel).toHaveBeenCalledOnce();

    const admitted = Array.from(
      { length: PIPEDREAM_RELAY_MAX_CONCURRENT_REQUESTS_PER_BINDING },
      () => fetch(binding.url, { method: "GET", headers: binding.headers }),
    );
    await vi.waitFor(() =>
      expect(upstreamFetch).toHaveBeenCalledTimes(
        PIPEDREAM_RELAY_MAX_CONCURRENT_REQUESTS_PER_BINDING + 1,
      ),
    );
    for (const response of admittedResponses) response.resolve(new Response(null, { status: 204 }));
    const completed = await Promise.all(admitted);
    expect(completed.every((response) => response.status === 204)).toBe(true);
  });

  it("destroys a response that exceeds the cap after streaming headers", async () => {
    let readCount = 0;
    const reader = {
      cancel: vi.fn<(reason?: unknown) => Promise<void>>(async () => undefined),
      read: vi.fn<() => Promise<ReadableStreamReadResult<Uint8Array>>>(async () => {
        readCount += 1;
        if (readCount === 1) {
          return { done: false as const, value: new Uint8Array([1]) };
        }
        if (readCount === 2) {
          return {
            done: false as const,
            value: new Uint8Array(PIPEDREAM_RELAY_MAX_RESPONSE_BYTES),
          };
        }
        return { done: true as const, value: undefined };
      }),
      releaseLock: vi.fn<() => void>(),
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    const { relay } = makeRelay(
      vi.fn<typeof fetch>(async () => upstreamResponseWithReader(reader)),
    );
    const binding = await relay.registerBinding({
      threadId: "thread-response-cap-after-headers",
      providerBindingId: "provider-response-cap-after-headers",
      appSlug: "slack",
      accountId: "apn_Account123",
    });

    const outcome = fetch(binding.url, { method: "GET", headers: binding.headers })
      .then(async (response) => {
        await response.arrayBuffer();
        return "completed" as const;
      })
      .catch(() => "destroyed" as const);
    await expect(outcome).resolves.toBe("destroyed");
    expect(reader.cancel).toHaveBeenCalledOnce();
  });

  it("fails closed at a bounded per-binding concurrency limit and releases capacity", async () => {
    const upstreamResponses = Array.from(
      { length: PIPEDREAM_RELAY_MAX_CONCURRENT_REQUESTS_PER_BINDING + 1 },
      () => deferred<Response>(),
    );
    let upstreamIndex = 0;
    const upstreamFetch = vi.fn<typeof fetch>(
      async () => upstreamResponses[upstreamIndex++]!.promise,
    );
    const { relay } = makeRelay(upstreamFetch);
    const binding = await relay.registerBinding({
      threadId: "thread-concurrency",
      providerBindingId: "provider-concurrency",
      appSlug: "slack",
      accountId: "apn_Account123",
    });
    const send = () =>
      fetch(binding.url, {
        method: "POST",
        headers: { ...binding.headers, "content-type": "application/json" },
        body: requestBody("tools/call"),
      });
    const admitted = Array.from(
      { length: PIPEDREAM_RELAY_MAX_CONCURRENT_REQUESTS_PER_BINDING },
      send,
    );
    await vi.waitFor(() =>
      expect(upstreamFetch).toHaveBeenCalledTimes(
        PIPEDREAM_RELAY_MAX_CONCURRENT_REQUESTS_PER_BINDING,
      ),
    );

    const overflow = await send();
    expect(overflow.status).toBe(429);
    await expect(overflow.json()).resolves.toEqual({
      error: "Too many in-flight Pipedream relay requests",
    });
    expect(upstreamFetch).toHaveBeenCalledTimes(
      PIPEDREAM_RELAY_MAX_CONCURRENT_REQUESTS_PER_BINDING,
    );

    upstreamResponses[0]!.resolve(new Response(null, { status: 204 }));
    expect((await admitted[0]!).status).toBe(204);
    const replacement = send();
    await vi.waitFor(() =>
      expect(upstreamFetch).toHaveBeenCalledTimes(
        PIPEDREAM_RELAY_MAX_CONCURRENT_REQUESTS_PER_BINDING + 1,
      ),
    );

    for (let index = 1; index < upstreamResponses.length; index += 1) {
      upstreamResponses[index]!.resolve(new Response(null, { status: 204 }));
    }
    await expect(Promise.all([...admitted.slice(1), replacement])).resolves.toHaveLength(
      PIPEDREAM_RELAY_MAX_CONCURRENT_REQUESTS_PER_BINDING,
    );
  });

  it("releases per-binding capacity when an abandoned fetch ignores its abort signal", async () => {
    const upstreamResponses = Array.from(
      { length: PIPEDREAM_RELAY_MAX_CONCURRENT_REQUESTS_PER_BINDING + 1 },
      () => deferred<Response>(),
    );
    const upstreamSignals: Array<AbortSignal | null | undefined> = [];
    let upstreamIndex = 0;
    const upstreamFetch = vi.fn<typeof fetch>(async (_input, init) => {
      upstreamSignals.push(init?.signal);
      return upstreamResponses[upstreamIndex++]!.promise;
    });
    const { relay } = makeRelay(upstreamFetch);
    const binding = await relay.registerBinding({
      threadId: "thread-abandoned-concurrency",
      providerBindingId: "provider-abandoned-concurrency",
      appSlug: "slack",
      accountId: "apn_Account123",
    });
    const downstreamControllers = Array.from(
      { length: PIPEDREAM_RELAY_MAX_CONCURRENT_REQUESTS_PER_BINDING },
      () => new AbortController(),
    );
    const admitted = downstreamControllers.map((controller) =>
      fetch(binding.url, {
        method: "GET",
        headers: binding.headers,
        signal: controller.signal,
      }),
    );
    const abandonedOutcome = admitted[0]!.then(
      () => "completed" as const,
      () => "aborted" as const,
    );
    await vi.waitFor(() =>
      expect(upstreamFetch).toHaveBeenCalledTimes(
        PIPEDREAM_RELAY_MAX_CONCURRENT_REQUESTS_PER_BINDING,
      ),
    );

    downstreamControllers[0]!.abort();
    await expect(abandonedOutcome).resolves.toBe("aborted");
    await vi.waitFor(() => expect(upstreamSignals[0]?.aborted).toBe(true));

    const replacement = fetch(binding.url, { method: "GET", headers: binding.headers });
    await vi.waitFor(() =>
      expect(upstreamFetch).toHaveBeenCalledTimes(
        PIPEDREAM_RELAY_MAX_CONCURRENT_REQUESTS_PER_BINDING + 1,
      ),
    );

    for (const response of upstreamResponses) {
      response.resolve(new Response(null, { status: 204 }));
    }
    await expect(Promise.all([...admitted.slice(1), replacement])).resolves.toHaveLength(
      PIPEDREAM_RELAY_MAX_CONCURRENT_REQUESTS_PER_BINDING,
    );
  });

  it("applies concurrency independently to each binding", async () => {
    const upstreamResponses: Array<ReturnType<typeof deferred<Response>>> = [];
    const upstreamFetch = vi.fn<typeof fetch>(async () => {
      const response = deferred<Response>();
      upstreamResponses.push(response);
      return response.promise;
    });
    const { relay } = makeRelay(upstreamFetch);
    const first = await relay.registerBinding({
      threadId: "thread-concurrency-a",
      providerBindingId: "provider-concurrency-a",
      appSlug: "slack",
      accountId: "apn_Account123",
    });
    const second = await relay.registerBinding({
      threadId: "thread-concurrency-b",
      providerBindingId: "provider-concurrency-b",
      appSlug: "slack",
      accountId: "apn_Account123",
    });
    const firstRequests = Array.from(
      { length: PIPEDREAM_RELAY_MAX_CONCURRENT_REQUESTS_PER_BINDING },
      () => fetch(first.url, { method: "GET", headers: first.headers }),
    );
    await vi.waitFor(() =>
      expect(upstreamFetch).toHaveBeenCalledTimes(
        PIPEDREAM_RELAY_MAX_CONCURRENT_REQUESTS_PER_BINDING,
      ),
    );

    const secondRequest = fetch(second.url, { method: "GET", headers: second.headers });
    await vi.waitFor(() =>
      expect(upstreamFetch).toHaveBeenCalledTimes(
        PIPEDREAM_RELAY_MAX_CONCURRENT_REQUESTS_PER_BINDING + 1,
      ),
    );

    for (const response of upstreamResponses) {
      response.resolve(new Response(null, { status: 204 }));
    }
    await expect(Promise.all([...firstRequests, secondRequest])).resolves.toHaveLength(
      PIPEDREAM_RELAY_MAX_CONCURRENT_REQUESTS_PER_BINDING + 1,
    );
  });

  it("refreshes and retries reads once after 401 but never replays tools/call", async () => {
    const upstreamFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }), {
          headers: { "content-type": "application/json" },
        }),
      );
    const { relay, invalidateAccessToken } = makeRelay(upstreamFetch);
    const binding = await relay.registerBinding({
      threadId: "thread-a",
      providerBindingId: "provider-a",
      appSlug: "slack",
      accountId: "apn_Account123",
    });

    expect(
      (
        await fetch(binding.url, {
          method: "POST",
          headers: { ...binding.headers, "content-type": "application/json" },
          body: requestBody("tools/list"),
        })
      ).status,
    ).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledTimes(2);
    expect(invalidateAccessToken).toHaveBeenCalledOnce();

    upstreamFetch.mockReset();
    upstreamFetch.mockResolvedValue(new Response(null, { status: 401 }));
    invalidateAccessToken.mockClear();
    expect(
      (
        await fetch(binding.url, {
          method: "POST",
          headers: { ...binding.headers, "content-type": "application/json" },
          body: requestBody("tools/call"),
        })
      ).status,
    ).toBe(401);
    expect(upstreamFetch).toHaveBeenCalledOnce();
    expect(invalidateAccessToken).toHaveBeenCalledOnce();
  });
});

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isIP, type AddressInfo, type Socket } from "node:net";
import type { PipedreamEnvironment } from "@/shared/contracts/pipedream";
import {
  PIPEDREAM_MCP_V3_URL,
  PipedreamMcpSessionRegistry,
  buildPipedreamMcpUpstreamHeaders,
  shouldRetryAfterPipedreamUnauthorized,
} from "./PipedreamMcpRelay";

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const FORWARDED_RESPONSE_HEADERS = ["content-type", "mcp-session-id", "cache-control"] as const;

/**
 * Each launch binding gets a small, independent budget. The relay returns 429
 * immediately instead of queueing or retrying, so an overloaded tools/call is
 * never replayed by the relay after its caller has moved on.
 */
export const PIPEDREAM_RELAY_MAX_CONCURRENT_REQUESTS_PER_BINDING = 8;

/**
 * Agent transports cannot safely consume an unbounded tool result. Count the
 * decoded bytes actually relayed and terminate anything above 8 MiB.
 */
export const PIPEDREAM_RELAY_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

interface RelayBinding {
  readonly id: string;
  readonly token: string;
  readonly threadId: string;
  readonly providerBindingId: string;
  readonly appSlug: string;
  readonly accountId: string;
  readonly allowedHosts: ReadonlySet<string>;
}

interface InFlightRelayRequest {
  readonly controller: AbortController;
  detachDownstreamListeners: () => void;
  upstreamReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  upstreamComplete: boolean;
}

class RelayBindingRevokedError extends Error {
  constructor() {
    super("Pipedream relay binding is no longer active.");
    this.name = "RelayBindingRevokedError";
  }
}

class RelayDisposedError extends Error {
  constructor() {
    super("Pipedream relay is disposed.");
    this.name = "RelayDisposedError";
  }
}

class RelayDownstreamAbandonedError extends Error {
  constructor() {
    super("Pipedream relay downstream request was abandoned.");
    this.name = "RelayDownstreamAbandonedError";
  }
}

class RelayRequestReleasedError extends Error {
  constructor() {
    super("Pipedream relay request ended before upstream completion.");
    this.name = "RelayRequestReleasedError";
  }
}

class RelayResponseTooLargeError extends Error {
  constructor() {
    super("Pipedream relay response is too large.");
    this.name = "RelayResponseTooLargeError";
  }
}

export interface PipedreamLoopbackRelayOptions {
  readonly projectId: string;
  readonly environment: PipedreamEnvironment;
  readonly externalUserId: string;
  readonly getAccessToken: (signal?: AbortSignal) => Promise<string>;
  readonly invalidateAccessToken: () => void;
  readonly fetch?: typeof globalThis.fetch;
  /** Test/deployment override. Windows defaults to all interfaces for WSL. */
  readonly bindHost?: "127.0.0.1" | "0.0.0.0";
}

export interface RegisterPipedreamRelayBindingInput {
  readonly threadId: string;
  readonly providerBindingId: string;
  readonly appSlug: string;
  readonly accountId: string;
  /** Trusted WSL host-gateway IP advertised to an in-distro client. */
  readonly advertisedHost?: string;
}

export interface PipedreamRelayBindingInfo {
  readonly bindingId: string;
  readonly url: string;
  readonly headers: Readonly<Record<"authorization", string>>;
}

/** Authenticated loopback-only proxy from one live agent launch to fixed Pipedream MCP routing. */
export class PipedreamLoopbackRelay {
  readonly #options: PipedreamLoopbackRelayOptions;
  readonly #bindings = new Map<string, RelayBinding>();
  readonly #clientSockets = new Set<Socket>();
  readonly #inFlightRequestsByBinding = new Map<RelayBinding, Set<InFlightRelayRequest>>();
  readonly #sessions = new PipedreamMcpSessionRegistry();
  #server: Server | undefined;
  #origin: string | undefined;
  #starting: Promise<void> | undefined;
  #startReject: ((reason?: unknown) => void) | undefined;
  #disposed = false;
  #disposePromise: Promise<void> | undefined;

  constructor(options: PipedreamLoopbackRelayOptions) {
    this.#options = options;
  }

  async registerBinding(
    input: RegisterPipedreamRelayBindingInput,
  ): Promise<PipedreamRelayBindingInfo> {
    if (this.#disposed) throw new RelayDisposedError();
    await this.#start();
    if (this.#disposed || !this.#server?.listening || !this.#origin) {
      throw new RelayDisposedError();
    }
    const binding: RelayBinding = {
      id: randomUUID(),
      token: randomBytes(32).toString("base64url"),
      threadId: requireBounded(input.threadId, 256, "thread id"),
      providerBindingId: requireBounded(input.providerBindingId, 512, "provider binding id"),
      appSlug: requirePattern(input.appSlug, /^[a-z0-9][a-z0-9_-]*$/, "app slug"),
      accountId: requirePattern(input.accountId, /^apn_[a-zA-Z0-9]+$/, "account id"),
      allowedHosts: new Set([
        "127.0.0.1",
        ...(input.advertisedHost ? [requireAdvertisedHost(input.advertisedHost)] : []),
      ]),
    };
    this.#bindings.set(binding.id, binding);
    const advertisedHost = input.advertisedHost ?? "127.0.0.1";
    const origin = new URL(this.#origin!);
    origin.hostname = advertisedHost;
    return {
      bindingId: binding.id,
      url: `${origin.origin}/mcp/${binding.id}`,
      headers: { authorization: `Bearer ${binding.token}` },
    };
  }

  unregisterBinding(bindingId: string): void {
    const binding = this.#bindings.get(bindingId);
    this.#bindings.delete(bindingId);
    this.#sessions.clearBinding(bindingId);
    if (binding) this.#abortInFlightRequests(binding);
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposed = true;
    this.#bindings.clear();
    this.#sessions.clear();
    for (const binding of this.#inFlightRequestsByBinding.keys()) {
      this.#abortInFlightRequests(binding);
    }
    const server = this.#server;
    const starting = this.#starting;
    const rejectStart = this.#startReject;
    this.#server = undefined;
    this.#origin = undefined;
    this.#starting = undefined;
    this.#startReject = undefined;
    rejectStart?.(new RelayDisposedError());

    // Stop accepting first, then release every accepted descriptor so close()
    // cannot wait forever on an authenticated request with a partial body.
    const serverClosed = server ? closeHttpServer(server) : Promise.resolve();
    for (const socket of this.#clientSockets) socket.destroy();

    this.#disposePromise = Promise.all([
      serverClosed,
      starting?.catch(() => undefined) ?? Promise.resolve(),
    ]).then(() => {
      this.#clientSockets.clear();
    });
    return this.#disposePromise;
  }

  async #start(): Promise<void> {
    if (this.#disposed) throw new RelayDisposedError();
    if (this.#server?.listening) return;
    if (this.#starting) return this.#starting;
    const server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    server.on("connection", (socket) => this.#trackClientSocket(server, socket));
    // Keep a listener installed after startup so a late close/listen error can
    // never become an uncaught EventEmitter error during teardown.
    server.on("error", () => undefined);
    this.#server = server;

    let rejectStart!: (reason?: unknown) => void;
    const started = new Promise<void>((resolve, reject) => {
      rejectStart = reject;
      server.once("error", rejectStart);
      const bindHost =
        this.#options.bindHost ?? (process.platform === "win32" ? "0.0.0.0" : "127.0.0.1");
      try {
        server.listen(0, bindHost, () => {
          server.off("error", rejectStart);
          if (this.#disposed || this.#server !== server) {
            rejectStart(new RelayDisposedError());
            void closeHttpServer(server);
            return;
          }
          const address = server.address();
          if (!address || typeof address === "string") {
            rejectStart(new Error("Pipedream relay failed to bind."));
            void closeHttpServer(server);
            return;
          }
          this.#origin = `http://127.0.0.1:${(address as AddressInfo).port}`;
          resolve();
        });
      } catch (error) {
        server.off("error", rejectStart);
        reject(error);
      }
    });
    let starting!: Promise<void>;
    starting = started
      .catch(async (error: unknown) => {
        if (this.#server === server) {
          this.#server = undefined;
          this.#origin = undefined;
        }
        await closeHttpServer(server);
        throw error;
      })
      .finally(() => {
        if (this.#starting === starting) this.#starting = undefined;
        if (this.#startReject === rejectStart) this.#startReject = undefined;
      });
    this.#startReject = rejectStart;
    this.#starting = starting;
    return starting;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let binding: RelayBinding | undefined;
    let inFlightRequest: InFlightRelayRequest | undefined;
    try {
      const bindingId = new URL(request.url ?? "/", this.#origin).pathname.split("/")[2];
      binding = bindingId ? this.#bindings.get(bindingId) : undefined;
      if (!binding) {
        this.#reply(response, 404, "Not found");
        return;
      }
      if (!this.#isTrustedRequest(request, binding)) {
        this.#reply(response, 403, "Forbidden");
        return;
      }
      if (!this.#isAuthorized(request.headers.authorization, binding.token)) {
        this.#reply(response, 401, "Unauthorized");
        return;
      }
      if (request.method !== "POST" && request.method !== "GET" && request.method !== "DELETE") {
        response.setHeader("allow", "POST, GET, DELETE");
        this.#reply(response, 405, "Method not allowed");
        return;
      }

      const incomingSession = firstHeader(request.headers["mcp-session-id"]);
      if (
        incomingSession &&
        !this.#sessions.owns({ bindingId: binding.id, sessionId: incomingSession })
      ) {
        this.#reply(response, 403, "Forbidden");
        return;
      }

      inFlightRequest = this.#tryTrackUpstreamRequest(binding, request, response);
      if (!inFlightRequest) {
        this.#reply(response, 429, "Too many in-flight Pipedream relay requests");
        return;
      }
      const signal = inFlightRequest.controller.signal;
      this.#assertBindingCurrent(binding, signal);
      const body =
        request.method === "POST" ? await abortable(readBoundedBody(request), signal) : undefined;
      const jsonRpcMethod = body ? readJsonRpcMethod(body) : undefined;
      const upstream = await this.#sendUpstream(request, binding, body, jsonRpcMethod, signal);
      this.#assertBindingCurrent(binding, signal);
      const upstreamSession = upstream.headers.get("mcp-session-id");
      if (request.method === "DELETE" && incomingSession && upstream.ok) {
        this.#sessions.clearSession({ bindingId: binding.id, sessionId: incomingSession });
      } else if (upstreamSession) {
        this.#sessions.bind({ bindingId: binding.id, sessionId: upstreamSession });
      }
      response.statusCode = upstream.status;
      for (const header of FORWARDED_RESPONSE_HEADERS) {
        const value = upstream.headers.get(header);
        if (value !== null) response.setHeader(header, value);
      }
      if (!upstream.body) {
        this.#assertBindingCurrent(binding, signal);
        inFlightRequest.upstreamComplete = true;
        response.end();
        return;
      }
      const reader = upstream.body.getReader();
      this.#attachUpstreamReader(inFlightRequest, reader);
      let forwardedResponseBytes = 0;
      let readerReachedEnd = false;
      try {
        while (true) {
          const result = await abortable(reader.read(), signal);
          if (result.done) {
            readerReachedEnd = true;
            break;
          }
          this.#assertBindingCurrent(binding, signal);
          if (
            result.value.byteLength >
            PIPEDREAM_RELAY_MAX_RESPONSE_BYTES - forwardedResponseBytes
          ) {
            throw new RelayResponseTooLargeError();
          }
          forwardedResponseBytes += result.value.byteLength;
          if (!response.write(Buffer.from(result.value))) {
            await waitForServerResponseDrain(response, signal);
          }
        }
      } finally {
        if (readerReachedEnd) this.#releaseUpstreamReader(inFlightRequest, reader);
      }
      this.#assertBindingCurrent(binding, signal);
      inFlightRequest.upstreamComplete = true;
      response.end();
    } catch (error) {
      if (response.destroyed) return;
      if (error instanceof RelayDownstreamAbandonedError) {
        response.destroy();
        return;
      }
      if (error instanceof RelayResponseTooLargeError) {
        if (!response.headersSent) {
          this.#reply(response, 502, "Pipedream relay response is too large");
        } else {
          response.destroy();
        }
        return;
      }
      const bindingWasRevoked =
        error instanceof RelayBindingRevokedError ||
        inFlightRequest?.controller.signal.reason instanceof RelayBindingRevokedError ||
        (binding !== undefined && !this.#isBindingCurrent(binding));
      if (!response.headersSent) {
        this.#reply(
          response,
          bindingWasRevoked ? 404 : 502,
          bindingWasRevoked ? "Not found" : "Pipedream relay request failed",
        );
      } else response.destroy();
    } finally {
      if (binding && inFlightRequest) {
        this.#releaseUpstreamRequest(binding, inFlightRequest);
      }
    }
  }

  async #sendUpstream(
    request: IncomingMessage,
    binding: RelayBinding,
    body: Buffer | undefined,
    jsonRpcMethod: string | undefined,
    signal: AbortSignal,
  ): Promise<Response> {
    const send = async (): Promise<Response> => {
      this.#assertBindingCurrent(binding, signal);
      const accessToken = await abortable(this.#options.getAccessToken(signal), signal);
      this.#assertBindingCurrent(binding, signal);
      const headers = buildPipedreamMcpUpstreamHeaders({
        incoming: nodeHeaders(request),
        accessToken,
        projectId: this.#options.projectId,
        environment: this.#options.environment,
        externalUserId: this.#options.externalUserId,
        appSlug: binding.appSlug,
        accountId: binding.accountId,
      });
      return abortable(
        (this.#options.fetch ?? globalThis.fetch)(PIPEDREAM_MCP_V3_URL, {
          method: request.method ?? "POST",
          headers,
          signal,
          ...(body ? { body: body.toString("utf8") } : {}),
        }),
        signal,
      );
    };

    const first = await send();
    this.#assertBindingCurrent(binding, signal);
    if (first.status !== 401) return first;
    this.#options.invalidateAccessToken();
    if (!shouldRetryAfterPipedreamUnauthorized({ status: 401, jsonRpcMethod })) return first;
    if (first.body) {
      await abortable(first.body.cancel(), signal).catch((error: unknown) => {
        this.#assertBindingCurrent(binding, signal);
        void error;
      });
    }
    return send();
  }

  #tryTrackUpstreamRequest(
    binding: RelayBinding,
    request: IncomingMessage,
    response: ServerResponse,
  ): InFlightRelayRequest | undefined {
    this.#assertBindingCurrent(binding);
    const requests =
      this.#inFlightRequestsByBinding.get(binding) ?? new Set<InFlightRelayRequest>();
    if (requests.size >= PIPEDREAM_RELAY_MAX_CONCURRENT_REQUESTS_PER_BINDING) return undefined;
    const inFlightRequest: InFlightRelayRequest = {
      controller: new AbortController(),
      detachDownstreamListeners: () => undefined,
      upstreamReader: undefined,
      upstreamComplete: false,
    };
    requests.add(inFlightRequest);
    this.#inFlightRequestsByBinding.set(binding, requests);

    const abandon = () => {
      this.#abortUpstreamRequest(inFlightRequest, new RelayDownstreamAbandonedError());
    };
    const closeBeforeResponseEnds = () => {
      if (!response.writableEnded) abandon();
    };
    request.once("aborted", abandon);
    request.once("error", abandon);
    response.once("close", closeBeforeResponseEnds);
    response.once("error", abandon);
    inFlightRequest.detachDownstreamListeners = () => {
      request.off("aborted", abandon);
      request.off("error", abandon);
      response.off("close", closeBeforeResponseEnds);
      response.off("error", abandon);
    };

    // Re-check after listener installation to close the event-before-listener
    // race. A normally completed IncomingMessage may be destroyed by Node, so
    // only an incomplete destroyed request counts as abandonment here.
    if (
      request.aborted ||
      (request.destroyed && !request.complete) ||
      (response.destroyed && !response.writableEnded)
    ) {
      abandon();
    }
    return inFlightRequest;
  }

  #releaseUpstreamRequest(binding: RelayBinding, inFlightRequest: InFlightRelayRequest): void {
    inFlightRequest.detachDownstreamListeners();
    inFlightRequest.detachDownstreamListeners = () => undefined;
    if (!inFlightRequest.upstreamComplete && !inFlightRequest.controller.signal.aborted) {
      this.#abortUpstreamRequest(inFlightRequest, new RelayRequestReleasedError());
    } else {
      this.#cancelUpstreamReader(
        inFlightRequest,
        inFlightRequest.controller.signal.reason ?? new RelayRequestReleasedError(),
      );
    }
    const requests = this.#inFlightRequestsByBinding.get(binding);
    if (!requests) return;
    requests.delete(inFlightRequest);
    if (requests.size === 0) this.#inFlightRequestsByBinding.delete(binding);
  }

  #abortInFlightRequests(binding: RelayBinding): void {
    const requests = this.#inFlightRequestsByBinding.get(binding);
    if (!requests) return;
    this.#inFlightRequestsByBinding.delete(binding);
    for (const inFlightRequest of requests) {
      this.#abortUpstreamRequest(inFlightRequest, new RelayBindingRevokedError());
    }
  }

  #abortUpstreamRequest(inFlightRequest: InFlightRelayRequest, reason: Error): void {
    if (!inFlightRequest.controller.signal.aborted) {
      inFlightRequest.controller.abort(reason);
    }
    this.#cancelUpstreamReader(inFlightRequest, reason);
  }

  #attachUpstreamReader(
    inFlightRequest: InFlightRelayRequest,
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): void {
    inFlightRequest.upstreamReader = reader;
    if (inFlightRequest.controller.signal.aborted) {
      this.#cancelUpstreamReader(
        inFlightRequest,
        inFlightRequest.controller.signal.reason ?? new RelayRequestReleasedError(),
      );
    }
  }

  #releaseUpstreamReader(
    inFlightRequest: InFlightRelayRequest,
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): void {
    if (inFlightRequest.upstreamReader !== reader) return;
    inFlightRequest.upstreamReader = undefined;
    try {
      reader.releaseLock();
    } catch {
      // Abort cleanup may still be settling a pending read. Its cancellation
      // path owns the eventual lock release in that race.
    }
  }

  #cancelUpstreamReader(inFlightRequest: InFlightRelayRequest, reason: unknown): void {
    const reader = inFlightRequest.upstreamReader;
    if (!reader) return;
    inFlightRequest.upstreamReader = undefined;
    void reader
      .cancel(reason)
      .catch(() => undefined)
      .finally(() => {
        try {
          reader.releaseLock();
        } catch {
          // Best-effort cleanup for an already released or still-settling reader.
        }
      });
  }

  #trackClientSocket(server: Server, socket: Socket): void {
    this.#clientSockets.add(socket);
    socket.once("close", () => this.#clientSockets.delete(socket));
    socket.on("error", () => undefined);
    if (this.#disposed || this.#server !== server) socket.destroy();
  }

  #isBindingCurrent(binding: RelayBinding): boolean {
    return this.#bindings.get(binding.id) === binding;
  }

  #assertBindingCurrent(binding: RelayBinding, signal?: AbortSignal): void {
    if (signal?.aborted) throw abortReason(signal);
    if (!this.#isBindingCurrent(binding)) throw new RelayBindingRevokedError();
  }

  #isTrustedRequest(request: IncomingMessage, binding: RelayBinding): boolean {
    const host = firstHeader(request.headers.host);
    if (!host || !this.#origin) return false;
    try {
      const expected = new URL(this.#origin);
      const actual = new URL(`http://${host}`);
      if (!binding.allowedHosts.has(actual.hostname) || actual.port !== expected.port) return false;
      const origin = firstHeader(request.headers.origin);
      if (!origin) return true;
      const parsedOrigin = new URL(origin);
      return (
        (binding.allowedHosts.has(parsedOrigin.hostname) ||
          parsedOrigin.hostname === "localhost") &&
        parsedOrigin.port === expected.port
      );
    } catch {
      return false;
    }
  }

  #isAuthorized(header: string | string[] | undefined, expectedToken: string): boolean {
    const value = firstHeader(header);
    if (!value?.startsWith("Bearer ")) return false;
    const supplied = Buffer.from(value.slice(7));
    const expected = Buffer.from(expectedToken);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  #reply(response: ServerResponse, status: number, message: string): void {
    response.statusCode = status;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ error: message }));
  }
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

function waitForServerResponseDrain(response: ServerResponse, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onDrain = () => succeed();
    const onClose = () => fail(new RelayDownstreamAbandonedError());
    const onError = () => fail(new RelayDownstreamAbandonedError());
    const onAbort = () => fail(abortReason(signal));

    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });

    // Close the event-before-listener race without treating a healthy slow
    // response as failed merely because writableNeedDrain is still true.
    if (signal.aborted) onAbort();
    else if (response.destroyed || response.writableEnded) onClose();
  });
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
    // Abort can win between the initial check and listener registration.
    if (signal.aborted) onAbort();
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new RelayRequestReleasedError();
}

async function readBoundedBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_REQUEST_BYTES) throw new Error("Pipedream relay request is too large.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function readJsonRpcMethod(body: Buffer): string | undefined {
  try {
    const parsed = JSON.parse(body.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const method = (parsed as { method?: unknown }).method;
    return typeof method === "string" ? method : undefined;
  } catch {
    return undefined;
  }
}

function nodeHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function requirePattern(value: string, pattern: RegExp, label: string): string {
  const normalized = value.trim();
  if (!pattern.test(normalized)) throw new Error(`Invalid Pipedream ${label}.`);
  return normalized;
}

function requireBounded(value: string, max: number, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new Error(`Invalid Pipedream ${label}.`);
  return normalized;
}

function requireAdvertisedHost(value: string): string {
  const normalized = value.trim();
  if (isIP(normalized) !== 4) throw new Error("Invalid Pipedream relay host.");
  return normalized;
}

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP, type AddressInfo, type Socket } from "node:net";
import { isPipedreamPersonalMcpUrl } from "@/shared/contracts";
import { PipedreamMcpSessionRegistry } from "../pipedream/PipedreamMcpRelay";

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_CONCURRENT_REQUESTS_PER_BINDING = 8;
const MAX_BINDINGS = 4_096;
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "content-type",
  "mcp-protocol-version",
  "mcp-session-id",
  "last-event-id",
] as const;
const FORWARDED_RESPONSE_HEADERS = ["content-type", "mcp-session-id", "cache-control"] as const;

interface PersonalRelayBinding {
  readonly id: string;
  readonly token: string;
  readonly threadId: string;
  readonly providerBindingId: string;
  readonly credentialUrl: string;
  readonly upstreamUrl: string;
  readonly allowedHosts: ReadonlySet<string>;
}

interface InFlightRequest {
  readonly controller: AbortController;
  detachDownstreamListeners: () => void;
  upstreamReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  upstreamComplete: boolean;
}

class BindingRevokedError extends Error {
  constructor() {
    super("Personal Pipedream relay binding is no longer active.");
  }
}

class RelayDisposedError extends Error {
  constructor() {
    super("Personal Pipedream relay is disposed.");
  }
}

class DownstreamAbandonedError extends Error {
  constructor() {
    super("Personal Pipedream relay downstream was abandoned.");
  }
}

class RequestReleasedError extends Error {
  constructor() {
    super("Personal Pipedream relay request ended before upstream completion.");
  }
}

class ResponseTooLargeError extends Error {
  constructor() {
    super("Personal Pipedream relay response is too large.");
  }
}

export interface PersonalMcpLoopbackRelayOptions {
  readonly getAccessToken: (serverUrl: string, signal?: AbortSignal) => Promise<string | undefined>;
  readonly fetch?: typeof globalThis.fetch;
  /** Test/deployment override. Windows defaults to all interfaces for WSL. */
  readonly bindHost?: "127.0.0.1" | "0.0.0.0";
}

export interface RegisterPersonalMcpRelayBindingInput {
  readonly threadId: string;
  readonly providerBindingId: string;
  readonly credentialUrl: string;
  readonly upstreamUrl: string;
  /** Trusted WSL host-gateway IP advertised to an in-distro client. */
  readonly advertisedHost?: string;
}

export interface PersonalMcpRelayBindingInfo {
  readonly bindingId: string;
  readonly url: string;
  readonly headers: Readonly<Record<"authorization", string>>;
}

/**
 * Launch-scoped localhost capability for Personal Pipedream. The provider sees
 * only this opaque bearer; the upstream OAuth bearer is fetched inside the
 * supervisor for each request and is never serialized into provider state.
 */
export class PersonalMcpLoopbackRelay {
  readonly #options: PersonalMcpLoopbackRelayOptions;
  readonly #bindings = new Map<string, PersonalRelayBinding>();
  readonly #clientSockets = new Set<Socket>();
  readonly #inFlightByBinding = new Map<PersonalRelayBinding, Set<InFlightRequest>>();
  readonly #sessions = new PipedreamMcpSessionRegistry();
  #server: Server | undefined;
  #origin: string | undefined;
  #starting: Promise<void> | undefined;
  #rejectStart: ((reason?: unknown) => void) | undefined;
  #disposed = false;
  #disposePromise: Promise<void> | undefined;

  constructor(options: PersonalMcpLoopbackRelayOptions) {
    this.#options = options;
  }

  async registerBinding(
    input: RegisterPersonalMcpRelayBindingInput,
  ): Promise<PersonalMcpRelayBindingInfo> {
    if (this.#disposed) throw new RelayDisposedError();
    const upstreamUrl = requirePersonalUpstreamUrl(input.upstreamUrl);
    await this.#start();
    if (this.#disposed || !this.#server?.listening || !this.#origin) {
      throw new RelayDisposedError();
    }
    if (this.#bindings.size >= MAX_BINDINGS) {
      throw new Error("Personal Pipedream relay binding limit reached.");
    }
    const binding: PersonalRelayBinding = {
      id: randomUUID(),
      token: randomBytes(32).toString("base64url"),
      threadId: requireBounded(input.threadId, 256, "thread id"),
      providerBindingId: requireBounded(input.providerBindingId, 512, "provider binding id"),
      credentialUrl: requirePersonalCredentialUrl(input.credentialUrl),
      upstreamUrl,
      allowedHosts: new Set([
        "127.0.0.1",
        ...(input.advertisedHost ? [requireAdvertisedHost(input.advertisedHost)] : []),
      ]),
    };
    this.#bindings.set(binding.id, binding);
    const advertisedOrigin = new URL(this.#origin);
    advertisedOrigin.hostname = input.advertisedHost ?? "127.0.0.1";
    return {
      bindingId: binding.id,
      url: `${advertisedOrigin.origin}/mcp/${binding.id}`,
      headers: { authorization: `Bearer ${binding.token}` },
    };
  }

  unregisterBinding(bindingId: string): void {
    const binding = this.#bindings.get(bindingId);
    this.#bindings.delete(bindingId);
    this.#sessions.clearBinding(bindingId);
    if (binding) this.#abortInFlight(binding);
  }

  unregisterThread(threadId: string): void {
    for (const binding of [...this.#bindings.values()]) {
      if (binding.threadId === threadId) this.unregisterBinding(binding.id);
    }
  }

  revokeAllBindings(): void {
    for (const bindingId of [...this.#bindings.keys()]) this.unregisterBinding(bindingId);
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposed = true;
    this.revokeAllBindings();
    this.#sessions.clear();
    const server = this.#server;
    const starting = this.#starting;
    const rejectStart = this.#rejectStart;
    this.#server = undefined;
    this.#origin = undefined;
    this.#starting = undefined;
    this.#rejectStart = undefined;
    rejectStart?.(new RelayDisposedError());
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
    server.on("connection", (socket) => this.#trackSocket(server, socket));
    server.on("error", () => undefined);
    this.#server = server;

    let rejectStart!: (reason?: unknown) => void;
    const started = new Promise<void>((resolve, reject) => {
      rejectStart = reject;
      server.once("error", rejectStart);
      try {
        server.listen(
          0,
          this.#options.bindHost ?? (process.platform === "win32" ? "0.0.0.0" : "127.0.0.1"),
          () => {
            server.off("error", rejectStart);
            if (this.#disposed || this.#server !== server) {
              rejectStart(new RelayDisposedError());
              void closeHttpServer(server);
              return;
            }
            const address = server.address();
            if (!address || typeof address === "string") {
              rejectStart(new Error("Personal Pipedream relay failed to bind."));
              void closeHttpServer(server);
              return;
            }
            this.#origin = `http://127.0.0.1:${(address as AddressInfo).port}`;
            resolve();
          },
        );
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
        if (this.#rejectStart === rejectStart) this.#rejectStart = undefined;
      });
    this.#rejectStart = rejectStart;
    this.#starting = starting;
    return starting;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let binding: PersonalRelayBinding | undefined;
    let inFlight: InFlightRequest | undefined;
    try {
      const pathname = new URL(request.url ?? "/", this.#origin).pathname;
      const match = /^\/mcp\/([^/]+)$/u.exec(pathname);
      binding = match?.[1] ? this.#bindings.get(match[1]) : undefined;
      if (!binding) {
        this.#reply(response, 404, "Not found");
        return;
      }
      if (!this.#isTrustedRequest(request, binding)) {
        this.#reply(response, 403, "Forbidden");
        return;
      }
      if (!isAuthorized(request.headers.authorization, binding.token)) {
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

      inFlight = this.#tryTrack(binding, request, response);
      if (!inFlight) {
        this.#reply(response, 429, "Too many in-flight Personal Pipedream requests");
        return;
      }
      const signal = inFlight.controller.signal;
      const body =
        request.method === "POST" ? await abortable(readBoundedBody(request), signal) : undefined;
      this.#assertCurrent(binding, signal);
      const accessToken = await abortable(
        this.#options.getAccessToken(binding.credentialUrl, signal),
        signal,
      );
      this.#assertCurrent(binding, signal);
      if (!accessToken) throw new Error("Personal Pipedream is not authenticated.");
      const upstream = await abortable(
        (this.#options.fetch ?? globalThis.fetch)(binding.upstreamUrl, {
          method: request.method,
          headers: buildUpstreamHeaders(request, accessToken),
          redirect: "manual",
          signal,
          ...(body ? { body: body.toString("utf8") } : {}),
        }),
        signal,
      );
      this.#assertCurrent(binding, signal);
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
        inFlight.upstreamComplete = true;
        response.end();
        return;
      }
      const reader = upstream.body.getReader();
      inFlight.upstreamReader = reader;
      let forwardedBytes = 0;
      let reachedEnd = false;
      try {
        while (true) {
          const result = await abortable(reader.read(), signal);
          if (result.done) {
            reachedEnd = true;
            break;
          }
          this.#assertCurrent(binding, signal);
          if (result.value.byteLength > MAX_RESPONSE_BYTES - forwardedBytes) {
            throw new ResponseTooLargeError();
          }
          forwardedBytes += result.value.byteLength;
          if (!response.write(Buffer.from(result.value))) {
            await waitForDrain(response, signal);
          }
        }
      } finally {
        if (reachedEnd && inFlight.upstreamReader === reader) {
          inFlight.upstreamReader = undefined;
          reader.releaseLock();
        }
      }
      this.#assertCurrent(binding, signal);
      inFlight.upstreamComplete = true;
      response.end();
    } catch (error) {
      if (response.destroyed) return;
      if (error instanceof DownstreamAbandonedError) {
        response.destroy();
        return;
      }
      if (error instanceof ResponseTooLargeError) {
        if (response.headersSent) response.destroy();
        else this.#reply(response, 502, "Personal Pipedream relay response is too large");
        return;
      }
      const revoked =
        error instanceof BindingRevokedError ||
        inFlight?.controller.signal.reason instanceof BindingRevokedError ||
        (binding !== undefined && !this.#isCurrent(binding));
      if (response.headersSent) response.destroy();
      else this.#reply(response, revoked ? 404 : 502, revoked ? "Not found" : "Relay failed");
    } finally {
      if (binding && inFlight) this.#releaseRequest(binding, inFlight);
    }
  }

  #tryTrack(
    binding: PersonalRelayBinding,
    request: IncomingMessage,
    response: ServerResponse,
  ): InFlightRequest | undefined {
    this.#assertCurrent(binding);
    const requests = this.#inFlightByBinding.get(binding) ?? new Set<InFlightRequest>();
    if (requests.size >= MAX_CONCURRENT_REQUESTS_PER_BINDING) return undefined;
    const tracked: InFlightRequest = {
      controller: new AbortController(),
      detachDownstreamListeners: () => undefined,
      upstreamReader: undefined,
      upstreamComplete: false,
    };
    requests.add(tracked);
    this.#inFlightByBinding.set(binding, requests);
    const abandon = () => this.#abortRequest(tracked, new DownstreamAbandonedError());
    const closeEarly = () => {
      if (!response.writableEnded) abandon();
    };
    request.once("aborted", abandon);
    request.once("error", abandon);
    response.once("close", closeEarly);
    response.once("error", abandon);
    tracked.detachDownstreamListeners = () => {
      request.off("aborted", abandon);
      request.off("error", abandon);
      response.off("close", closeEarly);
      response.off("error", abandon);
    };
    if (
      request.aborted ||
      (request.destroyed && !request.complete) ||
      (response.destroyed && !response.writableEnded)
    ) {
      abandon();
    }
    return tracked;
  }

  #releaseRequest(binding: PersonalRelayBinding, request: InFlightRequest): void {
    request.detachDownstreamListeners();
    if (!request.upstreamComplete && !request.controller.signal.aborted) {
      this.#abortRequest(request, new RequestReleasedError());
    } else {
      this.#cancelReader(request, request.controller.signal.reason);
    }
    const requests = this.#inFlightByBinding.get(binding);
    requests?.delete(request);
    if (requests?.size === 0) this.#inFlightByBinding.delete(binding);
  }

  #abortInFlight(binding: PersonalRelayBinding): void {
    const requests = this.#inFlightByBinding.get(binding);
    if (!requests) return;
    this.#inFlightByBinding.delete(binding);
    for (const request of requests) this.#abortRequest(request, new BindingRevokedError());
  }

  #abortRequest(request: InFlightRequest, reason: Error): void {
    if (!request.controller.signal.aborted) request.controller.abort(reason);
    this.#cancelReader(request, reason);
  }

  #cancelReader(request: InFlightRequest, reason: unknown): void {
    const reader = request.upstreamReader;
    if (!reader) return;
    request.upstreamReader = undefined;
    void reader
      .cancel(reason)
      .catch(() => undefined)
      .finally(() => {
        try {
          reader.releaseLock();
        } catch {
          // Cancellation may still be settling; no authority survives either way.
        }
      });
  }

  #trackSocket(server: Server, socket: Socket): void {
    this.#clientSockets.add(socket);
    socket.once("close", () => this.#clientSockets.delete(socket));
    socket.on("error", () => undefined);
    if (this.#disposed || this.#server !== server) socket.destroy();
  }

  #isCurrent(binding: PersonalRelayBinding): boolean {
    return this.#bindings.get(binding.id) === binding;
  }

  #assertCurrent(binding: PersonalRelayBinding, signal?: AbortSignal): void {
    if (signal?.aborted) throw abortReason(signal);
    if (!this.#isCurrent(binding)) throw new BindingRevokedError();
  }

  #isTrustedRequest(request: IncomingMessage, binding: PersonalRelayBinding): boolean {
    const host = firstHeader(request.headers.host);
    if (!host || !this.#origin) return false;
    try {
      const expected = new URL(this.#origin);
      const actual = new URL(`http://${host}`);
      if (!binding.allowedHosts.has(actual.hostname) || actual.port !== expected.port) return false;
      const origin = firstHeader(request.headers.origin);
      if (!origin) return true;
      const parsed = new URL(origin);
      return (
        (binding.allowedHosts.has(parsed.hostname) || parsed.hostname === "localhost") &&
        parsed.port === expected.port
      );
    } catch {
      return false;
    }
  }

  #reply(response: ServerResponse, status: number, message: string): void {
    response.statusCode = status;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ error: message }));
  }
}

function buildUpstreamHeaders(request: IncomingMessage, accessToken: string): Headers {
  const incoming = nodeHeaders(request);
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = incoming.get(name);
    if (value !== null) headers.set(name, value);
  }
  const token = requireBounded(accessToken, 16_384, "access token");
  headers.set("authorization", `Bearer ${token}`);
  return headers;
}

function requirePersonalUpstreamUrl(value: string): string {
  if (!isPipedreamPersonalMcpUrl(value)) throw new Error("Invalid Personal Pipedream MCP URL.");
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.hash = "";
  return url.toString();
}

function requirePersonalCredentialUrl(value: string): string {
  if (!isPipedreamPersonalMcpUrl(value))
    throw new Error("Invalid Personal Pipedream credential URL.");
  return value;
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

function waitForDrain(response: ServerResponse, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      response.off("drain", succeed);
      response.off("close", fail);
      response.off("error", fail);
      signal.removeEventListener("abort", onAbort);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new DownstreamAbandonedError());
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortReason(signal));
    };
    response.once("drain", succeed);
    response.once("close", fail);
    response.once("error", fail);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    else if (response.destroyed || response.writableEnded) fail();
  });
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortReason(signal));
    };
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
    if (signal.aborted) onAbort();
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new RequestReleasedError();
}

async function readBoundedBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_REQUEST_BYTES) throw new Error("Personal Pipedream request is too large.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
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

function isAuthorized(value: string | string[] | undefined, expectedToken: string): boolean {
  const header = firstHeader(value);
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(expectedToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function requireBounded(value: string, maxLength: number, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`Invalid Personal Pipedream ${label}.`);
  }
  return normalized;
}

function requireAdvertisedHost(value: string): string {
  const normalized = value.trim();
  if (isIP(normalized) !== 4) throw new Error("Invalid Personal Pipedream relay host.");
  return normalized;
}

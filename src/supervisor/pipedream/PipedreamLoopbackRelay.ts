import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isIP, type AddressInfo } from "node:net";
import type { PipedreamEnvironment } from "@/shared/contracts/pipedream";
import {
  PIPEDREAM_MCP_V3_URL,
  PipedreamMcpSessionRegistry,
  buildPipedreamMcpUpstreamHeaders,
  shouldRetryAfterPipedreamUnauthorized,
} from "./PipedreamMcpRelay";

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const FORWARDED_RESPONSE_HEADERS = ["content-type", "mcp-session-id", "cache-control"] as const;

interface RelayBinding {
  readonly id: string;
  readonly token: string;
  readonly threadId: string;
  readonly providerBindingId: string;
  readonly appSlug: string;
  readonly accountId: string;
  readonly allowedHosts: ReadonlySet<string>;
}

export interface PipedreamLoopbackRelayOptions {
  readonly projectId: string;
  readonly environment: PipedreamEnvironment;
  readonly externalUserId: string;
  readonly getAccessToken: () => Promise<string>;
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
  readonly #sessions = new PipedreamMcpSessionRegistry();
  #server: Server | undefined;
  #origin: string | undefined;
  #starting: Promise<void> | undefined;

  constructor(options: PipedreamLoopbackRelayOptions) {
    this.#options = options;
  }

  async registerBinding(
    input: RegisterPipedreamRelayBindingInput,
  ): Promise<PipedreamRelayBindingInfo> {
    await this.#start();
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
    this.#bindings.delete(bindingId);
    this.#sessions.clearBinding(bindingId);
  }

  async dispose(): Promise<void> {
    this.#bindings.clear();
    this.#sessions.clear();
    const server = this.#server;
    this.#server = undefined;
    this.#origin = undefined;
    this.#starting = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async #start(): Promise<void> {
    if (this.#server?.listening) return;
    if (this.#starting) return this.#starting;
    this.#starting = new Promise<void>((resolve, reject) => {
      const server = createServer((request, response) => {
        void this.#handle(request, response);
      });
      server.once("error", reject);
      const bindHost =
        this.#options.bindHost ?? (process.platform === "win32" ? "0.0.0.0" : "127.0.0.1");
      server.listen(0, bindHost, () => {
        server.off("error", reject);
        const address = server.address() as AddressInfo;
        this.#server = server;
        this.#origin = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    }).finally(() => {
      this.#starting = undefined;
    });
    return this.#starting;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const bindingId = new URL(request.url ?? "/", this.#origin).pathname.split("/")[2];
      const binding = bindingId ? this.#bindings.get(bindingId) : undefined;
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

      const body = request.method === "POST" ? await readBoundedBody(request) : undefined;
      const jsonRpcMethod = body ? readJsonRpcMethod(body) : undefined;
      const upstream = await this.#sendUpstream(request, binding, body, jsonRpcMethod);
      const upstreamSession = upstream.headers.get("mcp-session-id");
      if (upstreamSession) {
        this.#sessions.bind({ bindingId: binding.id, sessionId: upstreamSession });
      }
      response.statusCode = upstream.status;
      for (const header of FORWARDED_RESPONSE_HEADERS) {
        const value = upstream.headers.get(header);
        if (value !== null) response.setHeader(header, value);
      }
      if (!upstream.body) {
        response.end();
        return;
      }
      try {
        for await (const chunk of upstream.body) response.write(Buffer.from(chunk));
        response.end();
      } catch {
        response.destroy();
      }
    } catch {
      if (!response.headersSent) this.#reply(response, 502, "Pipedream relay request failed");
      else response.destroy();
    }
  }

  async #sendUpstream(
    request: IncomingMessage,
    binding: RelayBinding,
    body: Buffer | undefined,
    jsonRpcMethod: string | undefined,
  ): Promise<Response> {
    const send = async (): Promise<Response> => {
      const accessToken = await this.#options.getAccessToken();
      const headers = buildPipedreamMcpUpstreamHeaders({
        incoming: nodeHeaders(request),
        accessToken,
        projectId: this.#options.projectId,
        environment: this.#options.environment,
        externalUserId: this.#options.externalUserId,
        appSlug: binding.appSlug,
        accountId: binding.accountId,
      });
      return (this.#options.fetch ?? globalThis.fetch)(PIPEDREAM_MCP_V3_URL, {
        method: request.method ?? "POST",
        headers,
        ...(body ? { body: body.toString("utf8") } : {}),
      });
    };

    const first = await send();
    if (first.status !== 401) return first;
    this.#options.invalidateAccessToken();
    if (!shouldRetryAfterPipedreamUnauthorized({ status: 401, jsonRpcMethod })) return first;
    await first.body?.cancel().catch(() => undefined);
    return send();
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

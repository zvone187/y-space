import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport as ClientStdioTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServer } from "@/shared/contracts";
import { createMcpToolFilterProxy } from "./mcpToolFilterProxy";

const CONFIG_ENV_PREFIX = "PORACODE_MCP_FILTER_CONFIG_";

function configEnvName(): string {
  const name = process.argv[2];
  if (!name?.startsWith(CONFIG_ENV_PREFIX)) throw new Error("Missing MCP filter config identity");
  return name;
}

function readConfig(): { server: McpServer; disabledTools: string[]; browserExclusive: boolean } {
  const encoded = process.env[configEnvName()];
  if (!encoded) throw new Error("Missing MCP filter configuration");
  const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
    server: McpServer;
    disabledTools: string[];
    browserExclusive?: boolean;
  };
  return { ...decoded, browserExclusive: decoded.browserExclusive === true };
}

function createUpstreamTransport(server: McpServer) {
  const transport = server.transport;
  if (transport.type === "stdio") {
    return new ClientStdioTransport({
      command: transport.command,
      args: transport.args,
      env: transport.env,
      ...(transport.cwd ? { cwd: transport.cwd } : {}),
      stderr: "inherit",
    });
  }
  if (transport.type === "http") {
    return new StreamableHTTPClientTransport(new URL(transport.url), {
      requestInit: { headers: transport.headers },
    });
  }
  return new SSEClientTransport(new URL(transport.url), {
    requestInit: { headers: transport.headers },
  });
}

async function main(): Promise<void> {
  const config = readConfig();
  const client = new Client({ name: "poracode-mcp-filter", version: "1.0.0" });
  await client.connect(createUpstreamTransport(config.server) as Transport);

  const server = createMcpToolFilterProxy({
    client,
    serverName: config.server.name,
    disabledTools: config.disabledTools,
    browserExclusive: config.browserExclusive,
  });

  const close = async () => {
    await Promise.allSettled([server.close(), client.close()]);
  };
  process.once("SIGINT", () => void close().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
  await server.connect(new StdioServerTransport());
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

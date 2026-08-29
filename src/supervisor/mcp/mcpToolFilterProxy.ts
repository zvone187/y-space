import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  PromptListChangedNotificationSchema,
  ReadResourceRequestSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  SubscribeRequestSchema,
  ToolListChangedNotificationSchema,
  UnsubscribeRequestSchema,
  type ServerCapabilities,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { isCompetingBrowserToolDescriptor } from "@/shared/browserExclusivePolicy";

export interface McpToolFilterProxyOptions {
  client: Client;
  serverName: string;
  disabledTools: readonly string[];
  browserExclusive: boolean;
}

function forwardedCapabilities(upstream: ServerCapabilities | undefined): ServerCapabilities {
  if (!upstream) return {};
  return {
    ...(upstream.tools ? { tools: upstream.tools } : {}),
    ...(upstream.resources ? { resources: upstream.resources } : {}),
    ...(upstream.prompts ? { prompts: upstream.prompts } : {}),
    ...(upstream.completions ? { completions: upstream.completions } : {}),
  };
}

function unavailableToolResult(name: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: `Tool unavailable in this Y Space session: ${name}` }],
  };
}

export function createMcpToolFilterProxy(options: McpToolFilterProxyOptions): Server {
  const { client, serverName, disabledTools, browserExclusive } = options;
  const upstreamCapabilities = client.getServerCapabilities();
  const upstreamVersion = client.getServerVersion();
  const instructions = client.getInstructions();
  const disabled = new Set(disabledTools);
  const server = new Server(
    { name: serverName, version: upstreamVersion?.version ?? "1.0.0" },
    {
      capabilities: forwardedCapabilities(upstreamCapabilities),
      ...(instructions ? { instructions } : {}),
    },
  );

  if (upstreamCapabilities?.tools) {
    let catalogPromise: Promise<Tool[]> | undefined;
    let catalogGeneration = 0;
    let advertisedTools = new Map<string, Tool>();
    const isDenied = (name: string, description?: string) =>
      disabled.has(name) ||
      (browserExclusive && isCompetingBrowserToolDescriptor(name, description));
    const loadCatalog = async (): Promise<Tool[]> => {
      const tools: Tool[] = [];
      let cursor: string | undefined;
      do {
        const result = await client.listTools(cursor ? { cursor } : undefined);
        tools.push(...result.tools);
        cursor = result.nextCursor;
      } while (cursor);
      return tools;
    };
    const catalog = () => (catalogPromise ??= loadCatalog());

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      for (;;) {
        const generation = catalogGeneration;
        const tools = (await catalog()).filter((tool) => !isDenied(tool.name, tool.description));
        if (generation !== catalogGeneration) continue;
        advertisedTools = new Map(tools.map((tool) => [tool.name, tool]));
        return { tools };
      }
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      const advertised = advertisedTools.get(name);
      if (!advertised || isDenied(name, advertised.description)) return unavailableToolResult(name);
      return await client.callTool(request.params);
    });

    if (upstreamCapabilities.tools.listChanged) {
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        catalogGeneration += 1;
        catalogPromise = undefined;
        advertisedTools.clear();
        await server.sendToolListChanged();
      });
    }
  }

  if (upstreamCapabilities?.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
      return await client.listResources(request.params);
    });
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
      return await client.listResourceTemplates(request.params);
    });
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      return await client.readResource(request.params);
    });

    if (upstreamCapabilities.resources.subscribe) {
      server.setRequestHandler(SubscribeRequestSchema, async (request) => {
        return await client.subscribeResource(request.params);
      });
      server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
        return await client.unsubscribeResource(request.params);
      });
      client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (notification) => {
        await server.sendResourceUpdated(notification.params);
      });
    }

    if (upstreamCapabilities.resources.listChanged) {
      client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
        await server.sendResourceListChanged();
      });
    }
  }

  if (upstreamCapabilities?.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
      return await client.listPrompts(request.params);
    });
    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      return await client.getPrompt(request.params);
    });

    if (upstreamCapabilities.prompts.listChanged) {
      client.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
        await server.sendPromptListChanged();
      });
    }
  }

  if (upstreamCapabilities?.completions) {
    server.setRequestHandler(CompleteRequestSchema, async (request) => {
      return await client.complete(request.params);
    });
  }

  return server;
}

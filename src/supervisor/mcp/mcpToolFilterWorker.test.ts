import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpToolFilterProxy } from "./mcpToolFilterProxy";

interface Harness {
  downstream: Client;
  upstream: Server;
  upstreamToolCalls: string[];
  upstreamResourceRequests: string[];
  close: () => Promise<void>;
}

const harnesses: Harness[] = [];

interface HarnessOptions {
  listTools?: () => Promise<{ tools: Tool[] }>;
}

afterEach(async () => {
  await Promise.allSettled(harnesses.splice(0).map((harness) => harness.close()));
});

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const upstreamToolCalls: string[] = [];
  const upstreamResourceRequests: string[] = [];
  const upstream = new Server(
    { name: "upstream-test", version: "1.2.3" },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true, subscribe: true },
        prompts: { listChanged: true },
        completions: {},
      },
      instructions: "Upstream instructions",
    },
  );

  upstream.setRequestHandler(ListToolsRequestSchema, async () => {
    if (options.listTools) return await options.listTools();
    return {
      tools: [
        {
          name: "safe_tool",
          description: "A safe utility",
          inputSchema: { type: "object" },
        },
        {
          name: "hidden_tool",
          description: "A disabled utility",
          inputSchema: { type: "object" },
        },
      ],
    };
  });
  upstream.setRequestHandler(CallToolRequestSchema, async (request) => {
    upstreamToolCalls.push(request.params.name);
    return { content: [{ type: "text", text: `called:${request.params.name}` }] };
  });
  upstream.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: "test://resource", name: "Test resource", mimeType: "text/plain" }],
  }));
  upstream.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [{ uriTemplate: "test://{id}", name: "Test template" }],
  }));
  upstream.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    upstreamResourceRequests.push(`read:${request.params.uri}`);
    return { contents: [{ uri: request.params.uri, text: "resource body" }] };
  });
  upstream.setRequestHandler(SubscribeRequestSchema, async (request) => {
    upstreamResourceRequests.push(`subscribe:${request.params.uri}`);
    return {};
  });
  upstream.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    upstreamResourceRequests.push(`unsubscribe:${request.params.uri}`);
    return {};
  });
  upstream.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [{ name: "summarize", description: "Summarize a resource" }],
  }));
  upstream.setRequestHandler(GetPromptRequestSchema, async (request) => ({
    description: "Prompt from upstream",
    messages: [{ role: "user", content: { type: "text", text: `prompt:${request.params.name}` } }],
  }));
  upstream.setRequestHandler(CompleteRequestSchema, async (request) => ({
    completion: { values: [`${request.params.argument.value}-completed`] },
  }));

  const [upstreamClientTransport, upstreamServerTransport] = InMemoryTransport.createLinkedPair();
  await upstream.connect(upstreamServerTransport);
  const upstreamClient = new Client({ name: "filter-upstream-client", version: "1.0.0" });
  await upstreamClient.connect(upstreamClientTransport);

  const proxy = createMcpToolFilterProxy({
    client: upstreamClient,
    serverName: "filtered-test",
    disabledTools: ["hidden_tool"],
    browserExclusive: false,
  });
  const [downstreamClientTransport, proxyServerTransport] = InMemoryTransport.createLinkedPair();
  await proxy.connect(proxyServerTransport);
  const downstream = new Client({ name: "filter-downstream-client", version: "1.0.0" });
  await downstream.connect(downstreamClientTransport);

  const harness: Harness = {
    downstream,
    upstream,
    upstreamToolCalls,
    upstreamResourceRequests,
    close: async () => {
      await Promise.allSettled([
        downstream.close(),
        proxy.close(),
        upstreamClient.close(),
        upstream.close(),
      ]);
    },
  };
  harnesses.push(harness);
  return harness;
}

describe("MCP tool filter worker proxy", () => {
  it("rejects every tool absent from the last advertised catalog before calling upstream", async () => {
    const harness = await createHarness();

    const beforeList = await harness.downstream.callTool({ name: "safe_tool", arguments: {} });
    expect(beforeList).toMatchObject({ isError: true });
    expect(harness.upstreamToolCalls).toEqual([]);

    const catalog = await harness.downstream.listTools();
    expect(catalog.tools.map((tool) => tool.name)).toEqual(["safe_tool"]);

    const hidden = await harness.downstream.callTool({ name: "hidden_tool", arguments: {} });
    const unknown = await harness.downstream.callTool({ name: "unknown_tool", arguments: {} });
    expect(hidden).toMatchObject({ isError: true });
    expect(unknown).toMatchObject({ isError: true });
    expect(harness.upstreamToolCalls).toEqual([]);

    const safe = await harness.downstream.callTool({ name: "safe_tool", arguments: {} });
    expect(safe).toMatchObject({ content: [{ type: "text", text: "called:safe_tool" }] });
    expect(harness.upstreamToolCalls).toEqual(["safe_tool"]);

    await harness.upstream.sendToolListChanged();
    const stale = await harness.downstream.callTool({ name: "safe_tool", arguments: {} });
    expect(stale).toMatchObject({ isError: true });
    expect(harness.upstreamToolCalls).toEqual(["safe_tool"]);
  });

  it("does not publish a stale catalog when tools change during an in-flight list", async () => {
    let resolveStarted: (() => void) | undefined;
    let resolveFirstList: (() => void) | undefined;
    const firstListStarted = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const releaseFirstList = new Promise<void>((resolve) => {
      resolveFirstList = resolve;
    });
    let listCount = 0;
    const harness = await createHarness({
      listTools: async () => {
        listCount += 1;
        if (listCount === 1) {
          resolveStarted?.();
          await releaseFirstList;
          return {
            tools: [{ name: "stale_tool", inputSchema: { type: "object" } }],
          };
        }
        return {
          tools: [{ name: "fresh_tool", inputSchema: { type: "object" } }],
        };
      },
    });

    const listPromise = harness.downstream.listTools();
    await firstListStarted;
    await harness.upstream.sendToolListChanged();
    resolveFirstList?.();

    await expect(listPromise).resolves.toMatchObject({ tools: [{ name: "fresh_tool" }] });
    const stale = await harness.downstream.callTool({ name: "stale_tool", arguments: {} });
    expect(stale).toMatchObject({ isError: true });
    expect(harness.upstreamToolCalls).toEqual([]);

    await harness.downstream.callTool({ name: "fresh_tool", arguments: {} });
    expect(harness.upstreamToolCalls).toEqual(["fresh_tool"]);
    expect(listCount).toBe(2);
  });

  it("preserves resource and prompt capabilities and forwards their methods and notifications", async () => {
    const harness = await createHarness();
    expect(harness.downstream.getServerCapabilities()).toMatchObject({
      tools: { listChanged: true },
      resources: { listChanged: true, subscribe: true },
      prompts: { listChanged: true },
      completions: {},
    });
    expect(harness.downstream.getInstructions()).toBe("Upstream instructions");

    await expect(harness.downstream.listResources()).resolves.toMatchObject({
      resources: [{ uri: "test://resource", name: "Test resource" }],
    });
    await expect(harness.downstream.listResourceTemplates()).resolves.toMatchObject({
      resourceTemplates: [{ uriTemplate: "test://{id}", name: "Test template" }],
    });
    await expect(
      harness.downstream.readResource({ uri: "test://resource" }),
    ).resolves.toMatchObject({ contents: [{ uri: "test://resource", text: "resource body" }] });
    await harness.downstream.subscribeResource({ uri: "test://resource" });
    await harness.downstream.unsubscribeResource({ uri: "test://resource" });
    expect(harness.upstreamResourceRequests).toEqual([
      "read:test://resource",
      "subscribe:test://resource",
      "unsubscribe:test://resource",
    ]);

    await expect(harness.downstream.listPrompts()).resolves.toMatchObject({
      prompts: [{ name: "summarize" }],
    });
    await expect(harness.downstream.getPrompt({ name: "summarize" })).resolves.toMatchObject({
      messages: [{ role: "user", content: { type: "text", text: "prompt:summarize" } }],
    });
    await expect(
      harness.downstream.complete({
        ref: { type: "ref/prompt", name: "summarize" },
        argument: { name: "topic", value: "resource" },
      }),
    ).resolves.toEqual({ completion: { values: ["resource-completed"] } });

    const notifications: string[] = [];
    harness.downstream.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
      notifications.push(`updated:${notification.params.uri}`);
    });
    harness.downstream.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
      notifications.push("resources-changed");
    });
    harness.downstream.setNotificationHandler(PromptListChangedNotificationSchema, () => {
      notifications.push("prompts-changed");
    });
    harness.downstream.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      notifications.push("tools-changed");
    });

    await harness.upstream.sendResourceUpdated({ uri: "test://resource" });
    await harness.upstream.sendResourceListChanged();
    await harness.upstream.sendPromptListChanged();
    await harness.upstream.sendToolListChanged();
    expect(notifications).toEqual([
      "updated:test://resource",
      "resources-changed",
      "prompts-changed",
      "tools-changed",
    ]);
  });
});

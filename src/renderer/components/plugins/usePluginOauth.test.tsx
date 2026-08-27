import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadedPlugin } from "@/shared/contracts";
import type { PoracodeBridge } from "@/shared/ipc";
import { AGENT_PLUGINS_MANIFEST_SCHEMA_URL } from "@/shared/plugins/spec";
import { renderWithI18n as render } from "@/renderer/testUtils/i18n";
import { usePluginOauth } from "./usePluginOauth";

const bridge = vi.hoisted(() => ({
  getMcpOauthStatus: vi.fn<PoracodeBridge["getMcpOauthStatus"]>(async () => ({
    authenticatedUrls: [],
  })),
  beginMcpServerOauth: vi.fn<PoracodeBridge["beginMcpServerOauth"]>(async () => ({
    status: "redirect" as const,
    flowId: "plugin-oauth-flow",
    authorizationUrl: "https://oauth.example.test/authorize?state=private",
  })),
  browserCreateSensitiveTab: vi.fn<PoracodeBridge["browserCreateSensitiveTab"]>(async () => ({
    tabId: "plugin-oauth-tab",
    url: "about:blank",
    title: "Connecting…",
    loading: true,
    canGoBack: false,
    canGoForward: false,
  })),
  browserCloseTab: vi.fn<PoracodeBridge["browserCloseTab"]>(async () => undefined),
  waitMcpServerOauth: vi.fn<PoracodeBridge["waitMcpServerOauth"]>(async () => ({
    status: "authorized",
  })),
  clearMcpServerOauth: vi.fn<PoracodeBridge["clearMcpServerOauth"]>(async () => undefined),
  openExternalNative: vi.fn<PoracodeBridge["openExternalNative"]>(async () => undefined),
}));

vi.mock("@/renderer/bridge", () => ({ readBridge: () => bridge }));

const plugin: LoadedPlugin = {
  name: "calendar-tools",
  source: "bundled",
  root: "/plugins/calendar-tools",
  manifest: {
    $schema: AGENT_PLUGINS_MANIFEST_SCHEMA_URL,
    name: "calendar-tools",
    version: "1.0.0",
  },
  poracode: {
    category: "productivity",
    featured: false,
    communityMaintained: false,
    nativePluginNames: [],
    builtInMcpServerIds: [],
    skills: {},
  },
  skills: [],
  mcpServers: [
    {
      name: "calendar",
      entry: {
        type: "streamable-http",
        url: "https://calendar.example.test/mcp",
        headers: {},
      },
    },
  ],
  diagnostics: [],
};

function Harness() {
  const oauth = usePluginOauth(plugin);
  return (
    <button type="button" onClick={() => void oauth.connect("calendar")}>
      Connect
    </button>
  );
}

describe("usePluginOauth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bridge.getMcpOauthStatus.mockResolvedValue({ authenticatedUrls: [] });
    bridge.waitMcpServerOauth.mockResolvedValue({ status: "authorized" });
  });

  it("uses a sensitive embedded tab and closes it after plugin OAuth succeeds", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() =>
      expect(bridge.browserCreateSensitiveTab).toHaveBeenCalledWith({
        url: "https://oauth.example.test/authorize?state=private",
        activate: true,
        reveal: true,
      }),
    );
    await waitFor(() =>
      expect(bridge.browserCloseTab).toHaveBeenCalledWith({ tabId: "plugin-oauth-tab" }),
    );
    expect(bridge.openExternalNative).not.toHaveBeenCalled();
  });

  it("closes the sensitive embedded tab when plugin OAuth waiting fails", async () => {
    bridge.waitMcpServerOauth.mockRejectedValueOnce(new Error("callback failed"));
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() =>
      expect(bridge.browserCloseTab).toHaveBeenCalledWith({ tabId: "plugin-oauth-tab" }),
    );
  });
});

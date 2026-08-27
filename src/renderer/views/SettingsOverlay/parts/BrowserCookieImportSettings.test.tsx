import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBrowserPanelStore } from "@/renderer/state/browserPanelStore";
import { renderWithI18n as render } from "@/renderer/testUtils/i18n";
import type {
  BrowserCookieImportCompletion,
  BrowserCookieImportPairingChallenge,
  BrowserCookieImportState,
} from "@/shared/ipc/procedures/browserCookieImport";

type ActiveRequest = NonNullable<BrowserCookieImportState["activeRequest"]>;

const { bridgeMock } = vi.hoisted(() => ({
  bridgeMock: {
    browserCookieImportOpenExtensionFolder: vi.fn<() => Promise<void>>(),
    browserCookieImportGetState: vi.fn<() => Promise<BrowserCookieImportState>>(),
    browserCookieImportChooseFile:
      vi.fn<(payload: { targetUrls: string[] }) => Promise<ActiveRequest | null>>(),
    browserCookieImportBeginPairing: vi.fn<() => Promise<BrowserCookieImportPairingChallenge>>(),
    browserCookieImportCancelPairing: vi.fn<(payload: { pairingId: string }) => Promise<void>>(),
    browserCookieImportForgetSource: vi.fn<(payload: { sourceId: string }) => Promise<void>>(),
    browserCookieImportPreview:
      vi.fn<(payload: { sourceId: string; targetUrls: string[] }) => Promise<ActiveRequest>>(),
    browserCookieImportCommit:
      vi.fn<
        (payload: {
          requestId: string;
          selectedDomains: string[];
        }) => Promise<BrowserCookieImportCompletion>
      >(),
    browserCookieImportCancel: vi.fn<(payload: { requestId: string }) => Promise<void>>(),
  },
}));

vi.mock("@/renderer/bridge", () => ({ readBridge: () => bridgeMock }));

import { BrowserCookieImportSettings } from "./BrowserCookieImportSettings";

const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_SOURCE_ID = "22222222-2222-4222-8222-222222222222";
const PAIRING_ID = "33333333-3333-4333-8333-333333333333";
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";

const emptyState: BrowserCookieImportState = { sources: [], activeRequest: null };

const connectedSource = {
  sourceId: SOURCE_ID,
  label: "Chrome — Personal",
  browserFamily: "chrome" as const,
  extensionVersion: "1.0.0",
  pairedAt: 1_788_000_000_000,
  connected: true,
};

const readyRequest: ActiveRequest = {
  requestId: REQUEST_ID,
  sourceId: SOURCE_ID,
  sourceKind: "extension",
  status: "ready",
  targetUrls: ["https://app.example.com"],
  domains: [
    { domain: ".example.com", cookieCount: 3, unsupportedCount: 1 },
    { domain: "app.example.com", cookieCount: 2, unsupportedCount: 0 },
  ],
  expiresAt: 1_788_000_300_000,
};

const readyState: BrowserCookieImportState = {
  sources: [connectedSource],
  activeRequest: readyRequest,
};

function setActiveBrowserUrl(url: string | null) {
  useBrowserPanelStore.setState({
    activeTabId: url ? "tab-1" : null,
    tabs: url
      ? [
          {
            tabId: "tab-1",
            url,
            title: "Active site",
            loading: false,
            canGoBack: false,
            canGoForward: false,
          },
        ]
      : [],
  });
}

describe("BrowserCookieImportSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setActiveBrowserUrl(null);
    bridgeMock.browserCookieImportOpenExtensionFolder.mockResolvedValue(undefined);
    bridgeMock.browserCookieImportGetState.mockResolvedValue(emptyState);
    bridgeMock.browserCookieImportChooseFile.mockResolvedValue(null);
    bridgeMock.browserCookieImportBeginPairing.mockResolvedValue({
      pairingId: PAIRING_ID,
      code: "12345678",
      expiresAt: Date.now() + 2 * 60_000,
    });
    bridgeMock.browserCookieImportCancelPairing.mockResolvedValue(undefined);
    bridgeMock.browserCookieImportForgetSource.mockResolvedValue(undefined);
    bridgeMock.browserCookieImportPreview.mockResolvedValue(readyRequest);
    bridgeMock.browserCookieImportCommit.mockResolvedValue({
      requestId: REQUEST_ID,
      importedCount: 4,
      skippedCount: 1,
    });
    bridgeMock.browserCookieImportCancel.mockResolvedValue(undefined);
  });

  afterEach(() => setActiveBrowserUrl(null));

  it("explains how to install the import-only extension and begins or cancels pairing", async () => {
    render(<BrowserCookieImportSettings />);

    expect(screen.getByText("Install Y Space Cookie Import")).toBeInTheDocument();
    expect(screen.getByText(/chrome:\/\/extensions/i)).toBeInTheDocument();
    expect(screen.getByText(/Load unpacked/i)).toBeInTheDocument();
    const openExtensionFolderButton = screen.getByRole("button", {
      name: "Open extension folder",
    });
    await waitFor(() => expect(openExtensionFolderButton).toBeEnabled());
    fireEvent.click(openExtensionFolderButton);
    await waitFor(() =>
      expect(bridgeMock.browserCookieImportOpenExtensionFolder).toHaveBeenCalledOnce(),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Pair browser profile" }));

    expect(await screen.findByText("1234 5678")).toBeInTheDocument();
    expect(screen.getByText(/expires in/i)).toBeInTheDocument();
    expect(bridgeMock.browserCookieImportBeginPairing).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Cancel pairing" }));
    await waitFor(() =>
      expect(bridgeMock.browserCookieImportCancelPairing).toHaveBeenCalledWith({
        pairingId: PAIRING_ID,
      }),
    );
    expect(screen.queryByText("1234 5678")).not.toBeInTheDocument();
  });

  it("lists paired profiles with connection metadata and forgets one", async () => {
    bridgeMock.browserCookieImportGetState.mockResolvedValue({
      sources: [
        connectedSource,
        {
          ...connectedSource,
          sourceId: SECOND_SOURCE_ID,
          label: "Brave — Work",
          browserFamily: "brave",
          connected: false,
        },
      ],
      activeRequest: null,
    });

    render(<BrowserCookieImportSettings />);

    expect((await screen.findAllByText("Chrome — Personal")).length).toBeGreaterThan(0);
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("Brave — Work")).toBeInTheDocument();
    expect(screen.getByText("Disconnected")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Forget Chrome — Personal" }));
    await waitFor(() =>
      expect(bridgeMock.browserCookieImportForgetSource).toHaveBeenCalledWith({
        sourceId: SOURCE_ID,
      }),
    );
  });

  it("prefills only a safe HTTP(S) origin from the active embedded tab", async () => {
    setActiveBrowserUrl("https://app.example.com/private/page?token=not-copied#fragment");
    bridgeMock.browserCookieImportGetState.mockResolvedValue({
      sources: [connectedSource],
      activeRequest: null,
    });

    const { unmount } = render(<BrowserCookieImportSettings />);

    expect(await screen.findByRole("textbox", { name: "Sites to import cookies for" })).toHaveValue(
      "https://app.example.com",
    );
    expect(document.body.textContent).not.toContain("not-copied");

    unmount();
    setActiveBrowserUrl("file:///Users/example/private.html");
    render(<BrowserCookieImportSettings />);

    expect(await screen.findByRole("textbox", { name: "Sites to import cookies for" })).toHaveValue(
      "",
    );
  });

  it("accepts explicit HTTP(S) origins and rejects other schemes or embedded credentials", async () => {
    bridgeMock.browserCookieImportGetState.mockResolvedValue({
      sources: [connectedSource],
      activeRequest: null,
    });
    render(<BrowserCookieImportSettings />);

    const input = await screen.findByRole("textbox", { name: "Sites to import cookies for" });
    fireEvent.change(input, {
      target: { value: "http://localhost:3000\nhttps://docs.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview extension cookies" }));

    await waitFor(() =>
      expect(bridgeMock.browserCookieImportPreview).toHaveBeenCalledWith({
        sourceId: SOURCE_ID,
        targetUrls: ["http://localhost:3000", "https://docs.example.com"],
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel cookie import" }));
    await waitFor(() => expect(input).not.toBeDisabled());

    fireEvent.change(input, {
      target: {
        value: "ftp://example.com\nhttps://user:password@example.com\nhttps://example.com/private",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview extension cookies" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Use HTTP(S) origins without usernames, passwords, paths, or private URL details.",
    );
    expect(bridgeMock.browserCookieImportPreview).toHaveBeenCalledTimes(1);
  });

  it("renders metadata-only preview counts and commits only selected domains", async () => {
    bridgeMock.browserCookieImportGetState.mockResolvedValue({
      sources: [connectedSource],
      activeRequest: null,
    });
    setActiveBrowserUrl("https://app.example.com/dashboard");
    render(<BrowserCookieImportSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "Preview extension cookies" }));

    expect(await screen.findByText(".example.com")).toBeInTheDocument();
    expect(screen.getByText("3 cookies · 1 unsupported")).toBeInTheDocument();
    expect(screen.getByText("app.example.com")).toBeInTheDocument();
    expect(screen.getByText("2 cookies · 0 unsupported")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("session-secret-value");
    expect(screen.queryByText(/cookie value/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "Import cookies for .example.com" }));
    fireEvent.click(screen.getByRole("button", { name: "Import selected cookies" }));

    await waitFor(() =>
      expect(bridgeMock.browserCookieImportCommit).toHaveBeenCalledWith({
        requestId: REQUEST_ID,
        selectedDomains: ["app.example.com"],
      }),
    );
    expect(await screen.findByText("Imported 4 cookies; skipped 1.")).toBeInTheDocument();
  });

  it("imports a Cookie-Editor or Netscape file without a paired extension", async () => {
    const fileRequest: ActiveRequest = {
      ...readyRequest,
      sourceId: REQUEST_ID,
      sourceKind: "file",
      sourceLabel: "cookies.txt",
      domains: [{ domain: "example.com", cookieCount: 1, unsupportedCount: 0 }],
    };
    bridgeMock.browserCookieImportChooseFile.mockResolvedValue(fileRequest);
    render(<BrowserCookieImportSettings />);

    const input = await screen.findByRole("textbox", { name: "Sites to import cookies for" });
    fireEvent.change(input, { target: { value: "https://example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Choose cookie file" }));

    await waitFor(() =>
      expect(bridgeMock.browserCookieImportChooseFile).toHaveBeenCalledWith({
        targetUrls: ["https://example.com"],
      }),
    );
    expect(await screen.findByText("cookies.txt")).toBeInTheDocument();
    expect(screen.getByText("example.com")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Preview extension cookies" })).toBeNull();
  });

  it("cancels a pending preview without committing it", async () => {
    bridgeMock.browserCookieImportGetState.mockResolvedValue(readyState);
    render(<BrowserCookieImportSettings />);

    expect(await screen.findByText(".example.com")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel cookie import" }));

    await waitFor(() =>
      expect(bridgeMock.browserCookieImportCancel).toHaveBeenCalledWith({
        requestId: REQUEST_ID,
      }),
    );
    expect(bridgeMock.browserCookieImportCommit).not.toHaveBeenCalled();
  });
});

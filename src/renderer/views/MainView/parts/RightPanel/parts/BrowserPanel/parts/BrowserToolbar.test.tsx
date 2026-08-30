import { act, fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithI18n as render } from "@/renderer/testUtils/i18n";
import { useBrowserPanelStore } from "@/renderer/state/browserPanelStore";
import { registerSensitiveNativeViewPresenter } from "@/renderer/state/sensitiveNativeViewObstruction";
import type { PickDestination } from "../hooks/useElementPicker";
import { BrowserToolbar } from "./BrowserToolbar";

const bridge = vi.hoisted(() => ({
  browserRecentHistory: vi.fn<() => Promise<[]>>().mockResolvedValue([]),
}));

vi.mock("@/renderer/bridge", () => ({
  readBridge: () => bridge,
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("BrowserToolbar native-view obstruction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bridge.browserRecentHistory.mockResolvedValue([]);
    useBrowserPanelStore.setState({
      tabs: [
        {
          tabId: "tab-auth",
          url: "about:blank",
          title: "Secure connection",
          loading: false,
          canGoBack: false,
          canGoForward: false,
          sensitiveIntegration: true,
          sensitiveViewGeneration: 4,
        },
      ],
      activeTabId: "tab-auth",
      bookmarks: [],
      bookmarkBarVisible: false,
    });
  });

  it("does not paint the browser menu until the native view confirms it is hidden", async () => {
    const hidden = deferred();
    const presenter = vi.fn<(obstructed: boolean) => Promise<void>>((obstructed) =>
      obstructed ? hidden.promise : Promise.resolve(),
    );
    const unregister = registerSensitiveNativeViewPresenter(presenter);

    try {
      render(
        <BrowserToolbar
          onPick={vi.fn<() => void>()}
          pickerActive={false}
          pickerTargets={[]}
          hasPendingPick={false}
          pendingPickAnchor={null}
          onChoosePickTarget={vi.fn<(threadId: string, destination: PickDestination) => void>()}
          onCancelPendingPick={vi.fn<() => void>()}
          onMenuPreviewChange={vi.fn<(dataUrl: string | null) => void>()}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Browser menu" }));

      expect(presenter).toHaveBeenCalledWith(true);
      expect(screen.queryByRole("menu", { name: "Browser menu" })).not.toBeInTheDocument();

      await act(async () => {
        hidden.resolve();
        await hidden.promise;
        await Promise.resolve();
      });

      expect(await screen.findByRole("menu", { name: "Browser menu" })).toBeInTheDocument();
    } finally {
      unregister(Promise.resolve());
    }
  });
});

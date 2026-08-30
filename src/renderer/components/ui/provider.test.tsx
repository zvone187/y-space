import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "@heroui/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThemeMode } from "@/shared/contracts";

const settingsState: {
  themeMode: ThemeMode;
  themePreset: string;
  locale: "system";
  sidebarTranslucency: boolean;
  sidebarGlassTint: { light: number | null; dark: number | null };
} = {
  themeMode: "system",
  themePreset: "default",
  locale: "system",
  sidebarTranslucency: true,
  sidebarGlassTint: { light: null, dark: null },
};

interface WindowChromeTestPayload {
  materialEnabled?: boolean;
}

interface WindowChromeTestResult {
  nativeCapable: boolean;
  nativeActive: boolean;
}

const bridgeMocks = vi.hoisted(() => ({
  setWindowChrome:
    vi.fn<(payload: WindowChromeTestPayload) => Promise<WindowChromeTestResult | void>>(),
}));

vi.mock("../../state/sharedSettingsStore", () => ({
  useSharedSettings: (selector: (s: typeof settingsState) => unknown) => selector(settingsState),
}));

vi.mock("@/renderer/bridge", () => ({
  isMac: () => true,
  isRemoteSession: () => false,
  isWindows: () => false,
  readBridge: () => ({
    setWindowChrome: bridgeMocks.setWindowChrome,
  }),
}));

import { AppProvider } from "./provider";

function setMatchMedia(prefersDark: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query.includes("dark") ? prefersDark : !prefersDark,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

function installControllableMatchMedia(options: { prefersDark: boolean; reduced: boolean }) {
  const mediaByQuery = new Map<
    string,
    {
      matches: boolean;
      listeners: Set<(event: MediaQueryListEvent) => void>;
      media: MediaQueryList;
    }
  >();

  const resolveMatches = (query: string) =>
    query.includes("prefers-color-scheme") ? options.prefersDark : options.reduced;

  const getMedia = (query: string) => {
    const existing = mediaByQuery.get(query);
    if (existing) return existing;

    const state = {
      matches: resolveMatches(query),
      listeners: new Set<(event: MediaQueryListEvent) => void>(),
      media: undefined as unknown as MediaQueryList,
    };
    state.media = {
      get matches() {
        return state.matches;
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject | null) => {
        if (typeof listener === "function") {
          state.listeners.add(listener as (event: MediaQueryListEvent) => void);
        }
      },
      removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject | null) => {
        if (typeof listener === "function") {
          state.listeners.delete(listener as (event: MediaQueryListEvent) => void);
        }
      },
      addListener: (listener: ((event: MediaQueryListEvent) => void) | null) => {
        if (listener) state.listeners.add(listener);
      },
      removeListener: (listener: ((event: MediaQueryListEvent) => void) | null) => {
        if (listener) state.listeners.delete(listener);
      },
      dispatchEvent: () => false,
    };
    mediaByQuery.set(query, state);
    return state;
  };

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => getMedia(query).media,
  });

  return {
    setReduced(matches: boolean) {
      const query = "(prefers-reduced-transparency: reduce)";
      const state = getMedia(query);
      state.matches = matches;
      const event = { matches, media: query } as MediaQueryListEvent;
      for (const listener of state.listeners) listener(event);
    },
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

beforeEach(() => {
  settingsState.themeMode = "system";
  settingsState.themePreset = "default";
  settingsState.locale = "system";
  settingsState.sidebarTranslucency = true;
  bridgeMocks.setWindowChrome.mockReset();
  bridgeMocks.setWindowChrome.mockResolvedValue(undefined);
  document.documentElement.classList.remove("light", "dark");
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.themePreset;
  delete document.documentElement.dataset.sidebarGlass;
  delete document.documentElement.dataset.nativeMaterial;
  Reflect.deleteProperty(window, "poracode");
  setMatchMedia(true);
});

afterEach(() => {
  toast.clear();
  // Restore the testSetup default matchMedia stub so other tests behave.
  setMatchMedia(true);
});

describe("AppProvider", () => {
  it("renders children", () => {
    render(
      <AppProvider>
        <div>provider works</div>
      </AppProvider>,
    );
    expect(screen.getByText("provider works")).toBeInTheDocument();
  });

  it("uses a bounded responsive toast width", async () => {
    render(
      <AppProvider>
        <span />
      </AppProvider>,
    );

    act(() => {
      toast("Width test");
    });

    await waitFor(() => {
      const region = document.querySelector('[data-slot="toast-region"]');
      expect(region).toHaveClass("lc-toast-region");
      expect(region).toHaveStyle({
        "--toast-width": "min(32rem, calc(100vw - 2rem))",
      });
    });
  });

  it("marks long toast descriptions as a bounded scrolling region", async () => {
    render(
      <AppProvider>
        <span />
      </AppProvider>,
    );

    act(() => {
      toast("Bounded toast", {
        description: Array.from({ length: 100 }, (_, index) => `Description line ${index}`).join(
          "\n",
        ),
        timeout: 0,
      });
    });

    await waitFor(() => {
      expect(document.querySelector('[data-slot="toast-description"]')).toHaveClass(
        "lc-toast__description",
      );
      expect(document.querySelector('[data-slot="toast"]')).toHaveClass("lc-toast");
    });
  });

  it.each([
    ["down", { clientX: 100, clientY: 170 }],
    ["left", { clientX: 30, clientY: 100 }],
    ["right", { clientX: 170, clientY: 100 }],
  ])("dismisses a toast with a touch swipe %s", async (_direction, end) => {
    render(
      <AppProvider>
        <span />
      </AppProvider>,
    );
    act(() => {
      toast("Swipe test", { timeout: 0 });
    });

    const toastElement = await screen
      .findByText("Swipe test")
      .then((title) => title.closest('[data-slot="toast"]'));
    expect(toastElement).not.toBeNull();
    Object.defineProperty(toastElement, "setPointerCapture", {
      value: vi.fn<(pointerId: number) => void>(),
    });

    fireEvent.pointerDown(toastElement!, {
      pointerId: 1,
      pointerType: "touch",
      isPrimary: true,
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerMove(toastElement!, { pointerId: 1, pointerType: "touch", ...end });
    fireEvent.pointerUp(toastElement!, { pointerId: 1, pointerType: "touch", ...end });

    await waitFor(() => {
      expect(screen.queryByText("Swipe test")).not.toBeInTheDocument();
    });
  });

  it("keeps a toast for upward, short, and mouse drags", async () => {
    render(
      <AppProvider>
        <span />
      </AppProvider>,
    );
    act(() => {
      toast("Keep test", { timeout: 0 });
    });

    const toastElement = await screen
      .findByText("Keep test")
      .then((title) => title.closest('[data-slot="toast"]'));
    expect(toastElement).not.toBeNull();
    Object.defineProperty(toastElement, "setPointerCapture", {
      value: vi.fn<(pointerId: number) => void>(),
    });

    fireEvent.pointerDown(toastElement!, {
      pointerId: 1,
      pointerType: "touch",
      isPrimary: true,
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerMove(toastElement!, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 100,
      clientY: 20,
    });
    fireEvent.pointerUp(toastElement!, { pointerId: 1, pointerType: "touch" });

    fireEvent.pointerDown(toastElement!, {
      pointerId: 2,
      pointerType: "touch",
      isPrimary: true,
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerMove(toastElement!, {
      pointerId: 2,
      pointerType: "touch",
      clientX: 140,
      clientY: 140,
    });
    fireEvent.pointerUp(toastElement!, { pointerId: 2, pointerType: "touch" });

    fireEvent.pointerDown(toastElement!, {
      pointerId: 3,
      pointerType: "mouse",
      isPrimary: true,
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerMove(toastElement!, {
      pointerId: 3,
      pointerType: "mouse",
      clientX: 200,
      clientY: 200,
    });
    fireEvent.pointerUp(toastElement!, { pointerId: 3, pointerType: "mouse" });

    expect(screen.getByText("Keep test")).toBeInTheDocument();
  });

  it("applies dark class + data-theme when themeMode is explicit 'dark'", () => {
    settingsState.themeMode = "dark";
    render(
      <AppProvider>
        <span />
      </AppProvider>,
    );
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.themePreset).toBe("default");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.classList.contains("light")).toBe(false);
  });

  it("applies light class + data-theme when themeMode is explicit 'light'", () => {
    settingsState.themeMode = "light";
    render(
      <AppProvider>
        <span />
      </AppProvider>,
    );
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.classList.contains("light")).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("follows the system preference when themeMode is 'system' (dark)", () => {
    settingsState.themeMode = "system";
    setMatchMedia(true);
    render(
      <AppProvider>
        <span />
      </AppProvider>,
    );
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("follows the system preference when themeMode is 'system' (light)", () => {
    settingsState.themeMode = "system";
    setMatchMedia(false);
    render(
      <AppProvider>
        <span />
      </AppProvider>,
    );
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("disables sidebar glass and native material when reduced transparency changes live", async () => {
    const media = installControllableMatchMedia({ prefersDark: false, reduced: false });
    Object.defineProperty(window, "poracode", {
      configurable: true,
      value: {},
    });
    bridgeMocks.setWindowChrome.mockImplementation(async ({ materialEnabled }) => ({
      nativeCapable: true,
      nativeActive: materialEnabled === true,
    }));

    render(
      <AppProvider contentReady>
        <span />
      </AppProvider>,
    );

    await waitFor(() => {
      expect(bridgeMocks.setWindowChrome).toHaveBeenCalledWith(
        expect.objectContaining({ materialEnabled: true }),
      );
      expect(document.documentElement.dataset.sidebarGlass).toBe("on");
      expect(document.documentElement.dataset.nativeMaterial).toBe("on");
    });

    act(() => {
      media.setReduced(true);
    });

    expect(document.documentElement.dataset.sidebarGlass).toBe("off");
    expect(document.documentElement.dataset.nativeMaterial).toBe("off");
    await waitFor(() => {
      expect(bridgeMocks.setWindowChrome).toHaveBeenLastCalledWith(
        expect.objectContaining({ materialEnabled: false }),
      );
    });
  });

  it("ignores a stale native-material enable response after reduced transparency turns on", async () => {
    const media = installControllableMatchMedia({ prefersDark: false, reduced: false });
    const pendingEnable = createDeferred<WindowChromeTestResult>();
    Object.defineProperty(window, "poracode", {
      configurable: true,
      value: {},
    });
    bridgeMocks.setWindowChrome
      .mockImplementationOnce(() => pendingEnable.promise)
      .mockResolvedValueOnce({ nativeCapable: true, nativeActive: false });

    render(
      <AppProvider contentReady>
        <span />
      </AppProvider>,
    );

    await waitFor(() => {
      expect(bridgeMocks.setWindowChrome).toHaveBeenCalledWith(
        expect.objectContaining({ materialEnabled: true }),
      );
      expect(document.documentElement.dataset.sidebarGlass).toBe("on");
    });

    act(() => {
      media.setReduced(true);
    });

    await waitFor(() => {
      expect(bridgeMocks.setWindowChrome).toHaveBeenLastCalledWith(
        expect.objectContaining({ materialEnabled: false }),
      );
      expect(document.documentElement.dataset.sidebarGlass).toBe("off");
      expect(document.documentElement.dataset.nativeMaterial).toBe("off");
    });

    await act(async () => {
      pendingEnable.resolve({ nativeCapable: true, nativeActive: true });
      await pendingEnable.promise;
    });

    expect(document.documentElement.dataset.sidebarGlass).toBe("off");
    expect(document.documentElement.dataset.nativeMaterial).toBe("off");
  });
});

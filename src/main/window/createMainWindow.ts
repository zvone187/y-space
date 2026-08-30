import { dbGetState, dbSetState } from "../db";
import { BrowserWindow, screen, type RenderProcessGoneDetails } from "electron";
import type { PoracodeChannel } from "@/shared/channel";
import type { PoracodeWindowKind } from "@/shared/ipc";
import type { RendererProcessGoneIntent } from "@/main/diagnostics/processGone";
import {
  installNavigationGuards,
  installSessionPermissions,
  isNavigationUrlAllowed,
} from "../browser/permissions";
import { supportsNativeWindowMaterial, syncNativeThemeForMaterial } from "./windowMaterial";
import {
  buildRendererAdditionalArguments,
  installAppNavigationGuards,
  installRendererReloadGuard,
  noteRendererWindowClose,
} from "./windowHardening";
import { rectOverlapsWorkArea } from "./windowGeometry";

const SENSITIVE_WEBVIEW_PARTITION_PATTERN = /^(?:pipedream|sensitive)-oauth-[a-f0-9]{32}$/u;

interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

function getSavedWindowBounds(stateKey: string): WindowBounds | null {
  try {
    const raw = dbGetState(stateKey);
    if (!raw) {
      return null;
    }
    const bounds = JSON.parse(raw) as WindowBounds;
    if (typeof bounds.width !== "number" || typeof bounds.height !== "number") {
      return null;
    }
    if (typeof bounds.x === "number" && typeof bounds.y === "number") {
      const rect = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
      const display = screen.getDisplayMatching(rect);
      if (!rectOverlapsWorkArea(rect, display.workArea)) {
        return {
          width: bounds.width,
          height: bounds.height,
          isMaximized: bounds.isMaximized,
        };
      }
    }
    return bounds;
  } catch {
    return null;
  }
}

function saveWindowBounds(window: BrowserWindow, stateKey: string): void {
  const isMaximized = window.isMaximized();
  const { x, y, width, height } = window.getNormalBounds();
  dbSetState(stateKey, JSON.stringify({ x, y, width, height, isMaximized }));
}

export interface CreateMainWindowOptions {
  title: string;
  windowKind?: PoracodeWindowKind;
  boundsStateKey?: string | null;
  defaultWidth?: number;
  defaultHeight?: number;
  minWidth?: number;
  minHeight?: number;
  isDev: boolean;
  channel: PoracodeChannel;
  preloadPath: string;
  rendererHtmlPath: string;
  appVersion: string;
  posthogEnableDev: boolean;
  posthogEnabled: boolean;
  posthogHost: string;
  posthogKey: string;
  sentryEnabled: boolean;
  windowChromeHeight: number;
  browserUserAgent: string;
  /** Saved appearance, so the native window opens matching the theme. */
  appearance: "light" | "dark";
  /** Saved opt-in translucent ("liquid glass") sidebar, so the window opens with the material already applied. */
  sidebarTranslucency: boolean;
  onClosed(): void;
  onClose?: (event: Electron.Event) => void;
  onRendererProcessGone?: (
    details: RenderProcessGoneDetails,
    intent: RendererProcessGoneIntent | undefined,
  ) => void;
  devServerUrl?: string;
  openDevTools?: boolean;
  showOnReady?: boolean;
}

export function createMainWindow(options: CreateMainWindowOptions): BrowserWindow {
  const boundsStateKey =
    options.boundsStateKey === undefined ? "window-bounds" : options.boundsStateKey;
  const saved = boundsStateKey ? getSavedWindowBounds(boundsStateKey) : null;
  const supportsTitleBarOverlay = process.platform === "win32" || process.platform === "linux";
  const isDark = options.appearance === "dark";
  // Base bg/symbol per appearance, matching styles.css and the runtime
  // setWindowChrome values, so the first frame doesn't flash a fixed palette.
  const backgroundColor = isDark ? "#070709" : "#ffffff";
  const symbolColor = isDark ? "#fafafa" : "#181816";
  // macOS: always create the window transparent + vibrancy-capable so the glass
  // sidebar can be toggled live (the renderer reveals/hides it purely via CSS —
  // with glass off the opaque content simply covers the material). macOS can't
  // turn an opaque window transparent at runtime, so the capability has to exist
  // from creation. Windows acrylic is applied here for a flash-free first paint
  // when glass is already on, and toggled live via setBackgroundMaterial.
  const isMacOS = process.platform === "darwin";
  const winGlassAtStart =
    process.platform === "win32" && options.sidebarTranslucency && supportsNativeWindowMaterial();
  if (options.sidebarTranslucency && supportsNativeWindowMaterial()) {
    // Match the native appearance to the app theme so the material renders in the
    // right light/dark variant from the first frame.
    syncNativeThemeForMaterial(options.appearance);
  }
  const window = new BrowserWindow({
    title: options.title,
    show: false,
    width: saved?.width ?? options.defaultWidth ?? 1460,
    height: saved?.height ?? options.defaultHeight ?? 920,
    ...(saved?.x != null && saved?.y != null ? { x: saved.x, y: saved.y } : {}),
    minWidth: options.minWidth ?? 540,
    minHeight: options.minHeight ?? 720,
    backgroundColor: isMacOS || winGlassAtStart ? "#00000000" : backgroundColor,
    autoHideMenuBar: true,
    ...(isMacOS
      ? { vibrancy: "sidebar" as const, visualEffectState: "active" as const, transparent: true }
      : {}),
    ...(winGlassAtStart ? { backgroundMaterial: "acrylic" as const } : {}),
    ...(supportsTitleBarOverlay
      ? {
          titleBarStyle: "hidden" as const,
          titleBarOverlay: {
            color: "#00000000",
            symbolColor,
            height: options.windowChromeHeight,
          },
        }
      : {
          titleBarStyle: "hiddenInset" as const,
        }),
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Electron disables Chromium plugins by default. Its bundled PDF viewer
      // is one of those plugins, so document-tab application/pdf embeds need
      // this even though the containing renderer itself remains sandboxed.
      plugins: true,
      webviewTag: true,
      additionalArguments: buildRendererAdditionalArguments({
        appVersion: options.appVersion,
        isDev: options.isDev,
        windowKind: options.windowKind ?? "main",
        channel: options.channel,
        posthogEnableDev: options.posthogEnableDev,
        posthogEnabled: options.posthogEnabled,
        posthogHost: options.posthogHost,
        posthogKey: options.posthogKey,
        sentryEnabled: options.sentryEnabled,
      }),
    },
  });
  installSessionPermissions(window.webContents.session);
  window.webContents.setUserAgent(options.browserUserAgent);

  installAppNavigationGuards(window, {
    isDev: options.isDev,
    ...(options.devServerUrl ? { devServerUrl: options.devServerUrl } : {}),
  });
  // `webviewTag` is enabled for the in-app browser; the embedding renderer
  // controls each <webview>'s attributes, so enforce that no webview can
  // request a preload or Node access regardless of what markup is injected.
  window.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    if (
      (typeof params?.partition === "string" &&
        SENSITIVE_WEBVIEW_PARTITION_PATTERN.test(params.partition)) ||
      (typeof webPreferences.partition === "string" &&
        SENSITIVE_WEBVIEW_PARTITION_PATTERN.test(webPreferences.partition)) ||
      (typeof params?.src === "string" && !isNavigationUrlAllowed(params.src))
    ) {
      event.preventDefault();
    }
  });
  // A guest may execute its first document before the renderer's dom-ready IPC
  // maps it to BrowserPanelManager. Install a main-process deny guard at the
  // earliest attached-WebContents boundary so that gap cannot create an
  // unmanaged popup or enter a blocked scheme. BrowserTab later replaces the
  // popup handler with its tab-routing handler while retaining the same deny
  // policy for unsafe navigation.
  window.webContents.on("did-attach-webview", (_event, guestWebContents) => {
    const removeGuards = installNavigationGuards(guestWebContents, () => {});
    guestWebContents.once("destroyed", removeGuards);
  });

  window.once("ready-to-show", () => {
    if (saved?.isMaximized) {
      window.maximize();
    }
    if (options.showOnReady !== false) window.show();
  });

  const loadRenderer = () => {
    if (options.isDev) {
      void window.loadURL(options.devServerUrl as string);
    } else {
      void window.loadFile(options.rendererHtmlPath);
    }
  };

  loadRenderer();
  if (options.isDev && options.openDevTools !== false) {
    window.webContents.openDevTools({ mode: "detach" });
  }

  installRendererReloadGuard(window, {
    loadRenderer,
    ...(options.onRendererProcessGone
      ? { onRendererProcessGone: options.onRendererProcessGone }
      : {}),
  });

  let boundsTimer: ReturnType<typeof setTimeout> | null = null;
  const debouncedSave = () => {
    if (boundsTimer) {
      clearTimeout(boundsTimer);
    }
    if (boundsStateKey) {
      boundsTimer = setTimeout(() => saveWindowBounds(window, boundsStateKey), 500);
    }
  };
  window.on("resize", debouncedSave);
  window.on("move", debouncedSave);
  window.on("maximize", debouncedSave);
  window.on("unmaximize", debouncedSave);
  window.on("close", (event) => {
    if (boundsTimer) {
      clearTimeout(boundsTimer);
    }
    if (boundsStateKey) {
      saveWindowBounds(window, boundsStateKey);
    }
    options.onClose?.(event);
    noteRendererWindowClose(window, event);
  });
  window.on("closed", options.onClosed);

  return window;
}

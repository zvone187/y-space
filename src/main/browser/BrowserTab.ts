import { webContents as webContentsModule, type WebContents } from "electron";
import { CdpClient } from "./cdp/cdpClient";
import {
  addInitScript as installInitScript,
  addInitStyle as installInitStyle,
  evalJs,
  evaluateOneShotStyle,
  removeInitScript as uninstallInitScript,
} from "./cdp/tools";
import { DialogController } from "./cdp/dialogController";
import { NetworkCapture } from "./cdp/networkCapture";
import { withCursorOverlayHidden } from "./cursorOverlay";
import { truncateUtf8, utf8ByteLength } from "./boundedText";
import {
  installNavigationGuards,
  installSensitiveSessionPermissions,
  installSessionPermissions,
  isNavigationUrlAllowed,
} from "./permissions";

export interface BrowserTabSnapshot {
  tabId: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  devToolsOpen: boolean;
  faviconUrl?: string;
}

export interface BrowserTabOptions {
  tabId: string;
  initialUrl?: string;
  initialTitle?: string;
  userAgent: string;
  permissionProfile?: "ordinary" | "sensitive";
  onUpdate(snapshot: BrowserTabSnapshot): void;
  onAttention(tabId: string): void;
  onPopup(tabId: string, url: string): void;
  onClose?(tabId: string): void;
  onNewTab?(): void;
  onCycle?(tabId: string, direction: "next" | "previous"): void;
}

export interface ConsoleEntry {
  ts: number;
  level: "log" | "warn" | "error" | "info" | "debug" | "exception";
  text: string;
  source?: string;
  line?: number;
}

const CONSOLE_BUFFER_SIZE = 200;
export const BROWSER_TAB_ATTACH_TIMEOUT_MS = 8_000;
export const MAX_BROWSER_URL_BYTES = 64 * 1024;
export const MAX_BROWSER_TITLE_BYTES = 8 * 1024;
export const BROWSER_TAB_TARGET_INITIALIZATION_TIMEOUT_MS = 1_000;
const MAX_BROWSER_FAVICON_URL_BYTES = 64 * 1024;
const MAX_BROWSER_CONSOLE_TEXT_BYTES = 64 * 1024;
const MAX_BROWSER_CONSOLE_SOURCE_BYTES = 16 * 1024;
export const MAX_BROWSER_CONSOLE_TOTAL_BYTES = 1024 * 1024;
const MAX_RETAINED_INIT_SCRIPTS = 32;
const MAX_RETAINED_INIT_SCRIPT_SOURCE_BYTES = 256 * 1024;
const MAX_RETAINED_INIT_SCRIPT_TOTAL_BYTES = 512 * 1024;

type RetainedInitScriptKind = "script" | "style";

interface RetainedInitScript {
  /** Stable identifier returned to the agent; never a target-scoped CDP id. */
  readonly identifier: string;
  readonly kind: RetainedInitScriptKind;
  /** Raw JS or CSS, held only in memory and bounded by the limits above. */
  readonly source: string;
  readonly sourceBytes: number;
  /** Identifier installed on the currently attached CDP target, if any. */
  targetIdentifier: string | null;
}

interface AttachmentWaiter {
  readonly targetGeneration: number;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout> | null;
}

type BoundedInitializationResult<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected" }
  | { status: "timed-out" }
  | { status: "aborted" };

function settleInitializationBefore<T>(
  promise: Promise<T>,
  deadline: number,
  signal: AbortSignal,
): Promise<BoundedInitializationResult<T>> {
  return new Promise<BoundedInitializationResult<T>>((resolve) => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const finish = (result: BoundedInitializationResult<T>) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      timeout = null;
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => finish({ status: "aborted" });

    // Observe the operation even when its budget is already exhausted. The
    // caller creates the promise before this helper can inspect the deadline,
    // so returning immediately without a rejection handler would leak a late
    // failure as an unhandled rejection.
    void promise.then(
      (value) => finish({ status: "fulfilled", value }),
      () => finish({ status: "rejected" }),
    );

    if (signal.aborted) {
      finish({ status: "aborted" });
      return;
    }
    const remainingMs = Math.max(0, deadline - Date.now());
    if (remainingMs === 0) {
      finish({ status: "timed-out" });
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(() => finish({ status: "timed-out" }), remainingMs);
  });
}

export class BrowserTab {
  readonly tabId: string;
  readonly network: NetworkCapture;
  readonly dialogs: DialogController;
  private _webContents: WebContents | null = null;
  private _cdp: CdpClient | null = null;
  private currentUrl: string;
  private currentTitle: string;
  private faviconUrl: string | undefined;
  private loading = false;
  private destroyed = false;
  private console: ConsoleEntry[] = [];
  private consoleBytes = 0;
  private retainedInitScripts = new Map<string, RetainedInitScript>();
  private retainedInitScriptBytes = 0;
  private nextRetainedInitScriptId = 0;
  private attachedTargetGeneration = 0;
  private readyTargetGeneration = -1;
  private readonly attachmentWaiters = new Set<AttachmentWaiter>();
  private lastEmittedSnapshot: BrowserTabSnapshot | null = null;
  private clearInitialHistoryOnLoad = false;
  private initialHistoryUrl: string | null = null;
  private clearInitialHistoryTimer: ReturnType<typeof setTimeout> | null = null;
  private targetInitializationAbortController: AbortController | null = null;
  private devToolsVisible = false;
  private wcCleanups: Array<() => void> = [];

  constructor(private readonly opts: BrowserTabOptions) {
    this.tabId = opts.tabId;
    this.network = new NetworkCapture();
    this.dialogs = new DialogController();
    this.currentUrl = truncateUtf8(opts.initialUrl ?? "about:blank", MAX_BROWSER_URL_BYTES);
    this.currentTitle = truncateUtf8(opts.initialTitle ?? "", MAX_BROWSER_TITLE_BYTES);
    if (opts.initialUrl) {
      this.clearInitialHistoryOnLoad = true;
      this.initialHistoryUrl = this.currentUrl;
    }
  }

  get webContents(): WebContents {
    if (!this._webContents || this._webContents.isDestroyed()) {
      throw new Error(`Browser tab ${this.tabId} has no attached webContents`);
    }
    return this._webContents;
  }

  get cdp(): CdpClient {
    if (!this._cdp) {
      throw new Error(`Browser tab ${this.tabId} has no attached CDP client`);
    }
    return this._cdp;
  }

  isAttached(): boolean {
    return this._webContents !== null && !this._webContents.isDestroyed();
  }

  whenAttached(timeoutMs = BROWSER_TAB_ATTACH_TIMEOUT_MS): Promise<void> {
    if (this.destroyed) {
      return Promise.reject(new Error(`Browser tab ${this.tabId} was destroyed`));
    }
    const targetGeneration = this.isAttached()
      ? this.attachedTargetGeneration
      : this.attachedTargetGeneration + 1;
    if (this.isAttached() && this.readyTargetGeneration === targetGeneration) {
      return Promise.resolve();
    }

    const boundedTimeout =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? Math.max(1, Math.floor(timeoutMs))
        : BROWSER_TAB_ATTACH_TIMEOUT_MS;
    return new Promise<void>((resolve, reject) => {
      const waiter: AttachmentWaiter = {
        targetGeneration,
        resolve,
        reject,
        timeout: null,
      };
      waiter.timeout = setTimeout(() => {
        if (!this.attachmentWaiters.delete(waiter)) return;
        waiter.timeout = null;
        reject(
          new Error(`Browser tab ${this.tabId} attachment timed out after ${boundedTimeout}ms`),
        );
      }, boundedTimeout);
      this.attachmentWaiters.add(waiter);
    });
  }

  /** Attach a replacement guest, returning false for duplicate/stale repeats. */
  attach(webContents: WebContents): boolean {
    if (this.destroyed) return false;
    if (this._webContents === webContents) return false;
    if (this._webContents) {
      this.rejectAttachmentWaiters(
        this.attachedTargetGeneration,
        new Error(`Browser tab ${this.tabId} attachment target was replaced`),
      );
      this.teardownListeners();
      this._webContents = null;
      this._cdp = null;
    }
    this._webContents = webContents;
    webContents.setUserAgent(this.opts.userAgent);
    const cdp = new CdpClient(webContents);
    this._cdp = cdp;
    const targetGeneration = ++this.attachedTargetGeneration;
    const initializationAbortController = new AbortController();
    this.targetInitializationAbortController = initializationAbortController;
    if (this.opts.permissionProfile === "sensitive") {
      installSensitiveSessionPermissions(webContents.session);
    } else {
      installSessionPermissions(webContents.session);
    }
    const removeNavGuards = installNavigationGuards(
      webContents,
      (popupUrl) => {
        this.opts.onPopup(this.tabId, popupUrl);
      },
      this.opts.permissionProfile ?? "ordinary",
    );
    this.wcCleanups.push(removeNavGuards);
    this.wireEvents(webContents);
    this.currentUrl = truncateUtf8(webContents.getURL() || this.currentUrl, MAX_BROWSER_URL_BYTES);
    this.currentTitle = truncateUtf8(
      webContents.getTitle() || this.currentTitle,
      MAX_BROWSER_TITLE_BYTES,
    );
    this.loading = webContents.isLoadingMainFrame();
    if (
      !this.loading &&
      this.clearInitialHistoryOnLoad &&
      this.initialHistoryUrl === this.currentUrl
    ) {
      this.finishInitialHistoryCleanup(webContents);
    }
    void this.initializeAttachedTarget(cdp, targetGeneration, initializationAbortController);
    this.emit();
    return true;
  }

  private async initializeAttachedTarget(
    cdp: CdpClient,
    targetGeneration: number,
    abortController: AbortController,
  ): Promise<void> {
    const deadline = Date.now() + BROWSER_TAB_TARGET_INITIALIZATION_TIMEOUT_MS;
    try {
      await cdp.attach();
      if (!this.isCurrentTarget(cdp, targetGeneration)) return;
      await this.reinstallRetainedInitScripts(
        cdp,
        targetGeneration,
        deadline,
        abortController.signal,
      );
      if (!this.isCurrentTarget(cdp, targetGeneration)) return;
      try {
        const remainingMs = Math.max(0, deadline - Date.now());
        if (remainingMs > 0) {
          await settleInitializationBefore(
            this.dialogs.enable(cdp, remainingMs),
            deadline,
            abortController.signal,
          );
        }
      } catch {}
    } catch {
      // Preserve the existing attachment contract: target setup is best effort,
      // and individual tools surface a CDP failure when they next use it.
    } finally {
      if (this.targetInitializationAbortController === abortController) {
        this.targetInitializationAbortController = null;
      }
      if (this.isCurrentTarget(cdp, targetGeneration)) {
        this.readyTargetGeneration = targetGeneration;
        this.resolveAttachmentWaiters(targetGeneration);
      }
    }
  }

  private resolveAttachmentWaiters(targetGeneration: number): void {
    for (const waiter of this.attachmentWaiters) {
      if (waiter.targetGeneration !== targetGeneration) continue;
      this.attachmentWaiters.delete(waiter);
      if (waiter.timeout) clearTimeout(waiter.timeout);
      waiter.timeout = null;
      waiter.resolve();
    }
  }

  private rejectAttachmentWaiters(targetGeneration: number | null, error: Error): void {
    for (const waiter of this.attachmentWaiters) {
      if (targetGeneration !== null && waiter.targetGeneration !== targetGeneration) continue;
      this.attachmentWaiters.delete(waiter);
      if (waiter.timeout) clearTimeout(waiter.timeout);
      waiter.timeout = null;
      waiter.reject(error);
    }
  }

  private isCurrentTarget(cdp: CdpClient, targetGeneration: number): boolean {
    return (
      !this.destroyed &&
      this._cdp === cdp &&
      this.attachedTargetGeneration === targetGeneration &&
      this._webContents !== null &&
      !this._webContents.isDestroyed()
    );
  }

  private async reinstallRetainedInitScripts(
    cdp: CdpClient,
    targetGeneration: number,
    deadline: number,
    signal: AbortSignal,
  ): Promise<void> {
    for (const [identifier, retained] of this.retainedInitScripts) {
      if (!this.isCurrentTarget(cdp, targetGeneration) || signal.aborted) return;
      const installPromise = this.installRetainedInitScript(cdp, retained.kind, retained.source);
      const installed = await settleInitializationBefore(installPromise, deadline, signal);
      if (installed.status !== "fulfilled") {
        if (installed.status === "timed-out" || installed.status === "aborted") {
          // A response can arrive after the readiness deadline. Remove any late,
          // untracked registration without retaining this BrowserTab instance.
          void installPromise.then(
            (late) => {
              if (!cdp.isAttached()) return;
              void uninstallInitScript(cdp, late.identifier).catch(() => undefined);
            },
            () => undefined,
          );
        }
        return;
      }
      if (!this.isCurrentTarget(cdp, targetGeneration)) return;
      const current = this.retainedInitScripts.get(identifier);
      if (current !== retained) continue;
      current.targetIdentifier = installed.value.identifier;

      // A replacement guest is identified at `dom-ready`, after its first
      // document exists. Reapply once there as well as registering for every
      // subsequent navigation on the new target.
      try {
        const applied =
          retained.kind === "style"
            ? evaluateOneShotStyle(cdp, retained.source)
            : evalJs(cdp, retained.source);
        const result = await settleInitializationBefore(applied, deadline, signal);
        if (result.status === "timed-out" || result.status === "aborted") return;
      } catch {
        // Registration succeeded. Code that is not valid against the already
        // loaded document must still remain active for future documents.
      }
    }
  }

  private installRetainedInitScript(
    cdp: CdpClient,
    kind: RetainedInitScriptKind,
    source: string,
  ): Promise<{ identifier: string }> {
    return kind === "style" ? installInitStyle(cdp, source) : installInitScript(cdp, source);
  }

  private wireEvents(wc: WebContents): void {
    const onTitleUpdated = (_e: unknown, title: string) => {
      this.currentTitle = truncateUtf8(title, MAX_BROWSER_TITLE_BYTES);
      this.emit();
    };
    wc.on("page-title-updated", onTitleUpdated);
    this.wcCleanups.push(() => wc.removeListener("page-title-updated", onTitleUpdated));

    const onDidStartLoading = () => {
      this.loading = true;
      this.emit();
    };
    wc.on("did-start-loading", onDidStartLoading);
    this.wcCleanups.push(() => wc.removeListener("did-start-loading", onDidStartLoading));

    const onDidStopLoading = () => {
      this.loading = false;
      this.currentUrl = truncateUtf8(wc.getURL(), MAX_BROWSER_URL_BYTES);
      this.currentTitle = truncateUtf8(wc.getTitle(), MAX_BROWSER_TITLE_BYTES);
      if (this.clearInitialHistoryOnLoad && this.initialHistoryUrl === this.currentUrl) {
        this.finishInitialHistoryCleanup(wc);
      }
      this.emit();
    };
    wc.on("did-stop-loading", onDidStopLoading);
    this.wcCleanups.push(() => wc.removeListener("did-stop-loading", onDidStopLoading));

    const onDidNavigate = (_e: unknown, url: string) => {
      this.currentUrl = truncateUtf8(url, MAX_BROWSER_URL_BYTES);
      this.faviconUrl = undefined;
      this.emit();
    };
    wc.on("did-navigate", onDidNavigate);
    this.wcCleanups.push(() => wc.removeListener("did-navigate", onDidNavigate));

    const onDidNavigateInPage = (_e: unknown, url: string) => {
      this.currentUrl = truncateUtf8(url, MAX_BROWSER_URL_BYTES);
      this.emit();
    };
    wc.on("did-navigate-in-page", onDidNavigateInPage);
    this.wcCleanups.push(() => wc.removeListener("did-navigate-in-page", onDidNavigateInPage));

    const onFaviconUpdated = (_e: unknown, favicons: string[]) => {
      const first = favicons.find((f) => typeof f === "string" && f.length > 0);
      if (first && first !== this.faviconUrl) {
        this.faviconUrl = truncateUtf8(first, MAX_BROWSER_FAVICON_URL_BYTES);
        this.emit();
      }
    };
    wc.on("page-favicon-updated", onFaviconUpdated);
    this.wcCleanups.push(() => wc.removeListener("page-favicon-updated", onFaviconUpdated));

    const onWillPreventUnload = (event: Electron.Event) => {
      event.preventDefault();
    };
    wc.on("will-prevent-unload", onWillPreventUnload);
    this.wcCleanups.push(() => wc.removeListener("will-prevent-unload", onWillPreventUnload));

    const onBeforeInputEvent = (event: Electron.Event, input: Electron.Input) => {
      const cycleDirection = browserTabCycleDirection(input);
      if (cycleDirection) {
        event.preventDefault();
        this.opts.onCycle?.(this.tabId, cycleDirection);
        return;
      }
      if (isBrowserNewTabKeyDown(input)) {
        event.preventDefault();
        this.opts.onNewTab?.();
        return;
      }
      if (isBrowserCloseKeyDown(input)) {
        event.preventDefault();
        this.opts.onClose?.(this.tabId);
        return;
      }
      if (isBrowserReloadKeyDown(input)) {
        event.preventDefault();
        if (isBrowserHardReloadKeyDown(input)) {
          this.hardReload();
          return;
        }
        wc.reload();
        return;
      }
      if (isBrowserBackKeyDown(input)) {
        event.preventDefault();
        this.goBack();
        return;
      }
      if (isBrowserForwardKeyDown(input)) {
        event.preventDefault();
        this.goForward();
        return;
      }
    };
    wc.on("before-input-event", onBeforeInputEvent);
    this.wcCleanups.push(() => wc.removeListener("before-input-event", onBeforeInputEvent));

    const onConsoleMessage = (
      event: Electron.Event<Electron.WebContentsConsoleMessageEventParams>,
    ) => {
      const level: ConsoleEntry["level"] =
        event.level === "error"
          ? "error"
          : event.level === "warning"
            ? "warn"
            : event.level === "info"
              ? "info"
              : event.level === "debug"
                ? "debug"
                : "log";
      this.pushConsole({
        ts: Date.now(),
        level,
        text: event.message,
        source: event.sourceId,
        line: event.lineNumber,
      });
    };
    wc.on("console-message", onConsoleMessage);
    this.wcCleanups.push(() => wc.removeListener("console-message", onConsoleMessage));

    const onRenderProcessGone = (_e: unknown, details: Electron.RenderProcessGoneDetails) => {
      this.pushConsole({
        ts: Date.now(),
        level: "exception",
        text: `render-process-gone: ${details.reason}`,
      });
    };
    wc.on("render-process-gone", onRenderProcessGone);
    this.wcCleanups.push(() => wc.removeListener("render-process-gone", onRenderProcessGone));

    const onDevToolsOpened = () => {
      this.devToolsVisible = true;
      this.emit();
    };
    wc.on("devtools-opened", onDevToolsOpened);
    this.wcCleanups.push(() => wc.removeListener("devtools-opened", onDevToolsOpened));

    const onDevToolsClosed = () => {
      this.devToolsVisible = false;
      this.emit();
    };
    wc.on("devtools-closed", onDevToolsClosed);
    this.wcCleanups.push(() => wc.removeListener("devtools-closed", onDevToolsClosed));

    const onDestroyed = () => {
      const destroyedGeneration = this.attachedTargetGeneration;
      this.readyTargetGeneration = -1;
      this.rejectAttachmentWaiters(
        destroyedGeneration,
        new Error(`Browser tab ${this.tabId} attachment target was destroyed`),
      );
      this.teardownListeners();
      this._webContents = null;
      this._cdp = null;
    };
    wc.on("destroyed", onDestroyed);
    this.wcCleanups.push(() => wc.removeListener("destroyed", onDestroyed));
  }

  private teardownListeners(): void {
    // A resident page may be suspended and later remounted with a different
    // guest WebContents/CDP target. Release controller bindings now so neither
    // controller retains the destroyed guest or incorrectly reports itself as
    // enabled when the replacement attaches.
    this.targetInitializationAbortController?.abort();
    this.targetInitializationAbortController = null;
    this.network.suspend();
    this.dialogs.suspend();
    for (const retained of this.retainedInitScripts.values()) {
      retained.targetIdentifier = null;
    }
    for (const c of this.wcCleanups) {
      try {
        c();
      } catch {}
    }
    this.wcCleanups = [];
    try {
      this._cdp?.detach();
    } catch {}
    if (this.clearInitialHistoryTimer) {
      clearTimeout(this.clearInitialHistoryTimer);
      this.clearInitialHistoryTimer = null;
    }
  }

  private pushConsole(entry: ConsoleEntry): void {
    const bounded: ConsoleEntry = {
      ...entry,
      text: truncateUtf8(entry.text, MAX_BROWSER_CONSOLE_TEXT_BYTES),
      ...(entry.source
        ? { source: truncateUtf8(entry.source, MAX_BROWSER_CONSOLE_SOURCE_BYTES) }
        : {}),
    };
    const boundedBytes = consoleEntryBytes(bounded);
    this.console.push(bounded);
    this.consoleBytes += boundedBytes;
    while (
      this.console.length > 0 &&
      (this.console.length > CONSOLE_BUFFER_SIZE ||
        this.consoleBytes > MAX_BROWSER_CONSOLE_TOTAL_BYTES)
    ) {
      const evicted = this.console.shift();
      if (evicted) this.consoleBytes = Math.max(0, this.consoleBytes - consoleEntryBytes(evicted));
    }
  }

  getConsoleEntries(limit?: number): ConsoleEntry[] {
    if (!limit || limit >= this.console.length) return this.console.slice();
    return this.console.slice(this.console.length - limit);
  }

  clearConsole(): void {
    this.console = [];
    this.consoleBytes = 0;
  }

  private clearNavigationHistory(): void {
    if (this.destroyed || !this.isAttached()) return;
    this.webContents.navigationHistory.clear();
    this.emit();
  }

  private finishInitialHistoryCleanup(wc: WebContents): void {
    this.clearInitialHistoryOnLoad = false;
    this.clearNavigationHistory();
    if (this.clearInitialHistoryTimer) {
      clearTimeout(this.clearInitialHistoryTimer);
    }
    const urlAtHistoryClear = this.currentUrl;
    this.clearInitialHistoryTimer = setTimeout(() => {
      this.clearInitialHistoryTimer = null;
      // Do not clear a history entry that the user added after the initial
      // page finished loading. This timer exists only to catch Chromium's
      // delayed about:blank entry during first attach.
      if (
        !this.loading &&
        this.currentUrl === urlAtHistoryClear &&
        !wc.navigationHistory.canGoBack() &&
        !wc.navigationHistory.canGoForward()
      ) {
        this.clearNavigationHistory();
      }
    }, 500);
  }

  async addInitScript(source: string): Promise<{ identifier: string }> {
    return await this.addRetainedInitScript("script", source);
  }

  async addInitStyle(css: string): Promise<{ identifier: string }> {
    return await this.addRetainedInitScript("style", css);
  }

  private async addRetainedInitScript(
    kind: RetainedInitScriptKind,
    source: string,
  ): Promise<{ identifier: string }> {
    const sourceBytes = Buffer.byteLength(source, "utf8");
    this.assertCanRetainInitScript(sourceBytes);
    await this.whenAttached();
    const cdp = this.cdp;
    await cdp.attach();
    const installed = await this.installRetainedInitScript(cdp, kind, source);

    // Recheck after the asynchronous target call so concurrent additions can
    // never exceed either retained-data bound. Clean up this target on failure.
    try {
      if (cdp !== this._cdp || !this.isAttached()) {
        throw new Error("browser target changed while adding retained init script");
      }
      this.assertCanRetainInitScript(sourceBytes);
    } catch (error) {
      try {
        await uninstallInitScript(cdp, installed.identifier);
      } catch {}
      throw error;
    }

    const identifier = `ys-init-${++this.nextRetainedInitScriptId}`;
    this.retainedInitScripts.set(identifier, {
      identifier,
      kind,
      source,
      sourceBytes,
      targetIdentifier: installed.identifier,
    });
    this.retainedInitScriptBytes += sourceBytes;
    return { identifier };
  }

  private assertCanRetainInitScript(sourceBytes: number): void {
    if (sourceBytes > MAX_RETAINED_INIT_SCRIPT_SOURCE_BYTES) {
      throw new Error(
        `retained init-script source limit is ${MAX_RETAINED_INIT_SCRIPT_SOURCE_BYTES} bytes`,
      );
    }
    if (this.retainedInitScripts.size >= MAX_RETAINED_INIT_SCRIPTS) {
      throw new Error(`retained init-script count limit is ${MAX_RETAINED_INIT_SCRIPTS}`);
    }
    if (this.retainedInitScriptBytes + sourceBytes > MAX_RETAINED_INIT_SCRIPT_TOTAL_BYTES) {
      throw new Error(
        `retained init-script total limit is ${MAX_RETAINED_INIT_SCRIPT_TOTAL_BYTES} bytes`,
      );
    }
  }

  async removeInitScript(identifier: string): Promise<void> {
    await this.whenAttached();
    const retained = this.retainedInitScripts.get(identifier);
    const targetIdentifier = retained?.targetIdentifier ?? identifier;
    await this.cdp.attach();
    await uninstallInitScript(this.cdp, targetIdentifier);
    if (retained) this.deleteRetainedInitScript(identifier, retained);
  }

  async removeAllInitScripts(): Promise<number> {
    const retained = Array.from(this.retainedInitScripts.entries());
    if (retained.length === 0) return 0;
    await this.whenAttached();
    await this.cdp.attach();
    for (const [identifier, entry] of retained) {
      if (entry.targetIdentifier) {
        try {
          await uninstallInitScript(this.cdp, entry.targetIdentifier);
        } catch {}
      }
      const current = this.retainedInitScripts.get(identifier);
      if (current === entry) this.deleteRetainedInitScript(identifier, entry);
    }
    return retained.length;
  }

  private deleteRetainedInitScript(identifier: string, retained: RetainedInitScript): void {
    this.retainedInitScripts.delete(identifier);
    this.retainedInitScriptBytes = Math.max(0, this.retainedInitScriptBytes - retained.sourceBytes);
  }

  listInitScripts(): string[] {
    return Array.from(this.retainedInitScripts.keys());
  }

  private emit(): void {
    if (this.destroyed) return;
    const snap = this.snapshot();
    if (this.lastEmittedSnapshot && snapshotsEqual(this.lastEmittedSnapshot, snap)) return;
    this.lastEmittedSnapshot = snap;
    this.opts.onUpdate(snap);
  }

  snapshot(): BrowserTabSnapshot {
    const wc = this._webContents && !this._webContents.isDestroyed() ? this._webContents : null;
    return {
      tabId: this.tabId,
      url: truncateUtf8(this.currentUrl || wc?.getURL() || "", MAX_BROWSER_URL_BYTES),
      title: truncateUtf8(this.currentTitle || wc?.getTitle() || "", MAX_BROWSER_TITLE_BYTES),
      loading: this.loading,
      canGoBack: wc?.navigationHistory.canGoBack() ?? false,
      canGoForward: wc?.navigationHistory.canGoForward() ?? false,
      devToolsOpen: this.devToolsVisible,
      ...(this.faviconUrl ? { faviconUrl: this.faviconUrl } : {}),
    };
  }

  async loadURL(url: string): Promise<void> {
    if (Buffer.byteLength(url, "utf8") > MAX_BROWSER_URL_BYTES) {
      throw new Error(`Navigation URL limit is ${MAX_BROWSER_URL_BYTES} bytes`);
    }
    if (!isNavigationUrlAllowed(url)) {
      throw new Error(`Navigation blocked: ${url}`);
    }
    if (!this.isAttached()) {
      // Tab not yet mounted in the renderer; just update the desired URL so the
      // initial `<webview src>` (or a later attach) reflects the request.
      this.currentUrl = url;
      this.clearInitialHistoryOnLoad = true;
      this.emit();
      return;
    }
    // A replacement guest is physically attached before its CDP target has
    // finished restoring retained init scripts. Never race navigation ahead of
    // that restore or the next document would miss the agent's script/style.
    await this.whenAttached();
    if (!this.isAttached()) {
      this.currentUrl = url;
      this.clearInitialHistoryOnLoad = true;
      this.initialHistoryUrl = url;
      this.emit();
      return;
    }
    const wc = this.webContents;
    if (this.currentUrl === "about:blank" && !wc.navigationHistory.canGoBack()) {
      this.clearInitialHistoryOnLoad = true;
      this.initialHistoryUrl = url;
    }
    await wc.loadURL(url);
  }

  hardReload(): void {
    if (this.destroyed || !this.isAttached()) return;
    this.webContents.reloadIgnoringCache();
  }

  goBack(): void {
    if (this.destroyed || !this.isAttached()) return;
    const wc = this.webContents;
    if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  }

  goForward(): void {
    if (this.destroyed || !this.isAttached()) return;
    const wc = this.webContents;
    if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  }

  toggleDevTools(): void {
    if (this.destroyed || !this.isAttached()) return;
    const wc = this.webContents;
    if (this.devToolsVisible || wc.isDevToolsOpened()) {
      wc.closeDevTools();
      return;
    }
    try {
      wc.openDevTools({ mode: "detach", activate: true });
    } catch {}
  }

  clearHistory(): void {
    if (this.destroyed) return;
    this.clearNavigationHistory();
  }

  async clearCookies(): Promise<void> {
    if (this.destroyed || !this.isAttached()) return;
    await this.webContents.session.clearStorageData({ storages: ["cookies"] });
  }

  async clearCache(): Promise<void> {
    if (this.destroyed || !this.isAttached()) return;
    await this.webContents.session.clearCache();
  }

  async capturePng(clip?: Electron.Rectangle): Promise<Buffer> {
    await this.cdp.attach();
    return await withCursorOverlayHidden(this.cdp, async () => {
      const image = await (clip
        ? this.webContents.capturePage(clip)
        : this.webContents.capturePage());
      return image.toPNG();
    });
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.rejectAttachmentWaiters(null, new Error(`Browser tab ${this.tabId} was destroyed`));
    this.teardownListeners();
    try {
      this.network.dispose();
    } catch {}
    try {
      this.dialogs.dispose();
    } catch {}
    // The webContents lifetime is owned by the renderer's <webview> element;
    // we don't close it here. Removing the element from the DOM destroys it.
    this._webContents = null;
    this._cdp = null;
    this.retainedInitScripts.clear();
    this.retainedInitScriptBytes = 0;
    this.console = [];
    this.consoleBytes = 0;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }
}

function consoleEntryBytes(entry: ConsoleEntry): number {
  return utf8ByteLength(entry.text, entry.source);
}

export function resolveWebContentsById(webContentsId: number): WebContents | null {
  return webContentsModule.fromId(webContentsId) ?? null;
}

function snapshotsEqual(a: BrowserTabSnapshot, b: BrowserTabSnapshot): boolean {
  return (
    a.tabId === b.tabId &&
    a.url === b.url &&
    a.title === b.title &&
    a.loading === b.loading &&
    a.canGoBack === b.canGoBack &&
    a.canGoForward === b.canGoForward &&
    a.devToolsOpen === b.devToolsOpen &&
    a.faviconUrl === b.faviconUrl
  );
}

function isBrowserReloadKeyDown(input: Electron.Input): boolean {
  if (input.type !== "keyDown") return false;
  if (input.key === "F5" || input.code === "F5") return true;
  return (input.control || input.meta) && input.key.toLowerCase() === "r";
}

function isBrowserHardReloadKeyDown(input: Electron.Input): boolean {
  return isBrowserReloadKeyDown(input) && input.shift === true;
}

/**
 * Global workspace tab chords must be captured in the guest WebContents: its
 * keyboard events never bubble into the host renderer that owns keybindings.
 * Keep Cmd+Tab untouched for the macOS app switcher; only Ctrl owns Tab itself.
 */
function browserTabCycleDirection(input: Electron.Input): "next" | "previous" | null {
  if (input.type !== "keyDown" || input.alt) return null;
  const key = input.key.toLowerCase();
  if (input.control && key === "tab") return input.shift ? "previous" : "next";
  if (!input.control && !input.meta) return null;
  if (!input.shift && key === "pagedown") return "next";
  if (!input.shift && key === "pageup") return "previous";
  if (input.shift && key === "]") return "next";
  if (input.shift && key === "[") return "previous";
  return null;
}

// Ctrl+[ / ⌘[ goes back, Ctrl+] / ⌘] goes forward. Electron has no built-in
// browser chrome, so these navigation chords don't fire unless handled here.
function isBrowserBackKeyDown(input: Electron.Input): boolean {
  if (input.type !== "keyDown") return false;
  return (input.control || input.meta) && !input.shift && !input.alt && input.key === "[";
}

function isBrowserForwardKeyDown(input: Electron.Input): boolean {
  if (input.type !== "keyDown") return false;
  return (input.control || input.meta) && !input.shift && !input.alt && input.key === "]";
}

function isBrowserCloseKeyDown(input: Electron.Input): boolean {
  if (input.type !== "keyDown") return false;
  return (
    (input.control || input.meta) && !input.shift && !input.alt && input.key.toLowerCase() === "w"
  );
}

function isBrowserNewTabKeyDown(input: Electron.Input): boolean {
  if (input.type !== "keyDown") return false;
  return (
    (input.control || input.meta) && !input.shift && !input.alt && input.key.toLowerCase() === "t"
  );
}

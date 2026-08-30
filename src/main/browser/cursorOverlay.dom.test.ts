// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { CdpSession } from "./cdp/cdpClient";
import {
  cursorFeedbackExpr,
  cursorGlideExpr,
  cursorPathVerificationExpr,
  setCursorOverlayVisible,
  withCursorOverlayHidden,
} from "./cursorOverlay";

const isolatedQuerySelectorAll = Document.prototype.querySelectorAll;
const isolatedCreateElement = Document.prototype.createElement;
const isolatedRemove = Element.prototype.remove;
const isolatedAppendChild = Node.prototype.appendChild;
const isolatedGetComputedStyle = window.getComputedStyle;
const isolatedGetPropertyValue = CSSStyleDeclaration.prototype.getPropertyValue;
let trustedGetComputedStyle = isolatedGetComputedStyle;
const isolatedMatchesDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "matches");
const isolatedShowPopoverDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "showPopover",
);
const isolatedHidePopoverDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "hidePopover",
);
const isolatedShowModalDescriptor = Object.getOwnPropertyDescriptor(
  HTMLDialogElement.prototype,
  "showModal",
);
const isolatedDialogCloseDescriptor = Object.getOwnPropertyDescriptor(
  HTMLDialogElement.prototype,
  "close",
);

interface TopLayerModel {
  readonly order: HTMLElement[];
}

interface CursorDomState {
  identity?: string;
  hostId?: string;
  host: HTMLElement;
  feedback: HTMLElement;
  screenshotOwners?: string[];
  sessionHidden?: boolean;
}

function installBrowserPrimitives(reducedMotion: boolean): TopLayerModel {
  const order: HTMLElement[] = [];
  const openPopovers = new WeakSet<HTMLElement>();
  const removeFromTopLayer = (element: HTMLElement): void => {
    const index = order.indexOf(element);
    if (index >= 0) order.splice(index, 1);
  };
  const toggleEvent = (
    type: "beforetoggle" | "toggle",
    oldState: "closed" | "open",
    newState: "closed" | "open",
    cancelable: boolean,
  ): Event => {
    const event = new Event(type, { cancelable });
    Object.defineProperties(event, {
      oldState: { configurable: true, value: oldState },
      newState: { configurable: true, value: newState },
    });
    return event;
  };
  Object.defineProperty(HTMLElement.prototype, "showPopover", {
    configurable: true,
    writable: true,
    value: function (this: HTMLElement): void {
      if (!this.isConnected || this.getAttribute("popover") !== "manual") {
        throw new DOMException("Popover is not valid", "InvalidStateError");
      }
      if (openPopovers.has(this)) return;
      if (!this.dispatchEvent(toggleEvent("beforetoggle", "closed", "open", true))) return;
      if (!this.isConnected || this.getAttribute("popover") !== "manual") return;
      removeFromTopLayer(this);
      openPopovers.add(this);
      order.push(this);
      this.dispatchEvent(toggleEvent("toggle", "closed", "open", false));
    },
  });
  Object.defineProperty(HTMLElement.prototype, "hidePopover", {
    configurable: true,
    writable: true,
    value: function (this: HTMLElement): void {
      if (!openPopovers.has(this)) return;
      this.dispatchEvent(toggleEvent("beforetoggle", "open", "closed", false));
      openPopovers.delete(this);
      removeFromTopLayer(this);
      this.dispatchEvent(toggleEvent("toggle", "open", "closed", false));
    },
  });
  Object.defineProperty(Element.prototype, "matches", {
    configurable: true,
    writable: true,
    value: function (this: Element, selector: string): boolean {
      if (selector === ":popover-open") {
        if (!(this instanceof HTMLElement) || !this.isConnected) {
          if (this instanceof HTMLElement) openPopovers.delete(this);
          return false;
        }
        return openPopovers.has(this);
      }
      const nativeMatches = isolatedMatchesDescriptor?.value as Element["matches"] | undefined;
      return nativeMatches ? Reflect.apply(nativeMatches, this, [selector]) : false;
    },
  });
  trustedGetComputedStyle = ((element: Element, pseudoElement?: string | null) => {
    const computed = isolatedGetComputedStyle.call(window, element, pseudoElement);
    if (!(element instanceof HTMLElement) || !openPopovers.has(element)) return computed;
    return new Proxy(computed, {
      get(target, property, receiver) {
        if (property === "display") return "block";
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof window.getComputedStyle;
  Object.defineProperty(window, "getComputedStyle", {
    configurable: true,
    writable: true,
    value: trustedGetComputedStyle,
  });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    writable: true,
    value: function (this: HTMLDialogElement): void {
      if (!this.isConnected) throw new DOMException("Dialog is not connected", "InvalidStateError");
      removeFromTopLayer(this);
      this.setAttribute("open", "");
      order.push(this);
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    writable: true,
    value: function (this: HTMLDialogElement): void {
      this.removeAttribute("open");
      removeFromTopLayer(this);
    },
  });
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 700 });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn<(query: string) => MediaQueryList>(
      () => ({ matches: reducedMotion }) as MediaQueryList,
    ),
  });
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>(),
  });
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: vi.fn<(options?: GetAnimationsOptions) => Animation[]>(() => []),
  });
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    value: vi.fn<
      (
        keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
        options?: number | KeyframeAnimationOptions,
      ) => Animation
    >(
      () =>
        ({
          cancel: vi.fn<() => void>(),
          onfinish: null,
        }) as unknown as Animation,
    ),
  });
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    writable: true,
    value: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
  });
  return { order };
}

function addTarget(): HTMLButtonElement {
  const target = document.createElement("button");
  target.id = "target";
  target.getBoundingClientRect = () =>
    ({
      x: 100,
      y: 50,
      left: 100,
      top: 50,
      right: 180,
      bottom: 90,
      width: 80,
      height: 40,
      toJSON: () => ({}),
    }) as DOMRect;
  document.body.appendChild(target);
  return target;
}

async function evaluate<T>(expression: string): Promise<T> {
  return (await window.eval(expression)) as T;
}

function cursorState(): CursorDomState {
  return (window as typeof window & { __y_space_agent_cursor_state__: CursorDomState })
    .__y_space_agent_cursor_state__;
}

function isolatedCursorState(): Required<
  Pick<CursorDomState, "identity" | "hostId" | "host" | "feedback">
> &
  CursorDomState {
  const stateKey = Object.getOwnPropertyNames(window).find((key) =>
    key.startsWith("__y_space_agent_cursor_state_"),
  );
  if (!stateKey) throw new Error("isolated cursor state missing");
  return (window as unknown as Record<string, CursorDomState>)[stateKey] as Required<
    Pick<CursorDomState, "identity" | "hostId" | "host" | "feedback">
  > &
    CursorDomState;
}

async function installIsolatedCursor(
  cdp: CdpSession,
): Promise<ReturnType<typeof isolatedCursorState>> {
  await expect(setCursorOverlayVisible(cdp, true)).resolves.toBe(true);
  const state = isolatedCursorState();
  await evaluate(
    cursorGlideExpr({ x: 140, y: 70, kind: "element" }, 0, "hover", undefined, {
      identity: {
        mainDocumentIdentity: "4:main:13:loader-main-1",
        hostId: state.hostId,
        stateKey: state.identity,
      },
    }),
  );
  return isolatedCursorState();
}

function evaluatingCdp(): CdpSession {
  return {
    send: vi.fn<
      (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
    >(async (method, params) => {
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: "main", loaderId: "loader-main-1" } } };
      }
      if (method === "Page.createIsolatedWorld") return { executionContextId: 41 };
      if (method !== "Runtime.evaluate") return {};
      if (params?.contextId !== 41) throw new Error("main-world evaluation rejected");
      const mainWorldIntrinsics = {
        querySelectorAll: Document.prototype.querySelectorAll,
        createElement: Document.prototype.createElement,
        remove: Element.prototype.remove,
        appendChild: Node.prototype.appendChild,
        getComputedStyle: window.getComputedStyle,
      };
      Object.defineProperty(Document.prototype, "querySelectorAll", {
        configurable: true,
        writable: true,
        value: isolatedQuerySelectorAll,
      });
      Object.defineProperty(Document.prototype, "createElement", {
        configurable: true,
        writable: true,
        value: isolatedCreateElement,
      });
      Object.defineProperty(Element.prototype, "remove", {
        configurable: true,
        writable: true,
        value: isolatedRemove,
      });
      Object.defineProperty(Node.prototype, "appendChild", {
        configurable: true,
        writable: true,
        value: isolatedAppendChild,
      });
      Object.defineProperty(window, "getComputedStyle", {
        configurable: true,
        writable: true,
        value: trustedGetComputedStyle,
      });
      try {
        const value = await window.eval(String(params?.expression ?? ""));
        return { result: { type: typeof value, value } };
      } finally {
        Object.defineProperty(Document.prototype, "querySelectorAll", {
          configurable: true,
          writable: true,
          value: mainWorldIntrinsics.querySelectorAll,
        });
        Object.defineProperty(Document.prototype, "createElement", {
          configurable: true,
          writable: true,
          value: mainWorldIntrinsics.createElement,
        });
        Object.defineProperty(Element.prototype, "remove", {
          configurable: true,
          writable: true,
          value: mainWorldIntrinsics.remove,
        });
        Object.defineProperty(Node.prototype, "appendChild", {
          configurable: true,
          writable: true,
          value: mainWorldIntrinsics.appendChild,
        });
        Object.defineProperty(window, "getComputedStyle", {
          configurable: true,
          writable: true,
          value: mainWorldIntrinsics.getComputedStyle,
        });
      }
    }),
  } as unknown as CdpSession;
}

afterEach(() => {
  vi.useRealTimers();
  trustedGetComputedStyle = isolatedGetComputedStyle;
  Object.defineProperty(Document.prototype, "querySelectorAll", {
    configurable: true,
    writable: true,
    value: isolatedQuerySelectorAll,
  });
  Object.defineProperty(Document.prototype, "createElement", {
    configurable: true,
    writable: true,
    value: isolatedCreateElement,
  });
  Object.defineProperty(Element.prototype, "remove", {
    configurable: true,
    writable: true,
    value: isolatedRemove,
  });
  Object.defineProperty(Node.prototype, "appendChild", {
    configurable: true,
    writable: true,
    value: isolatedAppendChild,
  });
  Object.defineProperty(window, "getComputedStyle", {
    configurable: true,
    writable: true,
    value: isolatedGetComputedStyle,
  });
  Object.defineProperty(CSSStyleDeclaration.prototype, "getPropertyValue", {
    configurable: true,
    writable: true,
    value: isolatedGetPropertyValue,
  });
  if (isolatedMatchesDescriptor) {
    Object.defineProperty(Element.prototype, "matches", isolatedMatchesDescriptor);
  }
  if (isolatedShowPopoverDescriptor) {
    Object.defineProperty(HTMLElement.prototype, "showPopover", isolatedShowPopoverDescriptor);
  } else {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).showPopover;
  }
  if (isolatedHidePopoverDescriptor) {
    Object.defineProperty(HTMLElement.prototype, "hidePopover", isolatedHidePopoverDescriptor);
  } else {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).hidePopover;
  }
  if (isolatedShowModalDescriptor) {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", isolatedShowModalDescriptor);
  } else {
    delete (HTMLDialogElement.prototype as unknown as Record<string, unknown>).showModal;
  }
  if (isolatedDialogCloseDescriptor) {
    Object.defineProperty(HTMLDialogElement.prototype, "close", isolatedDialogCloseDescriptor);
  } else {
    delete (HTMLDialogElement.prototype as unknown as Record<string, unknown>).close;
  }
  document.body.replaceChildren();
  document.getElementById("__y_space_screenshot_cursor_hide__")?.remove();
  document.getElementById("__y_space_session_cursor_hide__")?.remove();
  delete (window as typeof window & { __y_space_agent_cursor_state__?: CursorDomState })
    .__y_space_agent_cursor_state__;
  for (const key of Object.getOwnPropertyNames(window)) {
    if (key.startsWith("__y_space_agent_cursor_state_")) {
      delete (window as unknown as Record<string, unknown>)[key];
    }
  }
});

describe("Y Space cursor DOM lifecycle", () => {
  it("accepts Chromium transform serialization without making the reset immutable", async () => {
    installBrowserPrimitives(false);
    Object.defineProperty(CSSStyleDeclaration.prototype, "getPropertyValue", {
      configurable: true,
      writable: true,
      value: function (this: CSSStyleDeclaration, property: string): string {
        const value = Reflect.apply(isolatedGetPropertyValue, this, [property]);
        if (property !== "transform") return value;
        const match = /^translate3d\(([^,]+),\s*([^,]+),\s*0\)$/u.exec(value);
        return match ? `translate3d(${match[1]}, ${match[2]}, 0px)` : value;
      },
    });

    // This test targets Chromium's transform serialization, not the production
    // 250 ms transport deadline. Give a parallel full-suite worker enough time
    // to reach evaluation even when the host is saturated.
    const expression = cursorGlideExpr({ x: 140, y: 70, kind: "element" }, 0, "hover", undefined, {
      deadlineEpochMs: Date.now() + 5_000,
    });
    const moved = await evaluate<{ ok: boolean; x?: number; y?: number; reason?: string }>(
      expression,
    );

    expect(expression).not.toContain("all:initial!important");
    expect(moved).toMatchObject({ ok: true, x: 140, y: 70 });
    expect(cursorState().host.style.getPropertyPriority("transform")).toBe("important");
    expect(cursorState().host.style.getPropertyValue("transform")).toBe(
      "translate3d(140px, 70px, 0px)",
    );
  });

  it("keeps one inert closed-shadow overlay and reuses the exact resolved point", async () => {
    installBrowserPrimitives(false);
    addTarget();

    const first = await evaluate<{ ok: boolean; x: number; y: number }>(
      cursorGlideExpr({ x: 140, y: 70, kind: "element" }, 0, "click"),
    );
    const hostileState = cursorState() as CursorDomState & {
      target?: Element;
      targetKind?: string;
    };
    Object.assign(hostileState, { target: document.body, targetKind: "viewport" });
    const second = await evaluate<{ ok: boolean; x: number; y: number }>(
      cursorGlideExpr({ x: 140, y: 70, kind: "element" }, 0, "hover"),
    );
    await evaluate(cursorFeedbackExpr(second, "click"));

    const hosts = document.querySelectorAll("#__y_space_agent_cursor__");
    const host = hosts.item(0) as HTMLElement;
    expect(first).toMatchObject({ ok: true, x: 140, y: 70, kind: "element" });
    expect(second).toMatchObject({ ok: true, x: 140, y: 70, kind: "element" });
    expect(hosts).toHaveLength(1);
    expect(host.shadowRoot).toBeNull();
    expect(host.getAttribute("aria-hidden")).toBe("true");
    expect(host.getAttribute("popover")).toBe("manual");
    expect(host.matches(":popover-open")).toBe(true);
    expect(host.style.pointerEvents).toBe("none");
    expect(host.style.transform).toBe("translate3d(140px,70px,0)");
    expect(cursorState().host).toBe(host);
    expect(cursorState().feedback.id).toBe("__y_space_agent_cursor_feedback__");
    expect(hostileState.target).toBe(document.body);
    expect(hostileState.targetKind).toBe("viewport");
  });

  it("promotes its manual popover above modal top-layer entries before every path check", async () => {
    const topLayer = installBrowserPrimitives(false);
    const firstDialog = document.createElement("dialog");
    document.body.appendChild(firstDialog);
    firstDialog.showModal();
    const operationToken = "modal-top-layer-order";
    const identity = {
      mainDocumentIdentity: "direct-expression",
      hostId: "__y_space_agent_cursor__",
      stateKey: "__y_space_agent_cursor_state__",
    };

    await expect(
      evaluate<{ ok: boolean }>(
        cursorGlideExpr({ x: 140, y: 70, kind: "element" }, 0, "click", undefined, {
          identity,
          operationToken,
        }),
      ),
    ).resolves.toMatchObject({ ok: true });
    const host = cursorState().host;
    expect(topLayer.order).toEqual([firstDialog, host]);

    const laterDialog = document.createElement("dialog");
    document.body.appendChild(laterDialog);
    laterDialog.showModal();
    expect(topLayer.order.at(-1)).toBe(laterDialog);

    await expect(
      evaluate<{ ok: boolean }>(cursorPathVerificationExpr(identity, operationToken)),
    ).resolves.toEqual({ ok: true });
    expect(topLayer.order).toEqual([firstDialog, laterDialog, host]);
    expect(host.matches(":popover-open")).toBe(true);
  });

  it("fails closed when the manual popover API is unavailable", async () => {
    installBrowserPrimitives(false);
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).showPopover;
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).hidePopover;

    await expect(
      evaluate<{ ok: boolean; reason?: string }>(
        cursorGlideExpr({ x: 140, y: 70, kind: "element" }, 0, "click"),
      ),
    ).resolves.toEqual({ ok: false, reason: "cursor-overlay-unverified" });
    expect(document.querySelector("#__y_space_agent_cursor__")).toBeNull();
  });

  it("uses a trusted document-scoped origin instead of page-spoofed visual state", async () => {
    installBrowserPrimitives(false);
    addTarget();
    await evaluate(cursorGlideExpr({ x: 140, y: 70, kind: "element" }, 0, "hover"));
    const state = cursorState() as CursorDomState & { x?: number; y?: number };
    state.x = -50_000;
    state.y = 50_000;

    const moved = await evaluate<{ startX: number; startY: number; x: number; y: number }>(
      cursorGlideExpr({ x: 300, y: 200, kind: "element" }, 0, "hover", { x: 449.5, y: 349.5 }),
    );

    expect(moved).toMatchObject({ startX: 449.5, startY: 349.5, x: 300, y: 200 });
  });

  it("fails verification when a hostile MutationObserver removes the exact host", async () => {
    installBrowserPrimitives(false);
    const observer = new MutationObserver(() => {
      document
        .querySelectorAll<HTMLElement>('[id^="__y_space_agent_cursor_"]')
        .forEach((host) => host.remove());
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    const moved = await evaluate<{ ok: boolean; reason?: string }>(
      cursorGlideExpr({ x: 140, y: 70, kind: "element" }, 0, "click"),
    );

    observer.disconnect();
    expect(moved).toEqual({ ok: false, reason: "cursor-overlay-unverified" });
    expect(document.querySelector('[id^="__y_space_agent_cursor_"]')).toBeNull();
  });

  it("fails verification when a hostile MutationObserver makes the exact host invisible", async () => {
    installBrowserPrimitives(false);
    const observer = new MutationObserver(() => {
      const host = document.querySelector<HTMLElement>('[id^="__y_space_agent_cursor_"]');
      if (!host) return;
      observer.disconnect();
      host.style.setProperty("opacity", "0", "important");
      host.style.setProperty("overflow", "hidden", "important");
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    const moved = await evaluate<{ ok: boolean; reason?: string }>(
      cursorGlideExpr({ x: 140, y: 70, kind: "element" }, 0, "click"),
    );

    observer.disconnect();
    expect(moved).toEqual({ ok: false, reason: "cursor-overlay-unverified" });
    expect(document.querySelector("#__y_space_agent_cursor__")).toBeNull();
  });

  it("detects a hostile page removing the verified host after the glide starts", async () => {
    installBrowserPrimitives(false);
    const operationToken = "hostile-path-removal";
    const identity = {
      mainDocumentIdentity: "direct-expression",
      hostId: "__y_space_agent_cursor__",
      stateKey: "__y_space_agent_cursor_state__",
    };
    await evaluate(
      cursorGlideExpr({ x: 140, y: 70, kind: "element" }, 180, "click", undefined, {
        identity,
        operationToken,
      }),
    );

    await expect(
      evaluate<{ ok: boolean }>(cursorPathVerificationExpr(identity, operationToken)),
    ).resolves.toEqual({ ok: true });
    cursorState().host.remove();
    await expect(
      evaluate<{ ok: boolean }>(cursorPathVerificationExpr(identity, operationToken)),
    ).resolves.toEqual({ ok: false });
  });

  it("fails a path check when the page cancels top-layer re-promotion", async () => {
    installBrowserPrimitives(false);
    const operationToken = "hostile-popover-cancellation";
    const identity = {
      mainDocumentIdentity: "direct-expression",
      hostId: "__y_space_agent_cursor__",
      stateKey: "__y_space_agent_cursor_state__",
    };
    await expect(
      evaluate<{ ok: boolean }>(
        cursorGlideExpr({ x: 140, y: 70, kind: "element" }, 0, "click", undefined, {
          identity,
          operationToken,
        }),
      ),
    ).resolves.toMatchObject({ ok: true });
    const host = cursorState().host;
    host.addEventListener("beforetoggle", (event) => {
      if ((event as Event & { newState?: string }).newState === "open") event.preventDefault();
    });

    await expect(
      evaluate<{ ok: boolean }>(cursorPathVerificationExpr(identity, operationToken)),
    ).resolves.toEqual({ ok: false });
    expect(host.matches(":popover-open")).toBe(false);
  });

  it("cannot resume into late visible motion after its renderer deadline", async () => {
    vi.useFakeTimers();
    installBrowserPrimitives(false);
    let resumePaint: FrameRequestCallback | undefined;
    Object.defineProperty(window, "requestAnimationFrame", {
      configurable: true,
      writable: true,
      value: (callback: FrameRequestCallback) => {
        resumePaint = callback;
        return 1;
      },
    });
    const deadlineEpochMs = Date.now() + 100;
    const move = evaluate<{ ok: boolean; reason?: string }>(
      cursorGlideExpr({ x: 140, y: 70, kind: "element" }, 180, "hover", undefined, {
        deadlineEpochMs,
      }),
    );

    await vi.advanceTimersByTimeAsync(150);
    resumePaint?.(150);
    await expect(move).resolves.toEqual({ ok: false, reason: "cursor-overlay-unverified" });
    expect(document.querySelector("#__y_space_agent_cursor__")).toBeNull();
  });

  it("places directly and uses one restrained timer for reduced motion", async () => {
    vi.useFakeTimers();
    installBrowserPrimitives(true);
    addTarget();

    const target = await evaluate<{ ok: boolean; x: number; y: number }>(
      cursorGlideExpr({ x: 140, y: 70, kind: "element" }, 180, "text"),
    );
    await evaluate(cursorFeedbackExpr(target, "text"));

    expect(cursorState().host.style.transition).toBe("none");
    expect(cursorState().feedback.style.opacity).toBe("1");
    await vi.advanceTimersByTimeAsync(200);
    expect(cursorState().feedback.style.opacity).toBe("0");
    expect(document.querySelectorAll("#__y_space_agent_cursor__")).toHaveLength(1);
  });

  it("ignores page-spoofed screenshot state and restores its exact isolated host", async () => {
    installBrowserPrimitives(false);
    const cdp = evaluatingCdp();
    const state = await installIsolatedCursor(cdp);
    const beforeToggle = vi.fn<(event: Event) => void>();
    state.host.addEventListener("beforetoggle", beforeToggle);
    const spoof = document.createElement("div");
    spoof.id = "__y_space_screenshot_cursor_hide__";
    document.head.appendChild(spoof);

    await withCursorOverlayHidden(cdp, async () => {
      expect(getComputedStyle(state.host).visibility).toBe("hidden");
      expect(state.host.matches(":popover-open")).toBe(true);
      expect(state.screenshotOwners?.[0]).toContain("y-space-screenshot-");
      expect(document.getElementById("__y_space_screenshot_cursor_hide__")).toBe(spoof);
    });

    expect(getComputedStyle(state.host).visibility).not.toBe("hidden");
    expect(state.host.matches(":popover-open")).toBe(true);
    expect(state.screenshotOwners).toEqual([]);
    expect(document.getElementById("__y_space_screenshot_cursor_hide__")).toBe(spoof);
    expect(beforeToggle).not.toHaveBeenCalled();
  });

  it("rejects screenshot restoration when the page closes the top-layer host", async () => {
    installBrowserPrimitives(false);
    const cdp = evaluatingCdp();
    const state = await installIsolatedCursor(cdp);

    await expect(
      withCursorOverlayHidden(cdp, async () => {
        state.host.hidePopover();
        return "image";
      }),
    ).rejects.toThrow("could not restore cursor visibility");
    expect(state.host.matches(":popover-open")).toBe(false);
  });

  it("keeps session visibility in isolated state and confirms exact-host hide/show", async () => {
    installBrowserPrimitives(false);
    const cdp = evaluatingCdp();
    const state = await installIsolatedCursor(cdp);
    const beforeToggle = vi.fn<(event: Event) => void>();
    state.host.addEventListener("beforetoggle", beforeToggle);
    const spoof = document.createElement("div");
    spoof.id = "__y_space_session_cursor_hide__";
    document.head.appendChild(spoof);

    await expect(setCursorOverlayVisible(cdp, false)).resolves.toBe(true);
    expect(state.sessionHidden).toBe(true);
    expect(getComputedStyle(state.host).visibility).toBe("hidden");
    expect(state.host.matches(":popover-open")).toBe(true);
    expect(document.getElementById("__y_space_session_cursor_hide__")).toBe(spoof);
    expect(beforeToggle).not.toHaveBeenCalled();

    await expect(setCursorOverlayVisible(cdp, true)).resolves.toBe(true);
    expect(state.sessionHidden).toBe(false);
    expect(getComputedStyle(state.host).visibility).not.toBe("hidden");
    expect(state.host.matches(":popover-open")).toBe(true);
    expect(document.getElementById("__y_space_session_cursor_hide__")).toBe(spoof);
    expect(beforeToggle).not.toHaveBeenCalled();
  });

  it("does not report a page-closed top-layer host as session-visible", async () => {
    installBrowserPrimitives(false);
    const cdp = evaluatingCdp();
    const state = await installIsolatedCursor(cdp);
    state.host.hidePopover();

    await expect(setCursorOverlayVisible(cdp, true)).resolves.toBe(false);
    expect(state.host.matches(":popover-open")).toBe(false);
  });

  it("ignores hostile main-world prototype patches while replacing spoofed hide styles", async () => {
    installBrowserPrimitives(false);
    const cdp = evaluatingCdp();
    await installIsolatedCursor(cdp);
    for (const id of ["__y_space_screenshot_cursor_hide__", "__y_space_session_cursor_hide__"]) {
      const spoof = document.createElement("div");
      spoof.id = id;
      document.head.appendChild(spoof);
    }
    const hostile = vi.fn<() => never>(() => {
      throw new Error("hostile main-world DOM hook");
    });
    Object.defineProperty(Document.prototype, "querySelectorAll", {
      configurable: true,
      writable: true,
      value: hostile,
    });
    Object.defineProperty(Document.prototype, "createElement", {
      configurable: true,
      writable: true,
      value: hostile,
    });
    Object.defineProperty(Element.prototype, "remove", {
      configurable: true,
      writable: true,
      value: hostile,
    });
    Object.defineProperty(Node.prototype, "appendChild", {
      configurable: true,
      writable: true,
      value: hostile,
    });
    Object.defineProperty(window, "getComputedStyle", {
      configurable: true,
      writable: true,
      value: hostile,
    });
    await expect(withCursorOverlayHidden(cdp, async () => "image")).resolves.toBe("image");
    await expect(setCursorOverlayVisible(cdp, false)).resolves.toBe(true);
    await expect(setCursorOverlayVisible(cdp, true)).resolves.toBe(true);

    expect(hostile).not.toHaveBeenCalled();
  });
});

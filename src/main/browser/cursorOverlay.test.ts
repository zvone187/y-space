import { afterEach, describe, expect, it, vi } from "vitest";
import type { CdpSession } from "./cdp/cdpClient";
import {
  cursorFeedbackExpr,
  cursorGlideExpr,
  completeCursorAction,
  confirmCursorTarget,
  dispatchNativeFocus,
  dispatchNativeKey,
  dispatchNativeSelect,
  dispatchNativeText,
  dispatchNativeToggle,
  dispatchPointerClick,
  dispatchPointerWheel,
  glideCursorToSelector,
  setCursorOverlayVisible,
  type NativeSelectMenuKey,
  type NativeSelectMenuKeyDispatcher,
  withCursorOverlayHidden,
} from "./cursorOverlay";

type RuntimeEvaluateResponse = { result: { type: string; value: unknown } };
type Send = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;

function createCdp(events: string[], expressions: string[], hideResult = true): CdpSession {
  return {
    send: vi.fn<Send>(async (method, params) => {
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: "main", loaderId: "loader-main-1" } } };
      }
      if (method === "Page.createIsolatedWorld") return { executionContextId: 41 };
      const expression = String(params?.expression ?? "");
      expressions.push(expression);
      if (expression.includes('const phase="hide"')) {
        events.push("hide");
        return {
          result: {
            type: "object",
            value: {
              ok: hideResult,
              tokenOwned: hideResult,
              hostCount: 1,
              hiddenHostCount: hideResult ? 1 : 0,
            },
          },
        };
      }
      if (expression.includes('const phase="restore"')) {
        events.push("restore");
        return {
          result: {
            type: "object",
            value: {
              ok: true,
              tokenOwned: false,
              screenshotOwnerCount: 0,
              sessionOwned: false,
              hostCount: 1,
              visibleHostCount: 1,
            },
          },
        };
      }
      if (expression.includes('const phase="session-hide"')) {
        events.push("session-hide");
        return {
          result: {
            type: "object",
            value: {
              ok: true,
              sessionOwned: true,
              screenshotOwnerCount: 0,
              hostCount: 1,
              hiddenHostCount: 1,
              visibleHostCount: 0,
            },
          },
        };
      }
      if (expression.includes('const phase="session-show"')) {
        events.push("session-show");
        return {
          result: {
            type: "object",
            value: {
              ok: true,
              sessionOwned: false,
              screenshotOwnerCount: 0,
              hostCount: 1,
              hiddenHostCount: 0,
              visibleHostCount: 1,
            },
          },
        };
      }
      events.push("restore");
      return { result: { type: "boolean", value: true } };
    }),
  } as unknown as CdpSession;
}

interface SecureTargetCdpOptions {
  onSend?: (method: string, params?: Record<string, unknown>) => void;
  onNativeMenuKey?: (key: NativeSelectMenuKey) => void;
  connected?: boolean | (() => boolean);
  disabled?: boolean;
  visible?: boolean;
  hitBackendNodeId?: number | (() => number);
  hitIsDescendant?: boolean;
  hitRelation?: "descendant" | "interactive-descendant" | "label" | "none";
  movedTo?: { x: number; y: number };
  point?: () => { x: number; y: number };
  viewportPage?: () => { x: number; y: number };
  viewportHeight?: number;
  movedAfterFirstClickTo?: { x: number; y: number };
  reducedMotion?: boolean;
  start?: { x: number; y: number };
  stallPress?: boolean;
  rejectPress?: boolean;
  rejectWheel?: boolean;
  rejectKeyDown?: boolean;
  rejectKeyUpAttempts?: number;
  rejectReleaseAttempts?: number;
  focusApplies?: boolean;
  editable?: boolean;
  textLengthBefore?: number;
  textMatches?: boolean;
  checkedBefore?: boolean;
  checkedAfter?: boolean;
  toggleType?: "checkbox" | "radio";
  selectCurrentIndex?: number;
  selectTargetIndex?: number;
  selectEnabledSteps?: number;
  selectTargetValue?: string;
  selectTargetText?: string;
  selectMatches?: boolean;
  selectRequiresPopupSequence?: boolean;
  selectPopupOpens?: boolean;
  disconnectAfterFirstClick?: boolean;
  frameId?: string | (() => string | undefined);
  loaderId?: string | (() => string | undefined);
  rejectMove?: boolean;
  stallMove?: boolean;
  evaluateMove?: () => Promise<Record<string, unknown>>;
  cursorPathVisible?: boolean | (() => boolean);
  rejectNodeForLocation?: boolean;
  stallNodeForLocation?: boolean;
  pointHitRelation?: "target" | "descendant" | "interactive-descendant" | "label" | "none";
  rejectPointHitRelation?: boolean;
  stallPointHitRelation?: boolean;
}

function boxModelAt(x: number, y: number): Record<string, unknown> {
  return {
    model: {
      border: [x - 40, y - 20, x + 40, y - 20, x + 40, y + 20, x - 40, y + 20],
      content: [x - 40, y - 20, x + 40, y - 20, x + 40, y + 20, x - 40, y + 20],
      padding: [x - 40, y - 20, x + 40, y - 20, x + 40, y + 20, x - 40, y + 20],
      margin: [x - 40, y - 20, x + 40, y - 20, x + 40, y + 20, x - 40, y + 20],
      width: 80,
      height: 40,
    },
  };
}

function createSecureTargetCdp(options: SecureTargetCdpOptions = {}): {
  cdp: CdpSession;
  send: ReturnType<typeof vi.fn>;
  dispatchNativeMenuKey: ReturnType<typeof vi.fn<NativeSelectMenuKeyDispatcher>>;
} {
  const targetBackendNodeId = 700;
  let rejectedKeyDown = false;
  let rejectedKeyUps = 0;
  let rejectedReleases = 0;
  let checkedReads = 0;
  let firstClickReleased = false;
  let selectPopupOpen = false;
  let selectPopupNavigationSteps = 0;
  let selectPopupCommitted = false;
  const dispatchNativeMenuKey = vi.fn<NativeSelectMenuKeyDispatcher>(async (key) => {
    options.onNativeMenuKey?.(key);
    if (options.selectRequiresPopupSequence) {
      if (selectPopupOpen && key === "Home") {
        selectPopupNavigationSteps = 0;
      } else if (selectPopupOpen && key === "ArrowDown") {
        selectPopupNavigationSteps += 1;
      } else if (selectPopupOpen && key === "Enter") {
        selectPopupCommitted = selectPopupNavigationSteps === (options.selectEnabledSteps ?? 1);
        selectPopupOpen = false;
      } else if (key === "Escape") {
        selectPopupOpen = false;
      }
    }
    return { status: "completed" };
  });
  const send = vi.fn<
    (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
  >(async (method, params) => {
    options.onSend?.(method, params);
    if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
    if (method === "DOM.querySelector") return { nodeId: 7 };
    if (method === "DOM.describeNode") {
      return { node: { nodeId: 7, backendNodeId: targetBackendNodeId, nodeName: "BUTTON" } };
    }
    if (method === "Page.getFrameTree") {
      const frameId =
        typeof options.frameId === "function" ? options.frameId() : (options.frameId ?? "main");
      const loaderId =
        typeof options.loaderId === "function"
          ? options.loaderId()
          : (options.loaderId ?? "loader-main-1");
      return {
        frameTree: {
          frame: { id: frameId, loaderId, url: "https://example.test/" },
        },
      };
    }
    if (method === "Page.createIsolatedWorld") return { executionContextId: 41 };
    if (method === "DOM.resolveNode") {
      const backendNodeId = Number(params?.backendNodeId);
      return { object: { objectId: backendNodeId === targetBackendNodeId ? "target" : "hit" } };
    }
    if (method === "Runtime.callFunctionOn") {
      const functionDeclaration = String(params?.functionDeclaration ?? "");
      const args = Array.isArray(params?.arguments) ? params.arguments : [];
      if (functionDeclaration.includes("elementFromPoint")) {
        if (options.stallPointHitRelation) {
          return await new Promise<Record<string, unknown>>(() => {});
        }
        if (options.rejectPointHitRelation) throw new Error("isolated hit test rejected");
        return {
          result: {
            type: "string",
            value: options.pointHitRelation ?? "target",
          },
        };
      }
      if (functionDeclaration.includes("isContentEditable")) {
        if (functionDeclaration.includes("endsWith")) {
          return { result: { type: "boolean", value: options.textMatches !== false } };
        }
        return {
          result: {
            type: "object",
            value: {
              active: options.focusApplies !== false,
              editable: options.editable !== false,
              length: options.textLengthBefore ?? 0,
            },
          },
        };
      }
      if (functionDeclaration.includes("checked")) {
        const checked =
          checkedReads++ === 0 ? options.checkedBefore === true : (options.checkedAfter ?? true);
        return {
          result: {
            type: "object",
            value: { ok: true, checked, type: options.toggleType ?? "checkbox" },
          },
        };
      }
      if (functionDeclaration.includes("enabledSteps")) {
        return {
          result: {
            type: "object",
            value: {
              ok: true,
              currentIndex: options.selectCurrentIndex ?? 0,
              targetIndex: options.selectTargetIndex ?? 3,
              enabledSteps: options.selectEnabledSteps ?? 1,
              targetValue: options.selectTargetValue ?? "target",
              targetText: options.selectTargetText ?? "Target option",
            },
          },
        };
      }
      if (functionDeclaration.includes('":open"')) {
        return {
          result: {
            type: "boolean",
            value: options.selectRequiresPopupSequence
              ? selectPopupOpen
              : options.selectPopupOpens !== false,
          },
        };
      }
      if (functionDeclaration.includes("selectedIndex")) {
        return {
          result: {
            type: "boolean",
            value: options.selectRequiresPopupSequence
              ? selectPopupCommitted
              : options.selectMatches !== false,
          },
        };
      }
      if (functionDeclaration.includes("activeElement")) {
        return { result: { type: "boolean", value: options.focusApplies !== false } };
      }
      if (args.length > 0) {
        return {
          result: {
            type: "string",
            value:
              options.hitRelation ?? (options.hitIsDescendant === true ? "descendant" : "none"),
          },
        };
      }
      return {
        result: {
          type: "object",
          value: {
            connected:
              (typeof options.connected === "function"
                ? options.connected()
                : options.connected) !== false,
            ...(options.disconnectAfterFirstClick && firstClickReleased
              ? { connected: false }
              : {}),
            disabled: options.disabled === true,
            visible: options.visible !== false,
          },
        },
      };
    }
    if (method === "Runtime.releaseObject") return {};
    if (method === "DOM.scrollIntoViewIfNeeded") return {};
    if (method === "DOM.getBoxModel") {
      const point =
        firstClickReleased && options.movedAfterFirstClickTo
          ? options.movedAfterFirstClickTo
          : (options.point?.() ?? options.movedTo ?? { x: 140, y: 70 });
      return boxModelAt(point.x, point.y);
    }
    if (method === "Page.getLayoutMetrics") {
      const page = options.viewportPage?.() ?? { x: 0, y: 0 };
      return {
        cssLayoutViewport: {
          pageX: page.x,
          pageY: page.y,
          clientWidth: 900,
          clientHeight: options.viewportHeight ?? 700,
        },
      };
    }
    if (method === "DOM.getNodeForLocation") {
      if (options.stallNodeForLocation) {
        return await new Promise<Record<string, unknown>>(() => {});
      }
      if (options.rejectNodeForLocation) throw new Error("No node found at given location");
      const hitBackendNodeId =
        typeof options.hitBackendNodeId === "function"
          ? options.hitBackendNodeId()
          : (options.hitBackendNodeId ?? targetBackendNodeId);
      return { backendNodeId: hitBackendNodeId, frameId: "main" };
    }
    if (
      method === "Input.dispatchMouseEvent" &&
      params?.type === "mouseMoved" &&
      options.stallMove
    ) {
      return await new Promise<Record<string, unknown>>(() => {});
    }
    if (
      method === "Input.dispatchMouseEvent" &&
      params?.type === "mouseMoved" &&
      options.rejectMove
    ) {
      throw new Error("pointer move transport rejected");
    }
    if (
      method === "Input.dispatchMouseEvent" &&
      params?.type === "mousePressed" &&
      options.stallPress
    ) {
      return await new Promise<Record<string, unknown>>(() => {});
    }
    if (
      method === "Input.dispatchMouseEvent" &&
      params?.type === "mousePressed" &&
      options.rejectPress
    ) {
      throw new Error("press transport rejected");
    }
    if (
      method === "Input.dispatchMouseEvent" &&
      params?.type === "mouseWheel" &&
      options.rejectWheel
    ) {
      throw new Error("wheel transport rejected");
    }
    if (
      method === "Input.dispatchKeyEvent" &&
      (params?.type === "keyDown" || params?.type === "rawKeyDown") &&
      options.rejectKeyDown &&
      !rejectedKeyDown
    ) {
      rejectedKeyDown = true;
      throw new Error("key transport rejected");
    }
    if (
      method === "Input.dispatchMouseEvent" &&
      params?.type === "mouseReleased" &&
      rejectedReleases < (options.rejectReleaseAttempts ?? 0)
    ) {
      rejectedReleases += 1;
      throw new Error("release transport rejected");
    }
    if (
      method === "Input.dispatchKeyEvent" &&
      params?.type === "keyUp" &&
      rejectedKeyUps < (options.rejectKeyUpAttempts ?? 0)
    ) {
      rejectedKeyUps += 1;
      throw new Error("key-up transport rejected");
    }
    if (
      method === "Input.dispatchKeyEvent" &&
      (params?.type === "keyDown" || params?.type === "rawKeyDown") &&
      options.selectRequiresPopupSequence
    ) {
      const key = String(params?.key ?? "");
      if (selectPopupOpen && key === "Home") {
        selectPopupNavigationSteps = 0;
      } else if (selectPopupOpen && key === "ArrowDown") {
        selectPopupNavigationSteps += 1;
      } else if (selectPopupOpen && key === "Enter") {
        selectPopupCommitted = selectPopupNavigationSteps === (options.selectEnabledSteps ?? 1);
        selectPopupOpen = false;
      }
    }
    if (
      method === "Input.dispatchMouseEvent" &&
      params?.type === "mouseReleased" &&
      params?.clickCount === 1
    ) {
      firstClickReleased = true;
      if (options.selectRequiresPopupSequence) {
        selectPopupOpen = options.selectPopupOpens !== false;
        selectPopupNavigationSteps = 0;
      }
    }
    if (method === "Runtime.evaluate") {
      const expression = String(params?.expression ?? "");
      if (expression.includes("cancelled:__ysCancelCursorMove")) {
        return { result: { type: "object", value: { ok: true, cancelled: true } } };
      }
      if (expression.includes('const phase="path-verify"')) {
        const visible =
          typeof options.cursorPathVisible === "function"
            ? options.cursorPathVisible()
            : options.cursorPathVisible !== false;
        return { result: { type: "object", value: { ok: visible } } };
      }
      if (!expression.includes('const phase="move"')) {
        throw new Error("main-world state must not authorize input");
      }
      if (options.evaluateMove) return await options.evaluateMove();
      const point = options.point?.() ?? options.movedTo ?? { x: 140, y: 70 };
      return {
        result: {
          type: "object",
          value: {
            ok: true,
            x: point.x,
            y: point.y,
            startX: options.start?.x ?? 40,
            startY: options.start?.y ?? 30,
            kind: "element",
            reducedMotion: options.reducedMotion !== false,
          },
        },
      };
    }
    return {};
  });
  return { cdp: { send } as unknown as CdpSession, send, dispatchNativeMenuKey };
}

function secureElementTarget(): {
  mainDocumentIdentity: string;
  x: number;
  y: number;
  kind: "element";
  nativeMoved: boolean;
  backendNodeId: number;
  executionContextId: number;
} {
  return {
    mainDocumentIdentity: "4:main:13:loader-main-1",
    x: 140,
    y: 70,
    kind: "element",
    nativeMoved: true,
    backendNodeId: 700,
    executionContextId: 41,
  };
}

afterEach(() => vi.useRealTimers());

describe("withCursorOverlayHidden", () => {
  it("hides presence visuals during capture and restores them afterward", async () => {
    const events: string[] = [];
    const expressions: string[] = [];
    const cdp = createCdp(events, expressions);

    await expect(
      withCursorOverlayHidden(cdp, async () => {
        events.push("capture");
        return "image";
      }),
    ).resolves.toBe("image");

    expect(events).toEqual(["hide", "capture", "restore"]);
    expect(expressions[0]).toContain("state.screenshotOwners");
    expect(expressions[0]).toContain('"visibility","hidden","important"');
  });

  it("restores presence visuals when capture fails", async () => {
    const events: string[] = [];
    const cdp = createCdp(events, []);

    await expect(
      withCursorOverlayHidden(cdp, async () => {
        events.push("capture");
        throw new Error("capture failed");
      }),
    ).rejects.toThrow("capture failed");

    expect(events).toEqual(["hide", "capture", "restore"]);
  });

  it("preserves a capture rejection whose reason is undefined and still restores", async () => {
    const events: string[] = [];
    const cdp = createCdp(events, []);

    await expect(
      withCursorOverlayHidden(cdp, async () => {
        events.push("capture");
        return await Promise.reject(undefined);
      }),
    ).rejects.toThrow("undefined");

    expect(events).toEqual(["hide", "capture", "restore"]);
  });

  it("fails closed when the page overlay cannot be hidden", async () => {
    const events: string[] = [];
    const cdp = {
      send: vi.fn<Send>(async (method) => {
        if (method === "Page.getFrameTree") {
          return { frameTree: { frame: { id: "main", loaderId: "loader-main-1" } } };
        }
        if (method === "Page.createIsolatedWorld") return { executionContextId: 41 };
        events.push("hide-failed");
        throw new Error("page detached");
      }),
    } as unknown as CdpSession;

    await expect(
      withCursorOverlayHidden(cdp, async () => {
        events.push("capture");
        return "image";
      }),
    ).rejects.toThrow("cursor exclusion");

    expect(events).toEqual(["hide-failed", "hide-failed"]);
  });

  it("fails closed without starting capture when hide evaluation stalls", async () => {
    vi.useFakeTimers();
    const cdp = {
      send: vi.fn<Send>((method) => {
        if (method === "Page.getFrameTree") {
          return Promise.resolve({
            frameTree: { frame: { id: "main", loaderId: "loader-main-1" } },
          });
        }
        if (method === "Page.createIsolatedWorld") {
          return Promise.resolve({ executionContextId: 41 });
        }
        return new Promise<RuntimeEvaluateResponse>(() => {});
      }),
    } as unknown as CdpSession;
    const capture = vi.fn<() => Promise<string>>().mockResolvedValue("image");

    const result = withCursorOverlayHidden(cdp, capture);
    const capturedError = result.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(300);

    await expect(capturedError).resolves.toEqual(
      expect.objectContaining({ message: expect.stringContaining("cursor exclusion") }),
    );
    expect(capture).not.toHaveBeenCalled();
  });

  it("reports a stalled restore instead of leaving cursor state ambiguous", async () => {
    vi.useFakeTimers();
    let evaluation = 0;
    const cdp = {
      send: vi.fn<Send>(async (method) => {
        if (method === "Page.getFrameTree") {
          return { frameTree: { frame: { id: "main", loaderId: "loader-main-1" } } };
        }
        if (method === "Page.createIsolatedWorld") return { executionContextId: 41 };
        evaluation += 1;
        if (evaluation === 1) {
          return {
            result: {
              type: "object",
              value: { ok: true, tokenOwned: true, hostCount: 1, hiddenHostCount: 1 },
            },
          };
        }
        return await new Promise<RuntimeEvaluateResponse>(() => {});
      }),
    } as unknown as CdpSession;

    const result = withCursorOverlayHidden(cdp, async () => "image");
    const capturedError = result.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(600);

    await expect(capturedError).resolves.toEqual(
      expect.objectContaining({ message: expect.stringContaining("restore cursor visibility") }),
    );
  });

  it("retries an idempotent restore once before reporting a stuck hidden cursor", async () => {
    let evaluation = 0;
    const cdp = {
      send: vi.fn<Send>(async (method, params) => {
        if (method === "Page.getFrameTree") {
          return { frameTree: { frame: { id: "main", loaderId: "loader-main-1" } } };
        }
        if (method === "Page.createIsolatedWorld") return { executionContextId: 41 };
        evaluation += 1;
        if (evaluation === 1 || evaluation === 3) {
          const expression = String(params?.expression ?? "");
          return {
            result: {
              type: "object",
              value: expression.includes('const phase="hide"')
                ? { ok: true, tokenOwned: true, hostCount: 1, hiddenHostCount: 1 }
                : {
                    ok: true,
                    tokenOwned: false,
                    screenshotOwnerCount: 0,
                    sessionOwned: false,
                    hostCount: 1,
                    visibleHostCount: 1,
                  },
            },
          };
        }
        throw new Error("first restore transport rejected");
      }),
    } as unknown as CdpSession;

    await expect(withCursorOverlayHidden(cdp, async () => "image")).resolves.toBe("image");
    expect(evaluation).toBe(3);
  });

  it("keeps nested captures hidden until the final restore", async () => {
    const events: string[] = [];
    const cdp = createCdp(events, []);

    await withCursorOverlayHidden(cdp, async () => {
      events.push("outer-capture-start");
      await withCursorOverlayHidden(cdp, async () => {
        events.push("inner-capture");
      });
      events.push("outer-capture-end");
    });

    expect(events).toEqual([
      "hide",
      "outer-capture-start",
      "hide",
      "inner-capture",
      "restore",
      "outer-capture-end",
      "restore",
    ]);
  });

  it("uses the isolated world and proves computed host visibility despite a hostile main world", async () => {
    const evaluations: Array<Record<string, unknown>> = [];
    const send = vi.fn<Send>(async (method, params) => {
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: "main", loaderId: "loader-main-1" } } };
      }
      if (method === "Page.createIsolatedWorld") return { executionContextId: 41 };
      if (method !== "Runtime.evaluate") return {};
      evaluations.push(params ?? {});
      if (params?.contextId !== 41) {
        throw new Error("hostile main-world Runtime.evaluate trap");
      }
      const expression = String(params.expression ?? "");
      return {
        result: {
          type: "object",
          value: expression.includes('const phase="hide"')
            ? { ok: true, tokenOwned: true, hostCount: 2, hiddenHostCount: 2 }
            : {
                ok: true,
                tokenOwned: false,
                screenshotOwnerCount: 0,
                sessionOwned: false,
                hostCount: 2,
                visibleHostCount: 2,
              },
        },
      };
    });

    await expect(
      withCursorOverlayHidden({ send } as unknown as CdpSession, async () => "image"),
    ).resolves.toBe("image");

    expect(evaluations).toHaveLength(2);
    expect(evaluations.every((params) => params.contextId === 41)).toBe(true);
    const hideExpression = String(evaluations[0]?.expression ?? "");
    const restoreExpression = String(evaluations[1]?.expression ?? "");
    expect(hideExpression).toContain("state.screenshotOwners");
    expect(hideExpression).toContain("getComputedStyle");
    expect(hideExpression).toContain("hiddenHostCount");
    expect(restoreExpression).toContain("tokenOwned");
    expect(restoreExpression).toContain("visibleHostCount");
  });
});

describe("setCursorOverlayVisible", () => {
  it("persists session visibility in the isolated cursor state", async () => {
    const expressions: string[] = [];
    const cdp = createCdp([], expressions);

    await expect(setCursorOverlayVisible(cdp, false)).resolves.toBe(true);
    await expect(setCursorOverlayVisible(cdp, true)).resolves.toBe(true);

    expect(expressions[0]).toContain("state.sessionHidden=true");
    expect(expressions[0]).toContain('"visibility",state.sessionHidden');
    expect(expressions[0]).toContain("getComputedStyle");
    expect(expressions[1]).toContain("state.sessionHidden=false");
    expect(expressions[1]).toContain("sessionOwned");
    expect(
      (cdp.send as ReturnType<typeof vi.fn>).mock.calls
        .filter(([method]) => method === "Runtime.evaluate")
        .every(([, params]) => params?.contextId === 41),
    ).toBe(true);
  });

  it("returns false when the visibility change cannot be confirmed", async () => {
    const cdp = {
      send: vi.fn<Send>(async () => {
        throw new Error("page detached");
      }),
    } as unknown as CdpSession;

    await expect(setCursorOverlayVisible(cdp, false)).resolves.toBe(false);
  });
});

describe("Y Space agent cursor contract", () => {
  const presentationPoint = { x: 140, y: 70, kind: "element" as const };

  it("keeps page overlay state presentation-only and retains CDP backend identity", async () => {
    const { cdp, send } = createSecureTargetCdp();

    const target = await glideCursorToSelector(cdp, "#target", "click");
    const moveExpression = send.mock.calls
      .filter(([method]) => method === "Runtime.evaluate")
      .map(([, params]) => String(params?.expression ?? ""))
      .find((expression) => expression.includes('const phase="move"'));

    expect(target).toMatchObject({
      mainDocumentIdentity: "4:main:13:loader-main-1",
      x: 140,
      y: 70,
      kind: "element",
      backendNodeId: 700,
      executionContextId: 41,
    });
    expect(send).toHaveBeenCalledWith("DOM.scrollIntoViewIfNeeded", { backendNodeId: 700 });
    expect(moveExpression).not.toContain("document.querySelector");
    expect(moveExpression).not.toContain("state.target");
    const moveEvaluation = send.mock.calls.find(
      ([method, params]) =>
        method === "Runtime.evaluate" &&
        String(params?.expression ?? "").includes('const phase="move"'),
    );
    expect(moveEvaluation?.[1]?.contextId).toBe(41);
    expect(moveExpression).toMatch(/__y_space_agent_cursor_state_[a-f0-9]{32}__/);
  });

  it("cleans a timed-out overlay move immediately and again when its response resumes late", async () => {
    vi.useFakeTimers();
    let resumeMove: ((value: Record<string, unknown>) => void) | undefined;
    const lateMove = new Promise<Record<string, unknown>>((resolve) => {
      resumeMove = resolve;
    });
    const { cdp, send } = createSecureTargetCdp({ evaluateMove: () => lateMove });

    const result = glideCursorToSelector(cdp, "#target", "click");
    await vi.advanceTimersByTimeAsync(300);
    await expect(result).resolves.toBeNull();
    expect(
      send.mock.calls.filter(
        ([method, params]) =>
          method === "Runtime.evaluate" &&
          String(params?.expression ?? "").includes("cancelled:__ysCancelCursorMove"),
      ),
    ).toHaveLength(1);
    expect(
      send.mock.calls.some(
        ([method, params]) =>
          method === "Input.dispatchMouseEvent" && params?.type === "mouseMoved",
      ),
    ).toBe(false);

    resumeMove?.({
      result: {
        type: "object",
        value: {
          ok: true,
          x: 140,
          y: 70,
          startX: 449.5,
          startY: 349.5,
          kind: "element",
          reducedMotion: true,
        },
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(
      send.mock.calls.filter(
        ([method, params]) =>
          method === "Runtime.evaluate" &&
          String(params?.expression ?? "").includes("cancelled:__ysCancelCursorMove"),
      ),
    ).toHaveLength(2);
  });

  it("suppresses completion feedback when navigation races isolated-world selection", async () => {
    let identityRead = 0;
    const { cdp, send } = createSecureTargetCdp({
      loaderId: () => (identityRead++ === 0 ? "loader-main-1" : "loader-main-2"),
    });

    await completeCursorAction(cdp, secureElementTarget(), "click", {}, () => true);

    expect(
      send.mock.calls.some(
        ([method, params]) =>
          method === "Runtime.evaluate" &&
          String(params?.expression ?? "").includes('const phase="complete"'),
      ),
    ).toBe(false);
  });

  it("rejects native input when the target's trusted main document changed", async () => {
    const { cdp, send } = createSecureTargetCdp({ loaderId: "loader-main-2" });

    await expect(dispatchPointerClick(cdp, secureElementTarget())).resolves.toEqual({
      status: "failed",
      reason: "target-document-changed",
    });
    expect(
      send.mock.calls.some(
        ([method, params]) =>
          method === "Input.dispatchMouseEvent" && params?.type === "mousePressed",
      ),
    ).toBe(false);
  });

  it("reuses one isolated cursor world per live CDP session", async () => {
    const { cdp, send } = createSecureTargetCdp();

    await expect(glideCursorToSelector(cdp, "#first", "hover")).resolves.not.toBeNull();
    await expect(glideCursorToSelector(cdp, "#second", "hover")).resolves.not.toBeNull();

    expect(
      send.mock.calls.filter(([method]) => method === "Page.createIsolatedWorld"),
    ).toHaveLength(1);
  });

  it("releases a DOM.resolveNode object group when the timed-out response arrives late", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const send = vi.fn<
      (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
    >(async (method) => {
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") return { nodeId: 7 };
      if (method === "DOM.describeNode") {
        return { node: { nodeId: 7, backendNodeId: 700, nodeName: "BUTTON" } };
      }
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: "main", loaderId: "loader-main-1" } } };
      }
      if (method === "Page.createIsolatedWorld") return { executionContextId: 41 };
      if (method === "DOM.resolveNode") {
        return await new Promise<Record<string, unknown>>((resolve) => {
          setTimeout(() => {
            events.push("late-resolve");
            resolve({ object: { objectId: "late-target" } });
          }, 900);
        });
      }
      if (method === "Runtime.releaseObjectGroup") {
        events.push("release-group");
        return {};
      }
      return {};
    });
    const cdp = { send } as unknown as CdpSession;

    const result = glideCursorToSelector(cdp, "#target", "click");
    await vi.advanceTimersByTimeAsync(800);
    await expect(result).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(150);

    expect(send).toHaveBeenCalledWith(
      "DOM.resolveNode",
      expect.objectContaining({ objectGroup: expect.stringContaining("y-space-agent-cursor") }),
    );
    expect(events).toEqual(expect.arrayContaining(["late-resolve", "release-group"]));
    expect(events.lastIndexOf("release-group")).toBeGreaterThan(events.indexOf("late-resolve"));
  });

  it("performs the final native move before the CDP hit-test and never moves after it", async () => {
    const { cdp, send } = createSecureTargetCdp();
    const target = await glideCursorToSelector(cdp, "#target", "click");
    expect(target).not.toBeNull();

    await expect(dispatchPointerClick(cdp, target!)).resolves.toEqual({ status: "completed" });

    const calls = send.mock.calls.map(([method, params]) => ({ method, type: params?.type }));
    const hitTestIndex = calls.findIndex(({ method }) => method === "DOM.getNodeForLocation");
    const moveIndexes = calls.flatMap(({ method, type }, index) =>
      method === "Input.dispatchMouseEvent" && type === "mouseMoved" ? [index] : [],
    );
    expect(hitTestIndex).toBeGreaterThan(moveIndexes.at(-1)!);
    expect(
      calls
        .slice(hitTestIndex + 1)
        .some(({ method, type }) => method === "Input.dispatchMouseEvent" && type === "mouseMoved"),
    ).toBe(false);
    expect(
      send.mock.calls.some(
        ([method, params]) =>
          method === "Runtime.callFunctionOn" &&
          String(params?.functionDeclaration ?? "").includes("elementFromPoint"),
      ),
    ).toBe(false);
  });

  it("falls back to the isolated intrinsic hit test when Electron's guest CDP has no node", async () => {
    const { cdp, send } = createSecureTargetCdp({ rejectNodeForLocation: true });

    await expect(dispatchPointerClick(cdp, secureElementTarget())).resolves.toEqual({
      status: "completed",
    });

    const fallback = send.mock.calls.find(
      ([method, params]) =>
        method === "Runtime.callFunctionOn" &&
        String(params?.functionDeclaration ?? "").includes("elementFromPoint"),
    );
    expect(fallback?.[1]).toMatchObject({
      objectId: "target",
      arguments: [{ value: 140 }, { value: 70 }],
      userGesture: false,
    });
    expect(String(fallback?.[1]?.functionDeclaration ?? "")).toContain(
      "Document.prototype.elementFromPoint",
    );
    expect(
      send.mock.calls.some(
        ([method, params]) =>
          method === "Runtime.evaluate" &&
          String(params?.expression ?? "").includes("elementFromPoint"),
      ),
    ).toBe(false);
    expect(send).toHaveBeenCalledWith(
      "Input.dispatchMouseEvent",
      expect.objectContaining({ type: "mousePressed", x: 140, y: 70 }),
    );
    expect(send).toHaveBeenCalledWith("Runtime.releaseObject", { objectId: "target" });
    expect(send).toHaveBeenCalledWith(
      "Runtime.releaseObjectGroup",
      expect.objectContaining({ objectGroup: expect.stringContaining("y-space-agent-cursor") }),
    );
  });

  it.each(["descendant", "label"] as const)(
    "accepts an isolated intrinsic %s relation when guest CDP has no node",
    async (pointHitRelation) => {
      const { cdp } = createSecureTargetCdp({ rejectNodeForLocation: true, pointHitRelation });

      await expect(dispatchPointerClick(cdp, secureElementTarget())).resolves.toEqual({
        status: "completed",
      });
    },
  );

  it.each([
    ["occluder", "none", "target-occluded"],
    ["interactive descendant", "interactive-descendant", "target-interactive-descendant"],
  ] as const)(
    "fails closed when the guest-compatible hit test finds an %s",
    async (_label, pointHitRelation, reason) => {
      const { cdp, send } = createSecureTargetCdp({
        rejectNodeForLocation: true,
        pointHitRelation,
      });

      await expect(dispatchPointerClick(cdp, secureElementTarget())).resolves.toEqual({
        status: "failed",
        reason,
      });
      expect(
        send.mock.calls.some(
          ([method, params]) =>
            method === "Input.dispatchMouseEvent" && params?.type === "mousePressed",
        ),
      ).toBe(false);
    },
  );

  it("does not turn a timed-out browser-process hit test into isolated input authority", async () => {
    vi.useFakeTimers();
    const { cdp, send } = createSecureTargetCdp({ stallNodeForLocation: true });

    const result = dispatchPointerClick(cdp, secureElementTarget());
    await vi.advanceTimersByTimeAsync(800);

    await expect(result).resolves.toEqual({
      status: "failed",
      reason: "target-validation-timeout",
    });
    expect(
      send.mock.calls.some(
        ([method, params]) =>
          method === "Runtime.callFunctionOn" &&
          String(params?.functionDeclaration ?? "").includes("elementFromPoint"),
      ),
    ).toBe(false);
  });

  it("fails closed if the guest-compatible isolated hit test itself rejects", async () => {
    const { cdp, send } = createSecureTargetCdp({
      rejectNodeForLocation: true,
      rejectPointHitRelation: true,
    });

    await expect(dispatchPointerClick(cdp, secureElementTarget())).resolves.toEqual({
      status: "failed",
      reason: "target-validation-rejected",
    });
    expect(
      send.mock.calls.some(
        ([method, params]) =>
          method === "Input.dispatchMouseEvent" && params?.type === "mousePressed",
      ),
    ).toBe(false);
  });

  it("fails closed if the guest-compatible isolated hit test times out", async () => {
    vi.useFakeTimers();
    const { cdp, send } = createSecureTargetCdp({
      rejectNodeForLocation: true,
      stallPointHitRelation: true,
    });

    const result = dispatchPointerClick(cdp, secureElementTarget());
    await vi.advanceTimersByTimeAsync(800);

    await expect(result).resolves.toEqual({
      status: "failed",
      reason: "target-validation-timeout",
    });
    expect(
      send.mock.calls.some(
        ([method, params]) =>
          method === "Input.dispatchMouseEvent" && params?.type === "mousePressed",
      ),
    ).toBe(false);
  });

  it.each([
    ["removed", { connected: false }, "target-removed"],
    ["disabled", { disabled: true }, "target-disabled"],
    ["moved", { movedTo: { x: 170, y: 90 } }, "target-moved"],
    ["occluded", { hitBackendNodeId: 900 }, "target-occluded"],
  ] as const)("fails closed when the retained target is %s", async (_label, options, reason) => {
    const { cdp, send } = createSecureTargetCdp(options);

    await expect(dispatchPointerClick(cdp, secureElementTarget())).resolves.toEqual({
      status: "failed",
      reason,
    });
    expect(
      send.mock.calls.some(
        ([method, params]) =>
          method === "Input.dispatchMouseEvent" && params?.type === "mousePressed",
      ),
    ).toBe(false);
  });

  it("ignores a hostile page-state target swap and accepts a CDP-proven descendant", async () => {
    const { cdp, send } = createSecureTargetCdp({
      hitBackendNodeId: 701,
      hitIsDescendant: true,
    });

    await expect(dispatchPointerClick(cdp, secureElementTarget())).resolves.toEqual({
      status: "completed",
    });
    expect(send.mock.calls.some(([method]) => method === "Runtime.evaluate")).toBe(false);
    expect(send).toHaveBeenCalledWith(
      "Runtime.callFunctionOn",
      expect.objectContaining({
        objectId: "target",
        arguments: [{ objectId: "hit" }],
      }),
    );
  });

  it("rejects a separately interactive descendant instead of activating it", async () => {
    const { cdp, send } = createSecureTargetCdp({
      hitBackendNodeId: 701,
      hitRelation: "interactive-descendant",
    });

    await expect(dispatchPointerClick(cdp, secureElementTarget())).resolves.toEqual({
      status: "failed",
      reason: "target-interactive-descendant",
    });
    expect(
      send.mock.calls.some(
        ([method, params]) =>
          method === "Input.dispatchMouseEvent" && params?.type === "mousePressed",
      ),
    ).toBe(false);
  });

  it("checks effective visibility through composed ancestors", async () => {
    const { cdp, send } = createSecureTargetCdp();

    await expect(glideCursorToSelector(cdp, "#target", "click")).resolves.not.toBeNull();
    const stateDeclaration = send.mock.calls
      .filter(([method]) => method === "Runtime.callFunctionOn")
      .map(([, params]) => String(params?.functionDeclaration ?? ""))
      .find((declaration) => declaration.includes("connected:false"));

    expect(stateDeclaration).toContain("getRootNode");
    expect(stateDeclaration).toContain("ShadowRoot");
    expect(stateDeclaration).toContain("opacity");
  });

  it("uses the orange Y Space identity and removes the legacy Poracode overlay", () => {
    const expression = cursorGlideExpr(presentationPoint);

    expect(expression).toContain("__y_space_agent_cursor__");
    expect(expression).toContain("#ff5a1f");
    expect(expression).toContain("#ffffff");
    expect(expression).toContain('attachShadow.call(host,{mode:"closed"})');
    expect(expression).toContain("adoptedStyleSheets");
    expect(expression).toContain("createElementNS");
    expect(expression).not.toContain("pointer.innerHTML");
    expect(expression).not.toContain("contain:layout style paint");
    expect(expression).not.toContain("<circle");
    expect(expression).not.toContain("__poracode_cursor__");
    expect(expression).not.toContain("#7d6cf6");
  });

  it("respects reduced motion and reuses one bounded feedback surface", () => {
    const expression = cursorGlideExpr(presentationPoint);

    expect(expression).toContain("prefers-reduced-motion: reduce");
    expect(expression).toContain("__y_space_agent_cursor_feedback__");
    expect(expression).toContain('setAttribute("aria-hidden","true")');
    expect(expression).toContain("pointer-events:none");
    expect(expression).toContain("getAnimations.call(state.feedback).forEach");
    expect(expression).not.toContain('createElement("div"); d.setAttribute');
  });

  it("moves without claiming a click before the browser action completes", () => {
    const expression = cursorGlideExpr(presentationPoint);

    expect(expression).toContain('const phase="move"');
    expect(expression).toContain("state.sessionHidden=false");
    expect(expression).toContain("__ysCursorPainted");
    expect(expression).not.toContain("__pcRipple");
    expect(expression).not.toContain("data-poracode-cursor-ripple");
  });

  it("defines distinct completion feedback without allocating per-action surfaces", () => {
    const actions = [
      "click",
      "double-click",
      "text",
      "press",
      "toggle",
      "select",
      "scroll",
    ] as const;

    for (const action of actions) {
      const expression = cursorFeedbackExpr(
        { x: 120, y: 80 },
        action,
        action === "scroll" ? { deltaY: -100 } : {},
      );
      expect(expression).toContain('const phase="complete"');
      expect(expression).toContain(`const action="${action}"`);
      expect(expression.match(/id="__y_space_agent_cursor_feedback__"/g)).toHaveLength(1);
      expect(() => new Function(`return ${expression}`)).not.toThrow();
    }
  });

  it("dispatches native double-click input only after same-target hit-test", async () => {
    const { cdp, send } = createSecureTargetCdp();

    await expect(dispatchPointerClick(cdp, secureElementTarget(), 2)).resolves.toEqual({
      status: "completed",
    });
    expect(send.mock.calls.some(([method]) => method === "Runtime.evaluate")).toBe(false);
    const hitTestIndex = send.mock.calls.findIndex(
      ([method]) => method === "DOM.getNodeForLocation",
    );
    const firstPressIndex = send.mock.calls.findIndex(
      ([method, params]) =>
        method === "Input.dispatchMouseEvent" && params?.type === "mousePressed",
    );
    expect(firstPressIndex).toBeGreaterThan(hitTestIndex);

    expect(
      send.mock.calls
        .filter(([method]) => method === "Input.dispatchMouseEvent")
        .map(([, params]) => params),
    ).toEqual([
      {
        type: "mousePressed",
        x: 140,
        y: 70,
        button: "left",
        buttons: 1,
        clickCount: 1,
      },
      {
        type: "mouseReleased",
        x: 140,
        y: 70,
        button: "left",
        buttons: 0,
        clickCount: 1,
      },
      {
        type: "mousePressed",
        x: 140,
        y: 70,
        button: "left",
        buttons: 1,
        clickCount: 2,
      },
      {
        type: "mouseReleased",
        x: 140,
        y: 70,
        button: "left",
        buttons: 0,
        clickCount: 2,
      },
    ]);
  });

  it("does not send a second click when the retained target disappears after the first", async () => {
    const { cdp, send } = createSecureTargetCdp({ disconnectAfterFirstClick: true });

    await expect(dispatchPointerClick(cdp, secureElementTarget(), 2)).resolves.toEqual({
      status: "ambiguous",
      reason: "double-click-target-removed",
      partial: "single-click",
      clickDispatched: true,
    });
    expect(
      send.mock.calls.filter(
        ([method, params]) =>
          method === "Input.dispatchMouseEvent" && params?.type === "mousePressed",
      ),
    ).toHaveLength(1);
  });

  it("rechecks authorization before the second native press of a double-click", async () => {
    let authorized = true;
    const { cdp, send } = createSecureTargetCdp({
      onSend(method, params) {
        if (
          method === "Input.dispatchMouseEvent" &&
          params?.type === "mouseReleased" &&
          params?.clickCount === 1
        ) {
          authorized = false;
        }
      },
    });

    await expect(
      dispatchPointerClick(cdp, secureElementTarget(), 2, () => authorized),
    ).resolves.toEqual({
      status: "ambiguous",
      reason: "presentation-authorization-revoked",
      partial: "single-click",
      clickDispatched: true,
    });
    expect(
      send.mock.calls.filter(
        ([method, params]) =>
          method === "Input.dispatchMouseEvent" && params?.type === "mousePressed",
      ),
    ).toHaveLength(1);
  });

  it("reports a completed first click when the second press transport rejects", async () => {
    let presses = 0;
    const { cdp, send } = createSecureTargetCdp({
      onSend(method, params) {
        if (method === "Input.dispatchMouseEvent" && params?.type === "mousePressed") {
          presses += 1;
          if (presses === 2) throw new Error("second press transport rejected");
        }
      },
    });

    await expect(dispatchPointerClick(cdp, secureElementTarget(), 2)).resolves.toEqual({
      status: "ambiguous",
      reason: "pointer-press-rejected",
      partial: "at-least-one-click",
      clickDispatched: true,
    });
    expect(
      send.mock.calls
        .filter(([method]) => method === "Input.dispatchMouseEvent")
        .map(([, params]) => params?.type),
    ).toEqual(["mousePressed", "mouseReleased", "mousePressed", "mouseReleased"]);
  });

  it("installs the navigation latch before final click target validation", async () => {
    let notifyMainNavigation = (): void => undefined;
    const { cdp, send } = createSecureTargetCdp({
      onSend(method) {
        if (method === "DOM.getNodeForLocation") notifyMainNavigation();
      },
    });
    Object.assign(cdp, {
      on(method: string, handler: (params: unknown) => void) {
        if (method === "Page.frameNavigated") {
          notifyMainNavigation = () => handler({ frame: { id: "main" } });
        }
        return () => {
          notifyMainNavigation = (): void => undefined;
        };
      },
    });

    await expect(dispatchPointerClick(cdp, secureElementTarget())).resolves.toEqual({
      status: "failed",
      reason: "target-document-changed",
    });
    expect(
      send.mock.calls.some(
        ([method, params]) =>
          method === "Input.dispatchMouseEvent" && params?.type === "mousePressed",
      ),
    ).toBe(false);
  });

  it("rechecks the loader after final click target validation", async () => {
    let loaderId = "loader-main-1";
    const { cdp, send } = createSecureTargetCdp({
      loaderId: () => loaderId,
      onSend(method) {
        if (method === "DOM.getNodeForLocation") loaderId = "loader-main-2";
      },
    });

    await expect(dispatchPointerClick(cdp, secureElementTarget())).resolves.toEqual({
      status: "failed",
      reason: "target-document-changed",
    });
    expect(
      send.mock.calls.some(
        ([method, params]) =>
          method === "Input.dispatchMouseEvent" && params?.type === "mousePressed",
      ),
    ).toBe(false);
  });

  it("rechecks the loader after the second target validation of a double-click", async () => {
    let loaderId = "loader-main-1";
    let hitTests = 0;
    const { cdp, send } = createSecureTargetCdp({
      loaderId: () => loaderId,
      onSend(method) {
        if (method === "DOM.getNodeForLocation" && ++hitTests === 2) {
          loaderId = "loader-main-2";
        }
      },
    });

    await expect(dispatchPointerClick(cdp, secureElementTarget(), 2)).resolves.toEqual({
      status: "ambiguous",
      reason: "double-click-target-document-changed",
      partial: "single-click",
      clickDispatched: true,
    });
    expect(
      send.mock.calls
        .filter(([method]) => method === "Input.dispatchMouseEvent")
        .map(([, params]) => params?.type),
    ).toEqual(["mousePressed", "mouseReleased"]);
  });

  it("blocks mouse release when navigation is observed during its authorization", async () => {
    let notifyMainNavigation = (): void => undefined;
    const { cdp, send } = createSecureTargetCdp();
    Object.assign(cdp, {
      on(method: string, handler: (params: unknown) => void) {
        if (method === "Page.frameNavigated") {
          notifyMainNavigation = () => handler({ frame: { id: "main" } });
        }
        return () => {
          notifyMainNavigation = (): void => undefined;
        };
      },
    });
    let authorizationChecks = 0;

    await expect(
      dispatchPointerClick(cdp, secureElementTarget(), 1, () => {
        authorizationChecks += 1;
        if (authorizationChecks === 2) notifyMainNavigation();
        return true;
      }),
    ).resolves.toEqual({
      status: "ambiguous",
      reason: "target-document-changed",
    });
    expect(
      send.mock.calls
        .filter(([method]) => method === "Input.dispatchMouseEvent")
        .map(([, params]) => params?.type),
    ).toEqual(["mousePressed"]);
  });

  it("moves Chromium through the same bounded eased path as the visible cursor", async () => {
    const { cdp, send } = createSecureTargetCdp({
      reducedMotion: false,
      start: { x: 20, y: 20 },
    });

    const target = await glideCursorToSelector(cdp, "#moving-target", "hover");
    const points = send.mock.calls
      .filter(([method]) => method === "Input.dispatchMouseEvent")
      .map(([, params]) => ({ x: Number(params?.x), y: Number(params?.y) }));

    expect(target).toMatchObject({
      x: 140,
      y: 70,
      backendNodeId: 700,
      executionContextId: 41,
      nativeMoved: true,
    });
    expect(points).toHaveLength(8);
    expect(points[0]!.x).toBeLessThan(449.5);
    expect(points[0]!.x).toBeGreaterThan(140);
    expect(points.at(-1)).toEqual({ x: 140, y: 70 });
    expect(points.every((point, index) => index === 0 || point.x < points[index - 1]!.x)).toBe(
      true,
    );
  });

  it("corrects one viewport-only displacement while retaining the same document-space target", async () => {
    let pageY = 277;
    let mouseMoves = 0;
    const { cdp, send } = createSecureTargetCdp({
      reducedMotion: true,
      viewportHeight: 800,
      viewportPage: () => ({ x: 0, y: pageY }),
      point: () => ({ x: 285, y: 1_000 - pageY }),
      onSend(method, params) {
        if (method === "Input.dispatchMouseEvent" && params?.type === "mouseMoved") {
          mouseMoves += 1;
          if (mouseMoves === 1) pageY = 542;
        }
      },
    });

    const target = await glideCursorToSelector(cdp, "#target", "hover");
    expect(target).not.toBeNull();
    await expect(confirmCursorTarget(cdp, target!)).resolves.toEqual({ status: "completed" });

    expect(target).toMatchObject({ x: 285, y: 458, backendNodeId: 700 });
    expect(
      send.mock.calls
        .filter(
          ([method, params]) =>
            method === "Input.dispatchMouseEvent" && params?.type === "mouseMoved",
        )
        .map(([, params]) => ({ x: params?.x, y: params?.y })),
    ).toEqual([
      { x: 285, y: 723 },
      { x: 285, y: 458 },
    ]);
    expect(
      send.mock.calls.filter(
        ([method, params]) => method === "DOM.querySelector" && params?.selector === "#target",
      ),
    ).toHaveLength(1);
  });

  it("does not correct a target whose document-space center moved", async () => {
    let targetY = 723;
    let mouseMoves = 0;
    const { cdp, send } = createSecureTargetCdp({
      reducedMotion: true,
      viewportHeight: 800,
      viewportPage: () => ({ x: 0, y: 277 }),
      point: () => ({ x: 285, y: targetY }),
      onSend(method, params) {
        if (method === "Input.dispatchMouseEvent" && params?.type === "mouseMoved") {
          mouseMoves += 1;
          targetY = 458;
        }
      },
    });

    const target = await glideCursorToSelector(cdp, "#moving-target", "hover");
    expect(target).not.toBeNull();
    await expect(confirmCursorTarget(cdp, target!)).resolves.toEqual({
      status: "ambiguous",
      reason: "target-moved",
      partial: "pointer-move",
      clickDispatched: false,
    });
    expect(mouseMoves).toBe(1);
    expect(
      send.mock.calls.filter(
        ([method, params]) =>
          method === "Input.dispatchMouseEvent" && params?.type === "mouseMoved",
      ),
    ).toHaveLength(1);
  });

  it("caps viewport-only correction at one move when scroll anchoring continues", async () => {
    let pageY = 277;
    let mouseMoves = 0;
    const { cdp, send } = createSecureTargetCdp({
      reducedMotion: true,
      viewportHeight: 800,
      viewportPage: () => ({ x: 0, y: pageY }),
      point: () => ({ x: 285, y: 1_000 - pageY }),
      onSend(method, params) {
        if (method === "Input.dispatchMouseEvent" && params?.type === "mouseMoved") {
          mouseMoves += 1;
          pageY += 100;
        }
      },
    });

    const target = await glideCursorToSelector(cdp, "#target", "hover");
    expect(target).not.toBeNull();
    await expect(confirmCursorTarget(cdp, target!)).resolves.toEqual({
      status: "ambiguous",
      reason: "target-moved",
      partial: "pointer-move",
      clickDispatched: false,
    });
    expect(mouseMoves).toBe(2);
    expect(
      send.mock.calls.filter(
        ([method, params]) =>
          method === "Input.dispatchMouseEvent" && params?.type === "mouseMoved",
      ),
    ).toHaveLength(2);
  });

  it.each(["removed", "occluded"] as const)(
    "revalidates and rejects a %s target after viewport-only correction",
    async (finalState) => {
      let pageY = 277;
      let mouseMoves = 0;
      const { cdp, send } = createSecureTargetCdp({
        reducedMotion: true,
        viewportHeight: 800,
        viewportPage: () => ({ x: 0, y: pageY }),
        point: () => ({ x: 285, y: 1_000 - pageY }),
        connected: () => finalState !== "removed" || mouseMoves < 2,
        hitBackendNodeId: () => (finalState === "occluded" && mouseMoves >= 2 ? 900 : 700),
        onSend(method, params) {
          if (method === "Input.dispatchMouseEvent" && params?.type === "mouseMoved") {
            mouseMoves += 1;
            if (mouseMoves === 1) pageY = 542;
          }
        },
      });

      const target = await glideCursorToSelector(cdp, "#target", "hover");
      expect(target).not.toBeNull();
      await expect(confirmCursorTarget(cdp, target!)).resolves.toEqual({
        status: "ambiguous",
        reason: finalState === "removed" ? "target-removed" : "target-occluded",
        partial: "pointer-move",
        clickDispatched: false,
      });
      expect(mouseMoves).toBe(2);
      expect(
        send.mock.calls.some(
          ([method, params]) =>
            method === "Input.dispatchMouseEvent" && params?.type === "mousePressed",
        ),
      ).toBe(false);
    },
  );

  it("preserves the accepted hover when authorization is revoked before viewport correction", async () => {
    let authorized = true;
    let pageY = 277;
    const { cdp, send } = createSecureTargetCdp({
      reducedMotion: true,
      viewportHeight: 800,
      viewportPage: () => ({ x: 0, y: pageY }),
      point: () => ({ x: 285, y: 1_000 - pageY }),
      onSend(method, params) {
        if (method === "Input.dispatchMouseEvent" && params?.type === "mouseMoved") {
          pageY = 542;
        }
        if (
          method === "Runtime.evaluate" &&
          String(params?.expression ?? "").includes("scroll-correction-")
        ) {
          authorized = false;
        }
      },
    });

    const target = await glideCursorToSelector(cdp, "#target", "click", () => authorized);

    expect(target).toMatchObject({
      nativeMoved: false,
      nativeMoveAmbiguous: true,
      nativeMoveReason: "presentation-authorization-revoked",
      nativeMoveCompletedBeforeFailure: true,
    });
    if (!target) throw new Error("expected the partially moved cursor target");
    await expect(dispatchPointerClick(cdp, target)).resolves.toEqual({
      status: "ambiguous",
      reason: "presentation-authorization-revoked",
      partial: "pointer-move",
      clickDispatched: false,
    });
    expect(
      send.mock.calls
        .filter(([method]) => method === "Input.dispatchMouseEvent")
        .map(([, params]) => params?.type),
    ).toEqual(["mouseMoved"]);
    expect(
      send.mock.calls.filter(
        ([method, params]) =>
          method === "Runtime.evaluate" &&
          String(params?.expression ?? "").includes("cancelled:__ysCancelCursorMove"),
      ),
    ).toHaveLength(1);
  });

  it("stops the trusted pointer path when navigation replaces the document between samples", async () => {
    vi.useFakeTimers();
    let loaderId = "loader-main-1";
    let nativeMoves = 0;
    const { cdp, send } = createSecureTargetCdp({
      reducedMotion: false,
      loaderId: () => loaderId,
      onSend(method, params) {
        if (method === "Input.dispatchMouseEvent" && params?.type === "mouseMoved") {
          nativeMoves += 1;
          if (nativeMoves === 1) loaderId = "loader-main-2";
        }
      },
    });

    const pendingTarget = glideCursorToSelector(cdp, "#navigating-target", "click");
    await vi.advanceTimersByTimeAsync(500);
    const target = await pendingTarget;

    expect(target).toMatchObject({
      nativeMoved: false,
      nativeMoveAmbiguous: true,
      nativeMoveReason: "target-document-changed",
      nativeMoveCompletedBeforeFailure: true,
    });
    if (!target) throw new Error("expected the rejected cursor target");
    await expect(dispatchPointerClick(cdp, target)).resolves.toEqual({
      status: "ambiguous",
      reason: "target-document-changed",
      partial: "pointer-move",
      clickDispatched: false,
    });
    expect(
      send.mock.calls
        .filter(([method]) => method === "Input.dispatchMouseEvent")
        .map(([, params]) => params?.type),
    ).toEqual(["mouseMoved"]);
  });

  it("stops the pointer path when a hostile page removes the visible overlay after one sample", async () => {
    vi.useFakeTimers();
    let cursorPathVisible = true;
    let nativeMoves = 0;
    const { cdp, send } = createSecureTargetCdp({
      reducedMotion: false,
      cursorPathVisible: () => cursorPathVisible,
      onSend(method, params) {
        if (method === "Input.dispatchMouseEvent" && params?.type === "mouseMoved") {
          nativeMoves += 1;
          if (nativeMoves === 1) cursorPathVisible = false;
        }
      },
    });

    const pendingTarget = glideCursorToSelector(cdp, "#hostile-overlay-target", "click");
    await vi.advanceTimersByTimeAsync(500);
    const target = await pendingTarget;

    expect(target).toMatchObject({
      nativeMoved: false,
      nativeMoveAmbiguous: true,
      nativeMoveReason: "cursor-overlay-unavailable",
      nativeMoveCompletedBeforeFailure: true,
    });
    if (!target) throw new Error("expected the rejected cursor target");
    await expect(dispatchPointerClick(cdp, target)).resolves.toEqual({
      status: "ambiguous",
      reason: "cursor-overlay-unavailable",
      partial: "pointer-move",
      clickDispatched: false,
    });
    expect(
      send.mock.calls
        .filter(([method]) => method === "Input.dispatchMouseEvent")
        .map(([, params]) => params?.type),
    ).toEqual(["mouseMoved"]);
  });

  it("keeps visual and native path continuity within the same trusted main document", async () => {
    const movedTo = { x: 140, y: 70 };
    const { cdp, send } = createSecureTargetCdp({
      reducedMotion: false,
      movedTo,
      start: { x: -50_000, y: 50_000 },
    });

    await expect(glideCursorToSelector(cdp, "#first", "hover")).resolves.not.toBeNull();
    movedTo.x = 300;
    movedTo.y = 200;
    await expect(glideCursorToSelector(cdp, "#second", "hover")).resolves.not.toBeNull();

    const expressions = send.mock.calls
      .filter(
        ([method, params]) =>
          method === "Runtime.evaluate" &&
          String(params?.expression ?? "").includes('const phase="move"'),
      )
      .map(([, params]) => String(params?.expression ?? ""));
    expect(expressions).toHaveLength(2);
    expect(expressions[0]).toContain("const trustedStartX=449.5");
    expect(expressions[0]).toContain("const trustedStartY=349.5");
    expect(expressions[1]).toContain("const trustedStartX=140");
    expect(expressions[1]).toContain("const trustedStartY=70");
  });

  it("resets visual and native path origins when the trusted loader changes", async () => {
    let loaderId = "loader-a";
    const movedTo = { x: 140, y: 70 };
    const { cdp, send } = createSecureTargetCdp({
      reducedMotion: false,
      movedTo,
      loaderId: () => loaderId,
      start: { x: -50_000, y: 50_000 },
    });

    await expect(glideCursorToSelector(cdp, "#first", "hover")).resolves.not.toBeNull();
    loaderId = "loader-b";
    movedTo.x = 300;
    movedTo.y = 200;
    await expect(glideCursorToSelector(cdp, "#second", "hover")).resolves.not.toBeNull();

    const expressions = send.mock.calls
      .filter(
        ([method, params]) =>
          method === "Runtime.evaluate" &&
          String(params?.expression ?? "").includes('const phase="move"'),
      )
      .map(([, params]) => String(params?.expression ?? ""));
    expect(expressions[1]).toContain("const trustedStartX=449.5");
    expect(expressions[1]).toContain("const trustedStartY=349.5");

    const nativePoints = send.mock.calls
      .filter(
        ([method, params]) =>
          method === "Input.dispatchMouseEvent" && params?.type === "mouseMoved",
      )
      .map(([, params]) => ({ x: Number(params?.x), y: Number(params?.y) }));
    expect(nativePoints).toHaveLength(16);
    expect(nativePoints[8]!.x).toBeGreaterThan(300);
    expect(nativePoints[8]!.x).toBeLessThan(449.5);
    expect(nativePoints[8]!.y).toBeGreaterThan(200);
    expect(nativePoints[8]!.y).toBeLessThan(349.5);
  });

  it("ignores hostile page cursor coordinates and reuses only accepted native positions", async () => {
    const { cdp, send } = createSecureTargetCdp({
      reducedMotion: false,
      start: { x: -50_000, y: 50_000 },
    });

    await expect(glideCursorToSelector(cdp, "#target", "hover")).resolves.not.toBeNull();
    await expect(glideCursorToSelector(cdp, "#target", "hover")).resolves.not.toBeNull();
    const points = send.mock.calls
      .filter(
        ([method, params]) =>
          method === "Input.dispatchMouseEvent" && params?.type === "mouseMoved",
      )
      .map(([, params]) => ({ x: Number(params?.x), y: Number(params?.y) }));

    expect(points).toHaveLength(9);
    expect(points.every((point) => point.x >= 0 && point.x < 900)).toBe(true);
    expect(points.every((point) => point.y >= 0 && point.y < 700)).toBe(true);
    expect(points.at(-1)).toEqual({ x: 140, y: 70 });
  });

  it.each(["rejected", "timed-out"] as const)(
    "does not corrupt the last accepted document position when a move is %s",
    async (failure) => {
      const movedTo = { x: 140, y: 70 };
      const options: SecureTargetCdpOptions = { movedTo, reducedMotion: true };
      const { cdp, send } = createSecureTargetCdp(options);

      await expect(glideCursorToSelector(cdp, "#accepted", "hover")).resolves.not.toBeNull();
      movedTo.x = 300;
      movedTo.y = 200;
      if (failure === "rejected") options.rejectMove = true;
      else options.stallMove = true;

      if (failure === "timed-out") vi.useFakeTimers();
      const failedMove = glideCursorToSelector(cdp, "#failed", "hover");
      if (failure === "timed-out") await vi.advanceTimersByTimeAsync(350);
      const failedTarget = await failedMove;
      expect(failedTarget).toMatchObject({ nativeMoved: false, nativeMoveAmbiguous: true });
      if (!failedTarget) throw new Error("expected the ambiguous cursor target");
      await expect(dispatchPointerClick(cdp, failedTarget)).resolves.toEqual({
        status: "ambiguous",
        reason: failure === "timed-out" ? "pointer-move-timeout" : "pointer-move-rejected",
        clickDispatched: false,
      });
      options.rejectMove = false;
      options.stallMove = false;

      movedTo.x = 400;
      movedTo.y = 250;
      await expect(glideCursorToSelector(cdp, "#after-failure", "hover")).resolves.not.toBeNull();
      const expressions = send.mock.calls
        .filter(
          ([method, params]) =>
            method === "Runtime.evaluate" &&
            String(params?.expression ?? "").includes('const phase="move"'),
        )
        .map(([, params]) => String(params?.expression ?? ""));
      expect(expressions.at(-1)).toContain("const trustedStartX=140");
      expect(expressions.at(-1)).toContain("const trustedStartY=70");
    },
  );

  it("reports an ambiguous native press without claiming completion", async () => {
    vi.useFakeTimers();
    const { cdp, send } = createSecureTargetCdp({ stallPress: true });

    const result = dispatchPointerClick(cdp, secureElementTarget());
    await vi.advanceTimersByTimeAsync(800);

    await expect(result).resolves.toMatchObject({ status: "ambiguous" });
    expect(
      send.mock.calls
        .filter(([method]) => method === "Input.dispatchMouseEvent")
        .map(([, params]) => params?.type),
    ).toEqual(["mousePressed", "mouseReleased"]);
  });

  it("does not release a trusted press into a replacement document", async () => {
    let loaderId = "loader-main-1";
    const { cdp, send } = createSecureTargetCdp({
      loaderId: () => loaderId,
      onSend(method, params) {
        if (method === "Input.dispatchMouseEvent" && params?.type === "mousePressed") {
          loaderId = "loader-main-2";
        }
      },
    });

    await expect(dispatchPointerClick(cdp, secureElementTarget())).resolves.toEqual({
      status: "ambiguous",
      reason: "target-document-changed",
    });
    expect(
      send.mock.calls
        .filter(([method]) => method === "Input.dispatchMouseEvent")
        .map(([, params]) => params?.type),
    ).toEqual(["mousePressed"]);
  });

  it("preserves authorization revocation after a trusted press started", async () => {
    let authorized = true;
    const { cdp, send } = createSecureTargetCdp({
      onSend(method, params) {
        if (method === "Input.dispatchMouseEvent" && params?.type === "mousePressed") {
          authorized = false;
        }
      },
    });

    await expect(
      dispatchPointerClick(cdp, secureElementTarget(), 1, () => authorized),
    ).resolves.toEqual({
      status: "ambiguous",
      reason: "presentation-authorization-revoked",
    });
    expect(
      send.mock.calls
        .filter(([method]) => method === "Input.dispatchMouseEvent")
        .map(([, params]) => params?.type),
    ).toEqual(["mousePressed", "mouseReleased"]);
  });

  it("releases a rejected native press and reports the sequence as ambiguous", async () => {
    const { cdp, send } = createSecureTargetCdp({ rejectPress: true });

    await expect(dispatchPointerClick(cdp, secureElementTarget())).resolves.toEqual({
      status: "ambiguous",
      reason: "pointer-press-rejected",
    });
    expect(
      send.mock.calls
        .filter(([method]) => method === "Input.dispatchMouseEvent")
        .map(([, params]) => params?.type),
    ).toEqual(["mousePressed", "mouseReleased"]);
  });

  it("retries a rejected mouse release once when cleaning up an ambiguous press", async () => {
    const { cdp, send } = createSecureTargetCdp({
      rejectPress: true,
      rejectReleaseAttempts: 1,
    });

    await expect(dispatchPointerClick(cdp, secureElementTarget())).resolves.toEqual({
      status: "ambiguous",
      reason: "pointer-press-rejected",
    });
    expect(
      send.mock.calls.filter(
        ([method, params]) =>
          method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased",
      ),
    ).toHaveLength(2);
  });

  it("treats a rejected native wheel as ambiguous because it may have scrolled", async () => {
    const { cdp } = createSecureTargetCdp({ rejectWheel: true });

    await expect(dispatchPointerWheel(cdp, secureElementTarget(), 0, 180)).resolves.toEqual({
      status: "ambiguous",
      reason: "pointer-wheel-rejected",
    });
  });

  it("rejects an occluded or moved target before any press", async () => {
    const { cdp, send } = createSecureTargetCdp({ hitBackendNodeId: 900 });

    await expect(dispatchPointerClick(cdp, secureElementTarget())).resolves.toEqual({
      status: "failed",
      reason: "target-occluded",
    });
    expect(send.mock.calls.some(([method]) => method === "Input.dispatchMouseEvent")).toBe(false);
  });

  it("uses trusted CDP text and key input instead of DOM mutation", async () => {
    const { cdp, send } = createSecureTargetCdp();
    const target = secureElementTarget();

    await expect(
      dispatchNativeText(cdp, "#field", target, "hello", { replace: true, submit: true }),
    ).resolves.toEqual({ status: "completed" });
    await expect(dispatchNativeKey(cdp, "#field", target, "Escape")).resolves.toEqual({
      status: "completed",
    });

    expect(send).toHaveBeenCalledWith("Input.insertText", { text: "hello" });
    expect(send).toHaveBeenCalledWith("DOM.focus", { backendNodeId: 700 });
    const selectAllDown = send.mock.calls.find(
      ([method, params]) =>
        method === "Input.dispatchKeyEvent" &&
        params?.key === "a" &&
        (params?.type === "keyDown" || params?.type === "rawKeyDown"),
    )?.[1];
    expect(selectAllDown).toMatchObject({
      type: "rawKeyDown",
      commands: ["selectAll"],
    });
    expect(selectAllDown).not.toHaveProperty("text");
    expect(
      send.mock.calls.filter(
        ([method, params]) => method === "DOM.querySelector" && params?.selector === "#field",
      ),
    ).toHaveLength(0);
    expect(
      send.mock.calls.filter(([method]) => method === "Input.dispatchKeyEvent").length,
    ).toBeGreaterThanOrEqual(8);
  });

  it("reports targeted press as ambiguous when DOM focus may have fired before verification", async () => {
    const { cdp, send } = createSecureTargetCdp({ focusApplies: false });

    await expect(
      dispatchNativeKey(cdp, "#field", secureElementTarget(), "Escape"),
    ).resolves.toEqual({
      status: "ambiguous",
      reason: "focus-did-not-apply",
    });
    expect(send).toHaveBeenCalledWith("DOM.focus", { backendNodeId: 700 });
    expect(send.mock.calls.some(([method]) => method === "Input.dispatchKeyEvent")).toBe(false);
  });

  it("reports focus as ambiguous when DOM focus may have fired before verification", async () => {
    const { cdp, send } = createSecureTargetCdp({ focusApplies: false });

    await expect(dispatchNativeFocus(cdp, "#field", secureElementTarget())).resolves.toEqual({
      status: "ambiguous",
      reason: "focus-did-not-apply",
    });
    expect(send).toHaveBeenCalledWith("DOM.focus", { backendNodeId: 700 });
  });

  it("reports targeted press as ambiguous when authorization changes after DOM focus", async () => {
    let authorized = true;
    const { cdp, send } = createSecureTargetCdp({
      onSend(method) {
        if (method === "DOM.focus") authorized = false;
      },
    });

    await expect(
      dispatchNativeKey(cdp, "#field", secureElementTarget(), "Escape", {}, () => authorized),
    ).resolves.toEqual({
      status: "ambiguous",
      reason: "presentation-authorization-revoked",
    });
    expect(send).toHaveBeenCalledWith("DOM.focus", { backendNodeId: 700 });
    expect(send.mock.calls.some(([method]) => method === "Input.dispatchKeyEvent")).toBe(false);
  });

  it("releases a rejected key-down and reports native input as ambiguous", async () => {
    const { cdp, send } = createSecureTargetCdp({ rejectKeyDown: true });

    await expect(
      dispatchNativeKey(cdp, "#field", secureElementTarget(), "Escape"),
    ).resolves.toEqual({
      status: "ambiguous",
      reason: "key-down-rejected",
    });
    expect(send).toHaveBeenCalledWith(
      "Input.dispatchKeyEvent",
      expect.objectContaining({ type: "keyUp", key: "Escape" }),
    );
  });

  it("does not release a trusted key-down into a replacement document", async () => {
    let loaderId = "loader-main-1";
    const { cdp, send } = createSecureTargetCdp({
      loaderId: () => loaderId,
      onSend(method, params) {
        if (
          method === "Input.dispatchKeyEvent" &&
          (params?.type === "keyDown" || params?.type === "rawKeyDown")
        ) {
          loaderId = "loader-main-2";
        }
      },
    });

    await expect(
      dispatchNativeKey(cdp, "#field", secureElementTarget(), "Escape"),
    ).resolves.toEqual({
      status: "ambiguous",
      reason: "target-document-changed",
    });
    expect(
      send.mock.calls
        .filter(([method]) => method === "Input.dispatchKeyEvent")
        .map(([, params]) => params?.type),
    ).toEqual(["rawKeyDown"]);
  });

  it("preserves authorization revocation after a trusted key-down started", async () => {
    let authorized = true;
    const { cdp, send } = createSecureTargetCdp({
      onSend(method, params) {
        if (
          method === "Input.dispatchKeyEvent" &&
          (params?.type === "keyDown" || params?.type === "rawKeyDown")
        ) {
          authorized = false;
        }
      },
    });

    await expect(
      dispatchNativeKey(cdp, "#field", secureElementTarget(), "Escape", {}, () => authorized),
    ).resolves.toEqual({
      status: "ambiguous",
      reason: "presentation-authorization-revoked",
    });
    expect(
      send.mock.calls
        .filter(([method]) => method === "Input.dispatchKeyEvent")
        .map(([, params]) => params?.type),
    ).toEqual(["rawKeyDown", "keyUp"]);
  });

  it("retries key-up once when the first cleanup release is rejected", async () => {
    const { cdp, send } = createSecureTargetCdp({ rejectKeyUpAttempts: 1 });

    await expect(
      dispatchNativeKey(cdp, "#field", secureElementTarget(), "Escape"),
    ).resolves.toEqual({ status: "ambiguous", reason: "key-up-rejected" });
    expect(
      send.mock.calls.filter(
        ([method, params]) => method === "Input.dispatchKeyEvent" && params?.type === "keyUp",
      ),
    ).toHaveLength(2);
  });

  it("refuses to type when the exact focused target is not editable", async () => {
    const { cdp, send } = createSecureTargetCdp({ editable: false });

    await expect(
      dispatchNativeText(cdp, "#field", secureElementTarget(), "hello", {
        replace: true,
        submit: false,
      }),
    ).resolves.toEqual({ status: "failed", reason: "text-target-not-editable" });
    expect(send).not.toHaveBeenCalledWith("Input.insertText", { text: "hello" });
    expect(
      send.mock.calls.some(
        ([method, params]) =>
          method === "Input.dispatchMouseEvent" && params?.type === "mousePressed",
      ),
    ).toBe(false);
  });

  it("reports ambiguous text input when the exact target postcondition does not match", async () => {
    const { cdp } = createSecureTargetCdp({ textMatches: false });

    await expect(
      dispatchNativeText(cdp, "#field", secureElementTarget(), "hello", {
        replace: true,
        submit: false,
      }),
    ).resolves.toEqual({ status: "ambiguous", reason: "text-did-not-commit" });
  });

  it("reports ambiguity when authorization is revoked after a post-click cleanup key-up", async () => {
    let authorized = true;
    const { cdp, send } = createSecureTargetCdp({
      onSend(method, params) {
        if (
          method === "Input.dispatchKeyEvent" &&
          params?.type === "keyUp" &&
          params?.key === "a"
        ) {
          authorized = false;
        }
      },
    });

    await expect(
      dispatchNativeText(
        cdp,
        "#field",
        secureElementTarget(),
        "hello",
        { replace: true, submit: false },
        () => authorized,
      ),
    ).resolves.toEqual({
      status: "ambiguous",
      reason: "presentation-authorization-revoked",
    });
    expect(
      send.mock.calls.some(
        ([method, params]) =>
          method === "Input.dispatchKeyEvent" &&
          (params?.type === "keyDown" || params?.type === "rawKeyDown") &&
          params?.key === "Backspace",
      ),
    ).toBe(false);
    expect(send).not.toHaveBeenCalledWith("Input.insertText", { text: "hello" });
  });

  it("reports an ambiguous fill when authorization is revoked after the field is cleared", async () => {
    let authorized = true;
    const { cdp, send } = createSecureTargetCdp({
      onSend(method, params) {
        if (
          method === "Input.dispatchKeyEvent" &&
          params?.type === "keyUp" &&
          params?.key === "Backspace"
        ) {
          authorized = false;
        }
      },
    });

    await expect(
      dispatchNativeText(
        cdp,
        "#field",
        secureElementTarget(),
        "hello",
        { replace: true, submit: false },
        () => authorized,
      ),
    ).resolves.toEqual({
      status: "ambiguous",
      reason: "presentation-authorization-revoked",
    });
    expect(
      send.mock.calls.some(
        ([method, params]) =>
          method === "Input.dispatchKeyEvent" &&
          (params?.type === "keyDown" || params?.type === "rawKeyDown") &&
          params?.key === "Backspace",
      ),
    ).toBe(true);
    expect(send).not.toHaveBeenCalledWith("Input.insertText", { text: "hello" });
  });

  it("reports an ambiguous fill when a post-click guard fails before text mutation", async () => {
    let authorized = true;
    const { cdp, send } = createSecureTargetCdp({
      onSend(method) {
        if (method === "DOM.focus") authorized = false;
      },
    });

    await expect(
      dispatchNativeText(
        cdp,
        "#field",
        secureElementTarget(),
        "hello",
        { replace: true, submit: false },
        () => authorized,
      ),
    ).resolves.toEqual({
      status: "ambiguous",
      reason: "presentation-authorization-revoked",
    });
    expect(
      send.mock.calls.filter(
        ([method, params]) =>
          method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased",
      ),
    ).toHaveLength(1);
    expect(send.mock.calls.some(([method]) => method === "Input.dispatchKeyEvent")).toBe(false);
    expect(send).not.toHaveBeenCalledWith("Input.insertText", { text: "hello" });
  });

  it("reports an ambiguous type when submit authorization is revoked after text insertion", async () => {
    let authorized = true;
    const { cdp, send } = createSecureTargetCdp({
      onSend(method) {
        if (method === "Input.insertText") authorized = false;
      },
    });

    await expect(
      dispatchNativeText(
        cdp,
        "#field",
        secureElementTarget(),
        "hello",
        { replace: false, submit: true },
        () => authorized,
      ),
    ).resolves.toEqual({
      status: "ambiguous",
      reason: "presentation-authorization-revoked",
    });
    expect(send).toHaveBeenCalledWith("Input.insertText", { text: "hello" });
    expect(
      send.mock.calls.some(
        ([method, params]) =>
          method === "Input.dispatchKeyEvent" &&
          (params?.type === "keyDown" || params?.type === "rawKeyDown") &&
          params?.key === "Enter",
      ),
    ).toBe(false);
  });

  it("reports ambiguity when navigation replaces the document after a post-click key stroke", async () => {
    let loaderId = "loader-main-1";
    let keyDowns = 0;
    const { cdp, send } = createSecureTargetCdp({
      loaderId: () => loaderId,
      onSend(method, params) {
        if (
          method === "Input.dispatchKeyEvent" &&
          (params?.type === "keyDown" || params?.type === "rawKeyDown")
        ) {
          keyDowns += 1;
          if (keyDowns === 1) loaderId = "loader-main-2";
        }
      },
    });

    await expect(
      dispatchNativeText(cdp, "#field", secureElementTarget(), "hello", {
        replace: true,
        submit: true,
      }),
    ).resolves.toEqual({ status: "ambiguous", reason: "target-document-changed" });
    expect(
      send.mock.calls
        .filter(([method]) => method === "Input.dispatchKeyEvent")
        .map(([, params]) => ({ type: params?.type, key: params?.key })),
    ).toEqual([{ type: "rawKeyDown", key: "a" }]);
    expect(send).not.toHaveBeenCalledWith("Input.insertText", { text: "hello" });
  });

  it("verifies appended typing against the exact target's prior length", async () => {
    const { cdp, send } = createSecureTargetCdp({ textLengthBefore: 4 });

    await expect(
      dispatchNativeText(cdp, "#field", secureElementTarget(), "hello", {
        replace: false,
        submit: false,
      }),
    ).resolves.toEqual({ status: "completed" });
    expect(send).toHaveBeenCalledWith(
      "Runtime.callFunctionOn",
      expect.objectContaining({
        arguments: [{ value: "hello" }, { value: false }, { value: 4 }],
      }),
    );
    expect(send).toHaveBeenCalledWith(
      "Input.dispatchKeyEvent",
      expect.objectContaining({
        type: "rawKeyDown",
        key: "End",
        commands: ["moveToEndOfDocument"],
      }),
    );
  });

  it("verifies toggle postconditions against the retained backend target", async () => {
    const { cdp } = createSecureTargetCdp({ checkedBefore: false, checkedAfter: false });

    await expect(
      dispatchNativeToggle(cdp, "#checkbox", secureElementTarget(), true),
    ).resolves.toEqual({ status: "ambiguous", reason: "toggle-did-not-commit" });
  });

  it("rejects unchecking a selected radio before dispatching a click", async () => {
    const { cdp, send } = createSecureTargetCdp({
      toggleType: "radio",
      checkedBefore: true,
    });

    await expect(
      dispatchNativeToggle(cdp, "#radio", secureElementTarget(), false),
    ).resolves.toEqual({ status: "failed", reason: "radio-cannot-be-unchecked" });
    expect(
      send.mock.calls.some(
        ([method, params]) =>
          method === "Input.dispatchMouseEvent" && params?.type === "mousePressed",
      ),
    ).toBe(false);
  });

  it("navigates select options by enabled ordinal and verifies the exact target", async () => {
    const { cdp, send, dispatchNativeMenuKey } = createSecureTargetCdp({
      selectTargetIndex: 3,
      selectEnabledSteps: 1,
      selectMatches: true,
    });

    await expect(
      dispatchNativeSelect(cdp, "#choice", secureElementTarget(), "target", dispatchNativeMenuKey),
    ).resolves.toEqual({ status: "completed" });
    expect(dispatchNativeMenuKey.mock.calls.map(([key]) => key)).toEqual([
      "Home",
      "ArrowDown",
      "Enter",
    ]);
    expect(send.mock.calls.some(([method]) => method === "Input.dispatchKeyEvent")).toBe(false);
    const focusIndex = send.mock.calls.findIndex(([method]) => method === "DOM.focus");
    const metadataIndex = send.mock.calls.findIndex(
      ([method, params]) =>
        method === "Runtime.callFunctionOn" &&
        String(params?.functionDeclaration ?? "").includes("enabledSteps"),
    );
    expect(metadataIndex).toBeGreaterThan(focusIndex);
    expect(send).toHaveBeenCalledWith(
      "Runtime.callFunctionOn",
      expect.objectContaining({
        arguments: [{ value: 3 }, { value: "target" }, { value: "Target option" }],
      }),
    );
    expect(send.mock.calls.filter(([method]) => method === "Runtime.evaluate")).toHaveLength(0);
  });

  it("selects with trusted typeahead without opening an OS-owned picker", async () => {
    const { cdp, send, dispatchNativeMenuKey } = createSecureTargetCdp({
      selectTargetIndex: 1,
      selectTargetText: "Second option",
      selectMatches: true,
    });

    await expect(
      dispatchNativeSelect(
        cdp,
        "#choice",
        secureElementTarget(),
        "target",
        dispatchNativeMenuKey,
        undefined,
        "typeahead",
      ),
    ).resolves.toEqual({ status: "completed" });
    expect(dispatchNativeMenuKey).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      "Input.dispatchKeyEvent",
      expect.objectContaining({ type: "keyDown", key: "s", text: "s" }),
    );
    expect(
      send.mock.calls.some(
        ([method, params]) =>
          method === "Input.dispatchMouseEvent" && params?.type === "mousePressed",
      ),
    ).toBe(false);
  });

  it("preserves prior typeahead input when a later retained-target guard fails", async () => {
    let connected = true;
    const { cdp, send, dispatchNativeMenuKey } = createSecureTargetCdp({
      selectTargetIndex: 1,
      selectTargetText: "Second option",
      selectMatches: false,
      connected: () => connected,
      onSend(method, params) {
        if (method === "Input.dispatchKeyEvent" && params?.type === "keyUp") connected = false;
      },
    });

    await expect(
      dispatchNativeSelect(
        cdp,
        "#choice",
        secureElementTarget(),
        "target",
        dispatchNativeMenuKey,
        undefined,
        "typeahead",
      ),
    ).resolves.toEqual({ status: "ambiguous", reason: "target-removed" });
    expect(
      send.mock.calls
        .filter(([method]) => method === "Input.dispatchKeyEvent")
        .map(([, params]) => params?.type),
    ).toEqual(["keyDown", "keyUp"]);
  });

  it("opens the native select popup with a trusted pointer click before keyboard navigation", async () => {
    const eventOrder: string[] = [];
    const { cdp, send, dispatchNativeMenuKey } = createSecureTargetCdp({
      selectTargetIndex: 1,
      selectEnabledSteps: 1,
      selectRequiresPopupSequence: true,
      onSend(method, params) {
        if (
          method === "Input.dispatchMouseEvent" &&
          (params?.type === "mousePressed" || params?.type === "mouseReleased")
        ) {
          eventOrder.push(String(params.type));
        }
      },
      onNativeMenuKey(key) {
        eventOrder.push(key);
      },
    });

    await expect(
      dispatchNativeSelect(cdp, "#choice", secureElementTarget(), "target", dispatchNativeMenuKey),
    ).resolves.toEqual({ status: "completed" });

    expect(eventOrder).toEqual(["mousePressed", "mouseReleased", "Home", "ArrowDown", "Enter"]);
    const pressedIndex = send.mock.calls.findIndex(
      ([method, params]) =>
        method === "Input.dispatchMouseEvent" &&
        params?.type === "mousePressed" &&
        params?.clickCount === 1,
    );
    const releasedIndex = send.mock.calls.findIndex(
      ([method, params]) =>
        method === "Input.dispatchMouseEvent" &&
        params?.type === "mouseReleased" &&
        params?.clickCount === 1,
    );
    expect(pressedIndex).toBeGreaterThanOrEqual(0);
    expect(releasedIndex).toBeGreaterThan(pressedIndex);
    expect(send.mock.calls.some(([method]) => method === "Input.dispatchKeyEvent")).toBe(false);
  });

  it("keeps navigating the exact retained native select when opening its picker shifts layout", async () => {
    const { cdp, dispatchNativeMenuKey } = createSecureTargetCdp({
      selectTargetIndex: 1,
      selectEnabledSteps: 1,
      selectRequiresPopupSequence: true,
      movedAfterFirstClickTo: { x: 140, y: 74 },
    });

    await expect(
      dispatchNativeSelect(cdp, "#choice", secureElementTarget(), "target", dispatchNativeMenuKey),
    ).resolves.toEqual({ status: "completed" });
    expect(dispatchNativeMenuKey.mock.calls.map(([key]) => key)).toEqual([
      "Home",
      "ArrowDown",
      "Enter",
    ]);
  });

  it("still stops native select navigation if the retained node is removed after opening", async () => {
    const { cdp, dispatchNativeMenuKey } = createSecureTargetCdp({
      selectRequiresPopupSequence: true,
      disconnectAfterFirstClick: true,
    });

    await expect(
      dispatchNativeSelect(cdp, "#choice", secureElementTarget(), "target", dispatchNativeMenuKey),
    ).resolves.toEqual({ status: "ambiguous", reason: "target-removed" });
    expect(dispatchNativeMenuKey).not.toHaveBeenCalled();
  });

  it("fails closed without navigating when the native select popup cannot be confirmed", async () => {
    const { cdp, send, dispatchNativeMenuKey } = createSecureTargetCdp({
      selectEnabledSteps: 2,
      selectRequiresPopupSequence: true,
      selectPopupOpens: false,
    });

    await expect(
      dispatchNativeSelect(cdp, "#choice", secureElementTarget(), "target", dispatchNativeMenuKey),
    ).resolves.toEqual({ status: "ambiguous", reason: "select-popup-did-not-open" });
    expect(dispatchNativeMenuKey).not.toHaveBeenCalled();
    expect(send.mock.calls.some(([method]) => method === "Input.dispatchKeyEvent")).toBe(false);
  });

  it("stops select navigation when authorization is revoked after the pointer opener", async () => {
    let authorized = true;
    const { cdp, send, dispatchNativeMenuKey } = createSecureTargetCdp({
      selectRequiresPopupSequence: true,
      onSend(method, params) {
        if (
          method === "Input.dispatchMouseEvent" &&
          params?.type === "mouseReleased" &&
          params?.clickCount === 1
        ) {
          authorized = false;
        }
      },
    });

    await expect(
      dispatchNativeSelect(
        cdp,
        "#choice",
        secureElementTarget(),
        "target",
        dispatchNativeMenuKey,
        () => authorized,
      ),
    ).resolves.toEqual({
      status: "ambiguous",
      reason: "presentation-authorization-revoked",
    });
    expect(dispatchNativeMenuKey.mock.calls.map(([key]) => key)).toEqual(["Escape"]);
    expect(send.mock.calls.some(([method]) => method === "Input.dispatchKeyEvent")).toBe(false);
  });

  it("stops select navigation when authorization is revoked after Home key-up", async () => {
    let authorized = true;
    const { cdp, send, dispatchNativeMenuKey } = createSecureTargetCdp({
      selectEnabledSteps: 2,
      onNativeMenuKey(key) {
        if (key === "Home") authorized = false;
      },
    });

    await expect(
      dispatchNativeSelect(
        cdp,
        "#choice",
        secureElementTarget(),
        "target",
        dispatchNativeMenuKey,
        () => authorized,
      ),
    ).resolves.toEqual({
      status: "ambiguous",
      reason: "presentation-authorization-revoked",
    });
    expect(dispatchNativeMenuKey.mock.calls.map(([key]) => key)).toEqual(["Home", "Escape"]);
    expect(send.mock.calls.some(([method]) => method === "Input.dispatchKeyEvent")).toBe(false);
  });
});

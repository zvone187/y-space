import { randomUUID } from "node:crypto";
import type { CdpSession } from "./cdp/cdpClient";

/**
 * Page-level Y Space agent presence. The page owns one inert host with a closed
 * shadow root, one pointer, and one feedback surface. Browser actions resolve
 * their target once here, then reuse that exact point for trusted CDP input.
 */

const GLIDE_MS = 180;
const CURSOR_EVAL_CAP_MS = 250;
const POINTER_MOVE_CAP_MS = 300;
const POINTER_ACTION_CAP_MS = 750;
const POINTER_PATH_SAMPLES = 8;
const CURSOR_ISOLATED_WORLD = "y-space-agent-cursor-v1";
interface NativePointerPosition {
  readonly mainDocumentIdentity: string;
  readonly x: number;
  readonly y: number;
}
const nativePointerPositionBySession = new WeakMap<CdpSession, NativePointerPosition>();
const nativeInputDocumentBySession = new WeakMap<CdpSession, string>();

interface CursorVisualIdentity {
  readonly mainDocumentIdentity: string;
  readonly hostId: string;
  readonly stateKey: string;
}

const cursorVisualIdentityBySession = new WeakMap<CdpSession, CursorVisualIdentity>();

export type AgentCursorAction =
  | "click"
  | "double-click"
  | "focus"
  | "hover"
  | "press"
  | "scroll"
  | "select"
  | "text"
  | "toggle";

interface AgentCursorTargetBase {
  /** Browser-process frame + loader identity for the document where the visual
   * and native path were proven. Completion feedback must never cross it. */
  mainDocumentIdentity: string;
  x: number;
  y: number;
  /** Whether Chromium accepted the matching native mouse-move command. */
  nativeMoved: boolean;
  /** A timed-out native move may still have reached Chromium. Never continue
   * into a press or key action when the path outcome is ambiguous. */
  nativeMoveAmbiguous?: boolean;
  /** Exact guard/transport reason retained when a pointer path becomes
   * ambiguous, so callers never collapse a partial hover into a generic
   * pointer-path failure. */
  nativeMoveReason?: string;
  /** At least one trusted mouseMoved command completed before the later path,
   * correction, or target guard failed. Page hover handlers may have run. */
  nativeMoveCompletedBeforeFailure?: boolean;
  /** Authorization was revoked before a native cursor-path command. */
  nativeAuthorizationRevoked?: boolean;
}

/** Element authority lives entirely in Chromium's DOM backend and an isolated
 * execution world. The page-owned overlay receives coordinates for display,
 * but it never receives or decides the node identity used for native input. */
export type AgentCursorTarget = AgentCursorTargetBase &
  (
    | {
        kind: "element";
        backendNodeId: number;
        executionContextId: number;
        /** Browser-process layout origin and unclamped document-space center
         * captured with the retained node. They authorize only one correction
         * for viewport drift caused by scrolling; absence keeps movement
         * strictly fail-closed. */
        pageX?: number;
        pageY?: number;
        documentX?: number;
        documentY?: number;
      }
    | {
        kind: "viewport";
        backendNodeId?: never;
        executionContextId?: never;
      }
  );

interface CursorEvalResult {
  ok: boolean;
  x?: number;
  y?: number;
  startX?: number;
  startY?: number;
  kind?: "element" | "viewport";
  reducedMotion?: boolean;
  reason?: string;
}

export type NativeInputOutcome =
  | { status: "completed" }
  | { status: "failed"; reason: string }
  | {
      status: "ambiguous";
      reason: string;
      /** The trusted input phase known to have completed before a later guard
       * or phase failed. */
      partial?: "pointer-move" | "single-click" | "at-least-one-click";
      clickDispatched?: boolean;
    };

function completedPointerMoveAmbiguity(reason: string): NativeInputOutcome {
  return {
    status: "ambiguous",
    reason,
    partial: "pointer-move",
    clickDispatched: false,
  };
}

function targetPointerMoveAmbiguity(target: AgentCursorTarget): NativeInputOutcome {
  const reason = target.nativeMoveReason ?? "pointer-path-timeout";
  return target.nativeMoveCompletedBeforeFailure
    ? completedPointerMoveAmbiguity(reason)
    : { status: "ambiguous", reason, clickDispatched: false };
}

function completedSingleClickAmbiguity(reason: string): NativeInputOutcome {
  return {
    status: "ambiguous",
    reason,
    partial: "single-click",
    clickDispatched: true,
  };
}

function atLeastOneClickAmbiguity(reason: string): NativeInputOutcome {
  return {
    status: "ambiguous",
    reason,
    partial: "at-least-one-click",
    clickDispatched: true,
  };
}

function preserveCompletedPointerMove(
  target: AgentCursorTarget,
  outcome: NativeInputOutcome,
): NativeInputOutcome {
  return outcome.status === "failed" && target.nativeMoveCompletedBeforeFailure
    ? completedPointerMoveAmbiguity(outcome.reason)
    : outcome;
}

function preservePriorNativeInputAmbiguity(outcome: NativeInputOutcome): NativeInputOutcome {
  if (outcome.status !== "failed") return outcome;
  return { status: "ambiguous", reason: outcome.reason };
}

/** Synchronous lease check evaluated immediately before each non-cleanup CDP
 * input side effect. Throwing or returning anything except true revokes input. */
export type NativeInputAuthorization = () => boolean;

export type NativeSelectMenuKey = "ArrowDown" | "Enter" | "Escape" | "Home";
export type NativeSelectInputStrategy = "native-menu" | "typeahead";

export interface NativeKeyboardInputOptions {
  shift?: boolean;
  modifiers?: number;
  commands?: string[];
  cleanup?: boolean;
}

/** Keyboard/text transport captured to the exact presented browser guest.
 * Production uses WebContents-native input so printable keys cannot follow the
 * host renderer's first responder. Tests and non-Electron callers may omit it
 * and retain the CDP transport. */
export interface NativeKeyboardInputDispatcher {
  key(key: string, options?: NativeKeyboardInputOptions): Promise<NativeInputOutcome>;
  insertText(text: string): Promise<NativeInputOutcome>;
}

/** Main-process native-menu input. Chromium's CDP keyboard domain delivers
 * key events to the renderer, but a macOS <select> picker is an OS-owned menu.
 * The caller binds this dispatcher to the exact presented guest WebContents. */
export type NativeSelectMenuKeyDispatcher = (
  key: NativeSelectMenuKey,
  options?: { cleanup?: boolean },
) => Promise<NativeInputOutcome>;

const PRESENTATION_AUTHORIZATION_REVOKED = "presentation-authorization-revoked";

interface CursorFeedbackDetails {
  deltaX?: number;
  deltaY?: number;
  label?: string;
}

const CURSOR_INSTALL = `
function __ysApplyCursorVisibility(state){
  const hidden=state.sessionHidden===true||(Array.isArray(state.screenshotOwners)&&state.screenshotOwners.length>0);
  CSSStyleDeclaration.prototype.setProperty.call(state.host.style,"visibility",hidden?"hidden":"visible","important");
}
function __ysCursorPopoverOpen(state){
  if(!state||!state.host||!state.host.isConnected||state.host.ownerDocument!==document||state.host.getAttribute("popover")!=="manual") return false;
  const matches=Element.prototype.matches;
  if(typeof matches!=="function") return false;
  try { return matches.call(state.host,":popover-open")===true; } catch(e) { return false; }
}
function __ysPromoteCursor(state){
  if(!state||!state.host||!state.host.isConnected||state.host.ownerDocument!==document||state.host.getAttribute("popover")!=="manual") return false;
  const show=HTMLElement.prototype.showPopover;
  const hide=HTMLElement.prototype.hidePopover;
  if(typeof show!=="function"||typeof hide!=="function") return false;
  try {
    if(__ysCursorPopoverOpen(state)){
      hide.call(state.host);
      if(__ysCursorPopoverOpen(state)) return false;
    }
    if(!state.host.isConnected||state.host.getAttribute("popover")!=="manual") return false;
    show.call(state.host);
    return state.host.isConnected&&__ysCursorPopoverOpen(state);
  } catch(e) { return false; }
}
function __ysAgentCursor(HOST_ID,STATE_KEY){
  let state=window[STATE_KEY];
  if(state&&state.identity===STATE_KEY&&state.hostId===HOST_ID&&state.host&&state.host.isConnected&&state.host.id===HOST_ID){
    __ysApplyCursorVisibility(state);
    return state;
  }
  const sessionHidden=!!(state&&state.identity===STATE_KEY&&state.sessionHidden===true);
  const screenshotOwners=state&&state.identity===STATE_KEY&&Array.isArray(state.screenshotOwners)?state.screenshotOwners.filter(function(value){return typeof value==="string";}).slice(-63):[];
  Array.from(Document.prototype.querySelectorAll.call(document,'[id="'+HOST_ID+'"]')).forEach(function(orphan){Element.prototype.remove.call(orphan);});

  const host=Document.prototype.createElement.call(document,"div");
  host.id=HOST_ID;
  Element.prototype.setAttribute.call(host,"aria-hidden","true");
  Element.prototype.setAttribute.call(host,"inert","");
  Element.prototype.setAttribute.call(host,"popover","manual");
  Element.prototype.setAttribute.call(host,"style","all:initial;position:fixed!important;left:0!important;top:0!important;width:1px!important;height:1px!important;z-index:2147483647!important;pointer-events:none!important;will-change:transform!important;transform:translate3d(-48px,-48px,0);contain:layout style!important;visibility:hidden!important");
  const root=Element.prototype.attachShadow.call(host,{mode:"closed"});
  const css=\`
    :host,*{box-sizing:border-box;pointer-events:none!important}
    :host::backdrop{background:transparent!important;pointer-events:none!important}
    #__y_space_agent_cursor_pointer__{position:absolute;left:0;top:0;width:28px;height:31px;filter:drop-shadow(0 3px 7px rgba(30,24,20,.22));transform:translate(-2px,-1px)}
    #__y_space_agent_cursor_pointer__ svg{display:block;width:28px;height:31px;overflow:visible}
    #__y_space_agent_cursor_feedback__{position:absolute;left:0;top:0;display:grid;place-items:center;min-width:22px;height:22px;padding:0 6px;border:2px solid #ffffff;border-radius:999px;background:#ff5a1f;color:#ffffff;font:700 10px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:-.01em;box-shadow:0 3px 12px rgba(255,90,31,.32);opacity:0;transform:translate(-50%,-50%) scale(.55);transform-origin:center;white-space:nowrap}
    #__y_space_agent_cursor_feedback__[data-action="click"]{min-width:20px;width:20px;height:20px;padding:0;background:rgba(255,90,31,.2);border-color:#ff5a1f;box-shadow:0 0 0 2px #ffffff,0 3px 12px rgba(255,90,31,.32)}
    #__y_space_agent_cursor_feedback__[data-action="double-click"]{min-width:22px;width:22px;height:22px;padding:0;background:rgba(255,90,31,.18);border-color:#ff5a1f;box-shadow:0 0 0 2px #ffffff,0 0 0 5px rgba(255,90,31,.3)}
    #__y_space_agent_cursor_feedback__[data-action="focus"]{min-width:24px;width:24px;height:24px;padding:0;background:transparent;border:2px solid #ff5a1f;box-shadow:0 0 0 2px #ffffff}
    #__y_space_agent_cursor_feedback__[data-action="scroll"]{min-width:20px;width:20px;height:30px;padding:0;border-radius:10px}
    #__y_space_agent_cursor_feedback__[data-action="text"]{min-width:30px}
    #__y_space_agent_cursor_feedback__[data-action="press"]{border-radius:7px}
    #__y_space_agent_cursor_feedback__[data-action="select"]{min-width:24px}
    #__y_space_agent_cursor_feedback__[data-action="toggle"]{min-width:24px}
  \`;
  let stylesInstalled=false;
  try {
    if(typeof CSSStyleSheet==="function" && "adoptedStyleSheets" in root){
      const sheet=new CSSStyleSheet();
      sheet.replaceSync(css);
      root.adoptedStyleSheets=[sheet];
      stylesInstalled=true;
    }
  } catch(e) {}
  if(!stylesInstalled){
    const style=Document.prototype.createElement.call(document,"style");
    style.textContent=css;
    Node.prototype.appendChild.call(root,style);
  }
  const pointer=Document.prototype.createElement.call(document,"div");
  pointer.id="__y_space_agent_cursor_pointer__";
  const svg=Document.prototype.createElementNS.call(document,"http://www.w3.org/2000/svg","svg");
  svg.setAttribute("viewBox","0 0 28 31");
  svg.setAttribute("fill","none");
  const path=Document.prototype.createElementNS.call(document,"http://www.w3.org/2000/svg","path");
  path.setAttribute("d","M3.2 2.5 22.4 15.3l-8.65 1.55-4.8 8.15L3.2 2.5Z");
  path.setAttribute("fill","#ff5a1f");
  path.setAttribute("stroke","#ffffff");
  path.setAttribute("stroke-width","1.9");
  path.setAttribute("stroke-linejoin","round");
  Node.prototype.appendChild.call(svg,path);
  Node.prototype.appendChild.call(pointer,svg);
  const feedback=Document.prototype.createElement.call(document,"div");
  feedback.id="__y_space_agent_cursor_feedback__";
  feedback.setAttribute("aria-hidden","true");
  Node.prototype.appendChild.call(root,pointer);
  Node.prototype.appendChild.call(root,feedback);
  Node.prototype.appendChild.call(document.body||document.documentElement,host);
  state={identity:STATE_KEY,hostId:HOST_ID,host:host,root:root,feedback:feedback,x:null,y:null,feedbackTimer:null,moveToken:null,feedbackToken:null,sessionHidden:sessionHidden,screenshotOwners:screenshotOwners};
  window[STATE_KEY]=state;
  __ysApplyCursorVisibility(state);
  return state;
}
function __ysStopFeedback(state){
  if(state.feedbackTimer){ clearTimeout(state.feedbackTimer); state.feedbackTimer=null; }
  Element.prototype.getAnimations.call(state.feedback).forEach(function(animation){ animation.cancel(); });
  state.feedback.style.opacity="0";
}
function __ysCursorHostValid(state,HOST_ID,STATE_KEY,expectVisible){
  if(!state||window[STATE_KEY]!==state||state.identity!==STATE_KEY||state.hostId!==HOST_ID||!state.host||!state.host.isConnected||state.host.ownerDocument!==document||(state.host.parentNode!==document.body&&state.host.parentNode!==document.documentElement)||state.host.id!==HOST_ID||state.host.getAttribute("aria-hidden")!=="true"||!state.host.hasAttribute("inert")||state.host.getAttribute("popover")!=="manual"||!__ysCursorPopoverOpen(state)||!state.root||state.feedback?.getRootNode()!==state.root) return false;
  const style=getComputedStyle(state.host);
  const isNone=function(value){return value===""||value==="none"||value==="normal";};
  const overflowVisible=function(value){return value===""||value==="visible";};
  const opacity=style.opacity===""?1:Number(style.opacity);
  return style.position==="fixed"&&style.pointerEvents==="none"&&style.zIndex==="2147483647"&&style.width==="1px"&&style.height==="1px"&&style.display!=="none"&&opacity===1&&overflowVisible(style.overflowX)&&overflowVisible(style.overflowY)&&style.contentVisibility!=="hidden"&&isNone(style.clipPath)&&isNone(style.filter)&&isNone(style.maskImage)&&isNone(style.offsetPath)&&isNone(style.rotate)&&isNone(style.scale)&&isNone(style.translate)&&(!expectVisible||style.visibility==="visible");
}
async function __ysCursorPainted(state,HOST_ID,STATE_KEY,expectVisible){
  if(!__ysPromoteCursor(state)) return false;
  const painted=await new Promise(function(resolve){
    let settled=false;
    const timer=setTimeout(function(){if(!settled){settled=true;resolve(false);}},120);
    requestAnimationFrame(function(){if(!settled){settled=true;clearTimeout(timer);resolve(true);}});
  });
  return painted&&__ysCursorHostValid(state,HOST_ID,STATE_KEY,expectVisible);
}
function __ysCancelCursorMove(state,TOKEN){
  if(!state||state.moveToken!==TOKEN) return false;
  state.moveToken=null;
  __ysStopFeedback(state);
  if(state.host){
    state.host.style.transition="none";
    CSSStyleDeclaration.prototype.setProperty.call(state.host.style,"visibility","hidden","important");
    if(state.host.isConnected) Element.prototype.remove.call(state.host);
  }
  state.x=null;state.y=null;state.moveTransform=null;
  return true;
}
function __ysSetCursorTransform(state,value){
  const style=state.host.style;
  CSSStyleDeclaration.prototype.setProperty.call(style,"transform",value,"important");
  const serialized=CSSStyleDeclaration.prototype.getPropertyValue.call(style,"transform");
  const priority=CSSStyleDeclaration.prototype.getPropertyPriority.call(style,"transform");
  return priority==="important"&&serialized.startsWith("translate3d(")?serialized:null;
}
function __ysCursorTransformMatches(state,serialized){
  if(typeof serialized!=="string"||serialized.length===0) return false;
  const style=state.host.style;
  return CSSStyleDeclaration.prototype.getPropertyPriority.call(style,"transform")==="important"&&CSSStyleDeclaration.prototype.getPropertyValue.call(style,"transform")===serialized;
}
function __ysFeedbackGlyph(action,label,deltaX,deltaY){
  if(action==="double-click") return "2×";
  if(action==="text") return "Aa";
  if(action==="press") return label||"⌨";
  if(action==="toggle") return label||"✓";
  if(action==="select") return "⌄";
  if(action==="scroll") {
    if(deltaX===0&&deltaY===0) return "↕";
    if(Math.abs(deltaX)>Math.abs(deltaY)) return deltaX<0?"←":"→";
    return deltaY<0?"↑":"↓";
  }
  return "";
}`;

let screenshotOverlayTokenCounter = 0;

function nextScreenshotOverlayToken(): string {
  screenshotOverlayTokenCounter += 1;
  return `y-space-screenshot-${Date.now()}-${screenshotOverlayTokenCounter}`;
}

function hideOverlayForScreenshotExpr(token: string, identity: CursorVisualIdentity): string {
  return `(async () => {
  const phase="hide";
  const HOST_ID=${JSON.stringify(identity.hostId)};
  const STATE_KEY=${JSON.stringify(identity.stateKey)};
  const TOKEN=${JSON.stringify(token)};
  const state=window[STATE_KEY];
  if(!state||state.identity!==STATE_KEY||state.hostId!==HOST_ID){
    Array.from(Document.prototype.querySelectorAll.call(document,'[id="'+HOST_ID+'"]')).forEach(function(host){Element.prototype.remove.call(host);});
    await Promise.resolve();
    const remaining=Document.prototype.querySelectorAll.call(document,'[id="'+HOST_ID+'"]');
    return {ok:remaining.length===0,tokenOwned:true,hostCount:0,hiddenHostCount:0};
  }
  let owners=Array.isArray(state.screenshotOwners)?state.screenshotOwners.filter(function(value){return typeof value==="string";}).slice(-63):[];
  if(!owners.includes(TOKEN)) owners.push(TOKEN);
  state.screenshotOwners=owners;
  if(!state.host||!state.host.isConnected) return {ok:true,tokenOwned:true,hostCount:0,hiddenHostCount:0};
  CSSStyleDeclaration.prototype.setProperty.call(state.host.style,"visibility","hidden","important");
  const painted=await new Promise(function(resolve){let done=false;const timer=setTimeout(function(){if(!done){done=true;resolve(false);}},120);requestAnimationFrame(function(){if(!done){done=true;clearTimeout(timer);resolve(true);}});});
  const tokenOwned=state.screenshotOwners.includes(TOKEN);
  const hidden=window[STATE_KEY]===state&&state.host.isConnected&&state.host.id===HOST_ID&&getComputedStyle(state.host).visibility==="hidden";
  return {ok:painted&&tokenOwned&&hidden,tokenOwned:tokenOwned,hostCount:1,hiddenHostCount:hidden?1:0};
})()`;
}

function restoreOverlayAfterScreenshotExpr(token: string, identity: CursorVisualIdentity): string {
  return `(() => {
  ${CURSOR_INSTALL}
  const phase="restore";
  const HOST_ID=${JSON.stringify(identity.hostId)};
  const STATE_KEY=${JSON.stringify(identity.stateKey)};
  const TOKEN=${JSON.stringify(token)};
  const state=window[STATE_KEY];
  if(!state||state.identity!==STATE_KEY||state.hostId!==HOST_ID){return {ok:true,tokenOwned:false,screenshotOwnerCount:0,sessionOwned:false,hostCount:0,visibleHostCount:0};}
  state.screenshotOwners=(Array.isArray(state.screenshotOwners)?state.screenshotOwners:[]).filter(function(value){return typeof value==="string"&&value!==TOKEN;});
  const tokenOwned=state.screenshotOwners.includes(TOKEN);
  const sessionOwned=state.sessionHidden===true;
  const mustBeVisible=state.screenshotOwners.length===0&&!sessionOwned;
  if(state.host&&state.host.isConnected) CSSStyleDeclaration.prototype.setProperty.call(state.host.style,"visibility",mustBeVisible?"visible":"hidden","important");
  const connected=!!(state.host&&state.host.isConnected&&state.host.id===HOST_ID&&window[STATE_KEY]===state);
  const topLayerIntact=!connected||__ysCursorPopoverOpen(state);
  const visible=connected&&__ysCursorHostValid(state,HOST_ID,STATE_KEY,true);
  return {ok:!tokenOwned&&topLayerIntact&&(!mustBeVisible||!connected||visible),tokenOwned:tokenOwned,screenshotOwnerCount:state.screenshotOwners.length,sessionOwned:sessionOwned,hostCount:connected?1:0,visibleHostCount:visible?1:0};
})()`;
}

interface ScreenshotHideResult {
  ok: boolean;
  tokenOwned: boolean;
  hostCount: number;
  hiddenHostCount: number;
}

interface ScreenshotRestoreResult {
  ok: boolean;
  tokenOwned: boolean;
  screenshotOwnerCount: number;
  sessionOwned: boolean;
  hostCount: number;
  visibleHostCount: number;
}

interface SessionOverlayVisibilityResult {
  ok: boolean;
  sessionOwned: boolean;
  screenshotOwnerCount: number;
  hostCount: number;
  hiddenHostCount: number;
  visibleHostCount: number;
}

function sessionOverlayVisibilityExpr(visible: boolean, identity: CursorVisualIdentity): string {
  return `(async () => {
  ${CURSOR_INSTALL}
  const phase=${JSON.stringify(visible ? "session-show" : "session-hide")};
  const HOST_ID=${JSON.stringify(identity.hostId)};
  const STATE_KEY=${JSON.stringify(identity.stateKey)};
  let state=window[STATE_KEY];
  if(!state||state.identity!==STATE_KEY||state.hostId!==HOST_ID){Array.from(Document.prototype.querySelectorAll.call(document,'[id="'+HOST_ID+'"]')).forEach(function(host){Element.prototype.remove.call(host);});state={identity:STATE_KEY,hostId:HOST_ID,host:null,root:null,feedback:null,x:null,y:null,feedbackTimer:null,moveToken:null,feedbackToken:null,sessionHidden:${visible ? "false" : "true"},screenshotOwners:[]};window[STATE_KEY]=state;}
  state.sessionHidden=${visible ? "false" : "true"};
  const screenshotOwnerCount=Array.isArray(state.screenshotOwners)?state.screenshotOwners.length:0;
  const connected=!!(state.host&&state.host.isConnected&&state.host.id===HOST_ID&&window[STATE_KEY]===state);
  if(connected) CSSStyleDeclaration.prototype.setProperty.call(state.host.style,"visibility",state.sessionHidden||screenshotOwnerCount>0?"hidden":"visible","important");
  const topLayerIntact=!connected||__ysCursorPopoverOpen(state);
  if(connected){await new Promise(function(resolve){let done=false;const timer=setTimeout(function(){if(!done){done=true;resolve(false);}},120);requestAnimationFrame(function(){if(!done){done=true;clearTimeout(timer);resolve(true);}});});}
  const hidden=connected&&getComputedStyle(state.host).visibility==="hidden";
  const visibleHostCount=connected&&!hidden&&__ysCursorHostValid(state,HOST_ID,STATE_KEY,true)?1:0;
  const hiddenHostCount=hidden?1:0;
  const ok=topLayerIntact&&${visible ? "state.sessionHidden===false&&(screenshotOwnerCount>0||!connected||visibleHostCount===1)" : "state.sessionHidden===true&&(!connected||hiddenHostCount===1)"};
  return {ok:ok,sessionOwned:state.sessionHidden===true,screenshotOwnerCount:screenshotOwnerCount,hostCount:connected?1:0,hiddenHostCount:hiddenHostCount,visibleHostCount:visibleHostCount};
})()`;
}

interface IsolatedRuntimeEvaluateResult {
  result?: { value?: unknown };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

type BoundedResult<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected" }
  | { status: "timed-out" };

type BoundedInputResult = BoundedResult<unknown> | { status: "unauthorized" };

/** CDP's embedded transport has no timeout of its own. Presence visuals are
 * best-effort and must never wedge the browser action they describe. */
async function settleBounded<T>(
  promise: Promise<T>,
  capMs = CURSOR_EVAL_CAP_MS,
): Promise<BoundedResult<T>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then<BoundedResult<T>, BoundedResult<T>>(
        (value) => ({ status: "fulfilled", value }),
        () => ({ status: "rejected" }),
      ),
      new Promise<BoundedResult<T>>((resolve) => {
        timeout = setTimeout(() => resolve({ status: "timed-out" }), capMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function evalJsInCursorIsolatedWorld<T>(
  cdp: CdpSession,
  expression: string,
  expectedMainDocumentIdentity?: string,
): Promise<T> {
  const evaluate = async (executionContextId: number): Promise<T> => {
    const response = await cdp.send<IsolatedRuntimeEvaluateResult>("Runtime.evaluate", {
      expression,
      contextId: executionContextId,
      returnByValue: true,
      awaitPromise: true,
      userGesture: false,
    });
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description ??
          response.exceptionDetails.text ??
          "isolated cursor evaluation failed",
      );
    }
    return response.result?.value as T;
  };

  const world = await createCursorIsolatedWorld(cdp, expectedMainDocumentIdentity);
  if (!world) throw new Error("isolated cursor world unavailable");
  try {
    return await evaluate(world.executionContextId);
  } catch {
    invalidateCursorIsolatedWorld(cdp, world.executionContextId);
    const refreshed = await createCursorIsolatedWorld(cdp, expectedMainDocumentIdentity);
    if (!refreshed) throw new Error("isolated cursor world unavailable");
    return await evaluate(refreshed.executionContextId);
  }
}

function cursorVisualIdentity(cdp: CdpSession, mainDocumentIdentity: string): CursorVisualIdentity {
  const cached = cursorVisualIdentityBySession.get(cdp);
  if (cached?.mainDocumentIdentity === mainDocumentIdentity) return cached;
  const nonce = randomUUID().replaceAll("-", "");
  const identity = {
    mainDocumentIdentity,
    hostId: `__y_space_agent_cursor_${nonce}__`,
    stateKey: `__y_space_agent_cursor_state_${nonce}__`,
  };
  cursorVisualIdentityBySession.set(cdp, identity);
  return identity;
}

function restoreCursorOverlay(
  cdp: CdpSession,
  token: string,
  identity: CursorVisualIdentity,
): Promise<ScreenshotRestoreResult> {
  return evalJsInCursorIsolatedWorld<ScreenshotRestoreResult>(
    cdp,
    restoreOverlayAfterScreenshotExpr(token, identity),
    identity.mainDocumentIdentity,
  );
}

async function restoreCursorOverlayConfirmed(
  cdp: CdpSession,
  token: string,
  identity: CursorVisualIdentity,
): Promise<boolean> {
  const first = await settleBounded(restoreCursorOverlay(cdp, token, identity));
  if (first.status === "fulfilled" && first.value?.ok === true) return true;
  const retry = await settleBounded(restoreCursorOverlay(cdp, token, identity));
  return retry.status === "fulfilled" && retry.value?.ok === true;
}

/** Show or hide the page-level presence visuals for an explicit MCP session. */
export async function setCursorOverlayVisible(cdp: CdpSession, visible: boolean): Promise<boolean> {
  const mainDocumentIdentity = await readMainDocumentIdentity(cdp);
  if (!mainDocumentIdentity) return false;
  const identity = cursorVisualIdentity(cdp, mainDocumentIdentity);
  const result = await settleBounded(
    evalJsInCursorIsolatedWorld<SessionOverlayVisibilityResult>(
      cdp,
      sessionOverlayVisibilityExpr(visible, identity),
      mainDocumentIdentity,
    ),
  );
  if (result.status !== "fulfilled" || result.value?.ok !== true) return false;
  if (visible) {
    return (
      result.value.sessionOwned === false &&
      (result.value.screenshotOwnerCount > 0 ||
        result.value.visibleHostCount === result.value.hostCount)
    );
  }
  return (
    result.value.sessionOwned === true && result.value.hiddenHostCount === result.value.hostCount
  );
}

/** Hide the cursor for a screenshot and restore it even when capture fails. */
export async function withCursorOverlayHidden<T>(
  cdp: CdpSession,
  capture: () => Promise<T>,
): Promise<T> {
  const mainDocumentIdentity = await readMainDocumentIdentity(cdp);
  if (!mainDocumentIdentity) {
    throw new Error("Browser screenshot cursor exclusion could not identify the document");
  }
  const identity = cursorVisualIdentity(cdp, mainDocumentIdentity);
  const token = nextScreenshotOverlayToken();
  const hidePromise = evalJsInCursorIsolatedWorld<ScreenshotHideResult>(
    cdp,
    hideOverlayForScreenshotExpr(token, identity),
    mainDocumentIdentity,
  );
  const hideResult = await settleBounded(hidePromise);
  if (
    hideResult.status !== "fulfilled" ||
    hideResult.value?.ok !== true ||
    hideResult.value.tokenOwned !== true ||
    hideResult.value.hiddenHostCount !== hideResult.value.hostCount
  ) {
    // A timed-out Runtime.evaluate can still land later. Pair any late hide
    // with a restore, but never begin capture without a confirmed paint frame.
    if (hideResult.status === "timed-out") {
      void hidePromise.then(
        (didHide) => {
          if (didHide?.tokenOwned) void restoreCursorOverlayConfirmed(cdp, token, identity);
        },
        () => {},
      );
    }
    throw new Error("Browser screenshot cursor exclusion could not be confirmed");
  }

  let captureFailed = false;
  let captureError: unknown;
  let value!: T;
  try {
    value = await capture();
  } catch (error) {
    captureFailed = true;
    captureError = error;
  }

  const restored = await restoreCursorOverlayConfirmed(cdp, token, identity);
  if (captureFailed) {
    throw captureError instanceof Error ? captureError : new Error(String(captureError));
  }
  if (!restored) {
    // The screenshot itself is safe, but returning it would conceal a stuck
    // presence state and make following cursor actions invisible.
    throw new Error("Browser screenshot could not restore cursor visibility");
  }
  return value;
}

/** Move the presentation-only page overlay to an already-authoritative CDP point. */
interface CursorExpressionOptions {
  identity?: CursorVisualIdentity;
  operationToken?: string;
  deadlineEpochMs?: number;
}

export function cursorGlideExpr(
  target: Pick<AgentCursorTarget, "x" | "y" | "kind">,
  glideMs = GLIDE_MS,
  cursorAction: AgentCursorAction = "hover",
  trustedStart?: Pick<AgentCursorTarget, "x" | "y">,
  options: CursorExpressionOptions = {},
): string {
  const duration = Math.max(0, Math.min(1_000, Math.round(glideMs)));
  const x = Number.isFinite(target.x) ? target.x : 0;
  const y = Number.isFinite(target.y) ? target.y : 0;
  const trustedStartX = trustedStart && Number.isFinite(trustedStart.x) ? trustedStart.x : null;
  const trustedStartY = trustedStart && Number.isFinite(trustedStart.y) ? trustedStart.y : null;
  const identity =
    options.identity ??
    ({
      mainDocumentIdentity: "direct-expression",
      hostId: "__y_space_agent_cursor__",
      stateKey: "__y_space_agent_cursor_state__",
    } satisfies CursorVisualIdentity);
  const operationToken = options.operationToken ?? `direct-${randomUUID()}`;
  const deadlineEpochMs = Number.isFinite(options.deadlineEpochMs)
    ? Number(options.deadlineEpochMs)
    : Date.now() + CURSOR_EVAL_CAP_MS;
  return `(async () => {
    ${CURSOR_INSTALL}
    const phase="move";
    const HOST_ID=${JSON.stringify(identity.hostId)};
    const STATE_KEY=${JSON.stringify(identity.stateKey)};
    const TOKEN=${JSON.stringify(operationToken)};
    const DEADLINE=${deadlineEpochMs};
    const action=${JSON.stringify(cursorAction)};
    const x=${x};
    const y=${y};
    const kind=${JSON.stringify(target.kind)};
    const trustedStartX=${trustedStartX ?? "null"};
    const trustedStartY=${trustedStartY ?? "null"};
    if(Date.now()>=DEADLINE) return {ok:false,reason:"move-deadline-expired"};
    const state=__ysAgentCursor(HOST_ID,STATE_KEY);
    state.moveToken=TOKEN;
    if(Date.now()>=DEADLINE){__ysCancelCursorMove(state,TOKEN);return {ok:false,reason:"move-deadline-expired"};}
    state.sessionHidden=false;
    __ysApplyCursorVisibility(state);
    __ysStopFeedback(state);
    const maxX=Math.max(0,window.innerWidth-1),maxY=Math.max(0,window.innerHeight-1);
    const displayX=Math.max(0,Math.min(maxX,x));
    const displayY=Math.max(0,Math.min(maxY,y));
    const reduceMotion=window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const startX=Number.isFinite(trustedStartX)?Math.max(0,Math.min(maxX,trustedStartX)):(Number.isFinite(state.x)?state.x:Math.max(0,Math.min(maxX,window.innerWidth/2)));
    const startY=Number.isFinite(trustedStartY)?Math.max(0,Math.min(maxY,trustedStartY)):(Number.isFinite(state.y)?state.y:Math.max(0,Math.min(maxY,window.innerHeight/2)));
    state.host.dataset.phase=phase;
    state.host.dataset.action=action;
    const startTransform="translate3d("+startX+"px,"+startY+"px,0)";
    CSSStyleDeclaration.prototype.setProperty.call(state.host.style,"transition","none","important");
    const serializedStartTransform=__ysSetCursorTransform(state,startTransform);
    state.x=startX;state.y=startY;
    const startVerified=await __ysCursorPainted(state,HOST_ID,STATE_KEY,true);
    if(!startVerified||Date.now()>=DEADLINE||state.moveToken!==TOKEN||!__ysCursorTransformMatches(state,serializedStartTransform)){
      __ysCancelCursorMove(state,TOKEN);
      return {ok:false,reason:"cursor-overlay-unverified"};
    }
    const transition=(reduceMotion||document.hidden||${duration}===0)?"none":"transform ${duration}ms cubic-bezier(.22,.61,.36,1)";
    const finalTransform="translate3d("+displayX+"px,"+displayY+"px,0)";
    CSSStyleDeclaration.prototype.setProperty.call(state.host.style,"transition",transition,"important");
    const serializedFinalTransform=__ysSetCursorTransform(state,finalTransform);
    state.moveTransform=serializedFinalTransform;
    state.x=displayX; state.y=displayY;
    await Promise.resolve();
    if(Date.now()>=DEADLINE||state.moveToken!==TOKEN||!__ysPromoteCursor(state)||!__ysCursorHostValid(state,HOST_ID,STATE_KEY,true)||!__ysCursorTransformMatches(state,serializedFinalTransform)){
      __ysCancelCursorMove(state,TOKEN);
      return {ok:false,reason:"cursor-overlay-unverified"};
    }
    return {ok:true,x:displayX,y:displayY,startX:startX,startY:startY,kind:kind,reducedMotion:!!reduceMotion||document.hidden||${duration}===0};
  })()`;
}

function cursorMoveCleanupExpr(identity: CursorVisualIdentity, operationToken: string): string {
  return `(() => {
    ${CURSOR_INSTALL}
    const state=window[${JSON.stringify(identity.stateKey)}];
    if(state&&state.identity===${JSON.stringify(identity.stateKey)}&&state.hostId===${JSON.stringify(identity.hostId)}){
      return {ok:true,cancelled:__ysCancelCursorMove(state,${JSON.stringify(operationToken)})};
    }
    let cancelled=false;
    Array.from(Document.prototype.querySelectorAll.call(document,'[id="'+${JSON.stringify(identity.hostId)}+'"]')).forEach(function(host){cancelled=true;Element.prototype.remove.call(host);});
    return {ok:true,cancelled:cancelled};
  })()`;
}

export function cursorPathVerificationExpr(
  identity: CursorVisualIdentity,
  operationToken: string,
): string {
  return `(() => {
    ${CURSOR_INSTALL}
    const phase="path-verify";
    const HOST_ID=${JSON.stringify(identity.hostId)};
    const STATE_KEY=${JSON.stringify(identity.stateKey)};
    const TOKEN=${JSON.stringify(operationToken)};
    const state=window[STATE_KEY];
    if(!state||window[STATE_KEY]!==state||state.identity!==STATE_KEY||state.hostId!==HOST_ID||state.moveToken!==TOKEN||!state.host||!state.host.isConnected||state.host.ownerDocument!==document||(state.host.parentNode!==document.body&&state.host.parentNode!==document.documentElement)||state.host.id!==HOST_ID||state.host.getAttribute("aria-hidden")!=="true"||!state.host.hasAttribute("inert")||state.host.getAttribute("popover")!=="manual"||!state.root||state.feedback?.getRootNode()!==state.root||state.host.dataset.phase!=="move"||!__ysPromoteCursor(state)) return {ok:false};
    const style=getComputedStyle(state.host);
    const inlineStyle=state.host.style;
    const isNone=function(value){return value===""||value==="none"||value==="normal";};
    const overflowVisible=function(value){return value===""||value==="visible";};
    const opacity=style.opacity===""?1:Number(style.opacity);
    const transform=CSSStyleDeclaration.prototype.getPropertyValue.call(inlineStyle,"transform");
    const transformPriority=CSSStyleDeclaration.prototype.getPropertyPriority.call(inlineStyle,"transform");
    return {ok:style.position==="fixed"&&style.pointerEvents==="none"&&style.zIndex==="2147483647"&&style.width==="1px"&&style.height==="1px"&&style.display!=="none"&&style.visibility==="visible"&&opacity===1&&overflowVisible(style.overflowX)&&overflowVisible(style.overflowY)&&style.contentVisibility!=="hidden"&&isNone(style.clipPath)&&isNone(style.filter)&&isNone(style.maskImage)&&isNone(style.offsetPath)&&isNone(style.rotate)&&isNone(style.scale)&&isNone(style.translate)&&transformPriority==="important"&&typeof state.moveTransform==="string"&&transform===state.moveTransform};
  })()`;
}

async function verifyCursorPathVisible(
  cdp: CdpSession,
  identity: CursorVisualIdentity,
  operationToken: string,
): Promise<boolean> {
  const verified = await settleBounded(
    evalJsInCursorIsolatedWorld<CursorEvalResult>(
      cdp,
      cursorPathVerificationExpr(identity, operationToken),
      identity.mainDocumentIdentity,
    ),
    CURSOR_EVAL_CAP_MS,
  );
  return verified.status === "fulfilled" && verified.value?.ok === true;
}

/** Build a completion phase at the already-resolved point. */
export function cursorFeedbackExpr(
  target: Pick<AgentCursorTarget, "x" | "y"> | null,
  cursorAction: AgentCursorAction,
  details: CursorFeedbackDetails = {},
  options: CursorExpressionOptions = {},
): string {
  const x = target && Number.isFinite(target.x) ? target.x : null;
  const y = target && Number.isFinite(target.y) ? target.y : null;
  const deltaX = Number.isFinite(details.deltaX) ? Number(details.deltaX) : 0;
  const deltaY = Number.isFinite(details.deltaY) ? Number(details.deltaY) : 0;
  const label = typeof details.label === "string" ? details.label.slice(0, 8) : "";
  const identity =
    options.identity ??
    ({
      mainDocumentIdentity: "direct-expression",
      hostId: "__y_space_agent_cursor__",
      stateKey: "__y_space_agent_cursor_state__",
    } satisfies CursorVisualIdentity);
  const operationToken = options.operationToken ?? `direct-feedback-${randomUUID()}`;
  const deadlineEpochMs = Number.isFinite(options.deadlineEpochMs)
    ? Number(options.deadlineEpochMs)
    : Date.now() + CURSOR_EVAL_CAP_MS;
  return `(async () => {
    ${CURSOR_INSTALL}
    const phase="complete";
    const HOST_ID=${JSON.stringify(identity.hostId)};
    const STATE_KEY=${JSON.stringify(identity.stateKey)};
    const TOKEN=${JSON.stringify(operationToken)};
    const DEADLINE=${deadlineEpochMs};
    const action=${JSON.stringify(cursorAction)};
    const x=${x === null ? "null" : x};
    const y=${y === null ? "null" : y};
    const deltaX=${deltaX};
    const deltaY=${deltaY};
    const label=${JSON.stringify(label)};
    if(Date.now()>=DEADLINE) return {ok:false,reason:"feedback-deadline-expired"};
    const state=__ysAgentCursor(HOST_ID,STATE_KEY);
    state.feedbackToken=TOKEN;
    state.sessionHidden=false;
    __ysApplyCursorVisibility(state);
    const finalX=Number.isFinite(x)?x:state.x;
    const finalY=Number.isFinite(y)?y:state.y;
    if(!Number.isFinite(finalX)||!Number.isFinite(finalY)) return {ok:false};
    const finalTransform="translate3d("+finalX+"px,"+finalY+"px,0)";
    CSSStyleDeclaration.prototype.setProperty.call(state.host.style,"transition","none","important");
    const serializedFinalTransform=__ysSetCursorTransform(state,finalTransform);
    state.x=finalX; state.y=finalY;
    state.host.dataset.phase=phase;
    state.host.dataset.action=action;
    __ysStopFeedback(state);
    const verified=await __ysCursorPainted(state,HOST_ID,STATE_KEY,true);
    if(!verified||Date.now()>=DEADLINE||state.feedbackToken!==TOKEN||!__ysCursorTransformMatches(state,serializedFinalTransform)) return {ok:false,reason:"cursor-overlay-unverified"};
    const feedback=state.feedback;
    feedback.dataset.action=action;
    feedback.textContent=__ysFeedbackGlyph(action,label,deltaX,deltaY);
    const reduceMotion=window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if(reduceMotion){
      feedback.style.transform="translate(-50%,-50%) scale(1)";
      feedback.style.opacity="1";
      state.feedbackTimer=setTimeout(function(){ feedback.style.opacity="0"; state.feedbackTimer=null; },180);
    }else{
      const animation=Element.prototype.animate.call(feedback,
        [
          {opacity:0,transform:"translate(-50%,-50%) scale(.55)"},
          {opacity:1,transform:"translate(-50%,-50%) scale(1)",offset:.22},
          {opacity:0,transform:"translate(-50%,-50%) scale(1.65)"}
        ],
        {duration:520,easing:"cubic-bezier(.2,.75,.25,1)"}
      );
      animation.onfinish=function(){ feedback.style.opacity="0"; };
    }
    return {ok:true,x:finalX,y:finalY};
  })()`;
}

function isCursorPoint(
  value: CursorEvalResult,
): value is CursorEvalResult & { x: number; y: number } {
  return (
    value?.ok === true &&
    typeof value.x === "number" &&
    Number.isFinite(value.x) &&
    typeof value.y === "number" &&
    Number.isFinite(value.y)
  );
}

async function dispatchBoundedPointerMove(
  cdp: CdpSession,
  target: Pick<AgentCursorTarget, "x" | "y">,
  mainDocumentIdentity: string | null,
  authorize?: NativeInputAuthorization,
  verifyVisible?: () => Promise<boolean>,
): Promise<NativeInputOutcome> {
  if (!mainDocumentIdentity || (await readMainDocumentIdentity(cdp)) !== mainDocumentIdentity) {
    return { status: "failed", reason: "target-document-changed" };
  }
  if (verifyVisible && !(await verifyVisible())) {
    return { status: "failed", reason: "cursor-overlay-unavailable" };
  }
  const moved = await dispatchInputBounded(
    cdp,
    "Input.dispatchMouseEvent",
    {
      type: "mouseMoved",
      x: target.x,
      y: target.y,
    },
    authorize,
    POINTER_MOVE_CAP_MS,
  );
  if (moved.status === "fulfilled") {
    // A navigation can commit while Chromium is accepting a move. Recheck
    // before remembering the position or allowing the next sample so no later
    // input from this path can reach the replacement document.
    if ((await readMainDocumentIdentity(cdp)) !== mainDocumentIdentity) {
      return completedPointerMoveAmbiguity("target-document-changed");
    }
    if (verifyVisible && !(await verifyVisible())) {
      return completedPointerMoveAmbiguity("cursor-overlay-unavailable");
    }
    nativePointerPositionBySession.set(cdp, {
      mainDocumentIdentity,
      x: target.x,
      y: target.y,
    });
    return { status: "completed" };
  }
  if (moved.status === "unauthorized") {
    return { status: "failed", reason: PRESENTATION_AUTHORIZATION_REVOKED };
  }
  if (moved.status === "timed-out") {
    return { status: "ambiguous", reason: "pointer-move-timeout" };
  }
  return { status: "ambiguous", reason: "pointer-move-rejected", clickDispatched: false };
}

function cubicBezierCoordinate(t: number, p1: number, p2: number): number {
  const inverse = 1 - t;
  return 3 * inverse * inverse * t * p1 + 3 * inverse * t * t * p2 + t * t * t;
}

/** Solve x(s)=time for the CSS cubic-bezier(.22,.61,.36,1), then return y(s). */
function cursorEase(time: number): number {
  const clamped = Math.max(0, Math.min(1, time));
  let low = 0;
  let high = 1;
  for (let i = 0; i < 12; i += 1) {
    const mid = (low + high) / 2;
    if (cubicBezierCoordinate(mid, 0.22, 0.36) < clamped) low = mid;
    else high = mid;
  }
  return cubicBezierCoordinate((low + high) / 2, 0.61, 1);
}

async function dispatchPointerPath(
  cdp: CdpSession,
  start: Pick<AgentCursorTarget, "x" | "y">,
  end: Pick<AgentCursorTarget, "x" | "y">,
  reducedMotion: boolean,
  mainDocumentIdentity: string | null,
  authorize?: NativeInputAuthorization,
  verifyVisible?: () => Promise<boolean>,
): Promise<NativeInputOutcome> {
  if (reducedMotion || (start.x === end.x && start.y === end.y)) {
    return await dispatchBoundedPointerMove(
      cdp,
      end,
      mainDocumentIdentity,
      authorize,
      verifyVisible,
    );
  }
  const startedAt = Date.now();
  let completedMove = false;
  for (let sample = 1; sample <= POINTER_PATH_SAMPLES; sample += 1) {
    const dueAt = startedAt + (GLIDE_MS * sample) / POINTER_PATH_SAMPLES;
    const delay = Math.max(0, dueAt - Date.now());
    if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
    const progress = cursorEase(sample / POINTER_PATH_SAMPLES);
    const point =
      sample === POINTER_PATH_SAMPLES
        ? end
        : {
            x: start.x + (end.x - start.x) * progress,
            y: start.y + (end.y - start.y) * progress,
          };
    const outcome = await dispatchBoundedPointerMove(
      cdp,
      point,
      mainDocumentIdentity,
      authorize,
      verifyVisible,
    );
    if (outcome.status !== "completed") {
      return completedMove &&
        !(outcome.status === "ambiguous" && outcome.partial === "pointer-move")
        ? completedPointerMoveAmbiguity(outcome.reason)
        : outcome;
    }
    completedMove = true;
  }
  return { status: "completed" };
}

interface DomDocumentResult {
  root?: { nodeId?: number };
}

interface DomQuerySelectorResult {
  nodeId?: number;
}

interface DomDescribeNodeResult {
  node?: {
    nodeId?: number;
    backendNodeId?: number;
    nodeName?: string;
  };
}

interface DomBoxModelResult {
  model?: {
    border?: number[];
    width?: number;
    height?: number;
  };
}

interface PageLayoutMetricsResult {
  cssVisualViewport?: {
    clientWidth?: number;
    clientHeight?: number;
    pageX?: number;
    pageY?: number;
  };
  cssLayoutViewport?: {
    clientWidth?: number;
    clientHeight?: number;
    pageX?: number;
    pageY?: number;
  };
  layoutViewport?: {
    clientWidth?: number;
    clientHeight?: number;
    pageX?: number;
    pageY?: number;
  };
}

interface PageFrameTreeResult {
  frameTree?: { frame?: { id?: string; loaderId?: string } };
}

interface PageCreateIsolatedWorldResult {
  executionContextId?: number;
}

interface CursorIsolatedWorld {
  frameId: string;
  mainDocumentIdentity: string;
  executionContextId: number;
}

interface RuntimeResolveNodeResult {
  object?: { objectId?: string };
}

interface RuntimeCallFunctionResult {
  result?: { value?: unknown };
  exceptionDetails?: unknown;
}

interface BackendTargetState {
  connected: boolean;
  disabled: boolean;
  visible: boolean;
}

interface EditableTargetState {
  active: boolean;
  editable: boolean;
  length?: number;
}

interface TextReplaceSelectionState {
  kind: "value" | "other";
  observable: boolean;
  selected: boolean;
}

interface ToggleTargetState {
  ok: boolean;
  checked?: boolean;
  type?: "checkbox" | "radio";
}

interface SelectTargetState {
  ok: boolean;
  currentIndex?: number;
  targetIndex?: number;
  enabledSteps?: number;
  targetValue?: string;
  targetText?: string;
}

interface ResolvedElementCursorPoint {
  mainDocumentIdentity: string;
  x: number;
  y: number;
  kind: "element";
  backendNodeId: number;
  executionContextId: number;
  nodeName: string;
  pageX?: number;
  pageY?: number;
  documentX?: number;
  documentY?: number;
}

interface ResolvedViewportCursorPoint {
  mainDocumentIdentity: string;
  x: number;
  y: number;
  kind: "viewport";
}

type ResolvedCursorPoint = ResolvedElementCursorPoint | ResolvedViewportCursorPoint;

const TARGET_STATE_FUNCTION = `function () {
  const el=this;
  if(!(el instanceof Element)||!el.isConnected){
    return {connected:false,disabled:false,visible:false};
  }
  const matches=Element.prototype.matches;
  const getAttribute=Element.prototype.getAttribute;
  const getRootNode=Node.prototype.getRootNode;
  let disabled=false;
  let visible=true;
  let current=el;
  while(current instanceof Element){
    if(matches.call(current,":disabled")||getAttribute.call(current,"aria-disabled")==="true"||getAttribute.call(current,"inert")!==null){
      disabled=true;
    }
    const style=getComputedStyle(current);
    const opacity=Number(style.opacity);
    if(style.display==="none"||style.visibility==="hidden"||style.visibility==="collapse"||style.pointerEvents==="none"||style.contentVisibility==="hidden"||!Number.isFinite(opacity)||opacity<=0){
      visible=false;
    }
    if(current.parentElement){ current=current.parentElement; continue; }
    const root=Reflect.apply(getRootNode,current,[]);
    current=typeof ShadowRoot==="function"&&root instanceof ShadowRoot?root.host:null;
  }
  return {connected:true,disabled:disabled,visible:visible};
}`;

const TARGET_HIT_RELATION_FUNCTION = `function (hit) {
  if(!(hit instanceof Node)) return "none";
  if(this===hit) return "target";
  const matches=Element.prototype.matches;
  const getAttribute=Element.prototype.getAttribute;
  const getRootNode=Node.prototype.getRootNode;
  function composedParent(node){
    if(node.parentNode) return node.parentNode;
    const root=Reflect.apply(getRootNode,node,[]);
    return typeof ShadowRoot==="function"&&root instanceof ShadowRoot?root.host:null;
  }
  function separatelyInteractive(node){
    if(!(node instanceof Element)||node===this) return false;
    if(matches.call(node,'a[href],button,input,select,textarea,summary,label,iframe,audio[controls],video[controls],[contenteditable=""],[contenteditable="true"]')) return true;
    const role=String(getAttribute.call(node,"role")||"").toLowerCase();
    if(new Set(["button","checkbox","link","menuitem","option","radio","slider","spinbutton","switch","tab","textbox","treeitem"]).has(role)) return true;
    const tabIndex=getAttribute.call(node,"tabindex");
    return tabIndex!==null&&Number(tabIndex)>=0;
  }
  let current=hit;
  while(current&&current!==this){
    if(separatelyInteractive.call(this,current)) return "interactive-descendant";
    current=composedParent(current);
  }
  if(current===this) return "descendant";
  if(!(hit instanceof Element)||typeof HTMLLabelElement!=="function") return "none";
  let label=hit;
  while(label&&!(label instanceof HTMLLabelElement)) label=composedParent(label);
  if(!(label instanceof HTMLLabelElement)) return "none";
  const descriptor=Object.getOwnPropertyDescriptor(HTMLLabelElement.prototype,"control");
  const control=descriptor&&descriptor.get?Reflect.apply(descriptor.get,label,[]):null;
  if(control!==this) return "none";
  current=hit;
  while(current&&current!==label){
    if(separatelyInteractive.call(this,current)) return "interactive-descendant";
    current=composedParent(current);
  }
  return "label";
}`;

/** Electron's CDP guest target currently rejects DOM.getNodeForLocation even
 * for in-viewport points. This isolated-world fallback still starts from the
 * exact backend node and uses the world's untouched DOM intrinsic; page code
 * cannot supply a selector, node identity, or hit-test result. */
const TARGET_POINT_HIT_RELATION_FUNCTION = `function (x,y) {
  if(!(this instanceof Node)||!Number.isFinite(x)||!Number.isFinite(y)) return "none";
  const elementFromPoint=Document.prototype.elementFromPoint;
  if(typeof elementFromPoint!=="function") return "none";
  const hit=Reflect.apply(elementFromPoint,document,[x,y]);
  if(!(hit instanceof Node)) return "none";
  if(this===hit) return "target";
  const matches=Element.prototype.matches;
  const getAttribute=Element.prototype.getAttribute;
  const getRootNode=Node.prototype.getRootNode;
  function composedParent(node){
    if(node.parentNode) return node.parentNode;
    const root=Reflect.apply(getRootNode,node,[]);
    return typeof ShadowRoot==="function"&&root instanceof ShadowRoot?root.host:null;
  }
  function separatelyInteractive(node){
    if(!(node instanceof Element)||node===this) return false;
    if(matches.call(node,'a[href],button,input,select,textarea,summary,label,iframe,audio[controls],video[controls],[contenteditable=""],[contenteditable="true"]')) return true;
    const role=String(getAttribute.call(node,"role")||"").toLowerCase();
    if(new Set(["button","checkbox","link","menuitem","option","radio","slider","spinbutton","switch","tab","textbox","treeitem"]).has(role)) return true;
    const tabIndex=getAttribute.call(node,"tabindex");
    return tabIndex!==null&&Number(tabIndex)>=0;
  }
  let current=hit;
  while(current&&current!==this){
    if(separatelyInteractive.call(this,current)) return "interactive-descendant";
    current=composedParent(current);
  }
  if(current===this) return "descendant";
  if(!(hit instanceof Element)||typeof HTMLLabelElement!=="function") return "none";
  let label=hit;
  while(label&&!(label instanceof HTMLLabelElement)) label=composedParent(label);
  if(!(label instanceof HTMLLabelElement)) return "none";
  const descriptor=Object.getOwnPropertyDescriptor(HTMLLabelElement.prototype,"control");
  const control=descriptor&&descriptor.get?Reflect.apply(descriptor.get,label,[]):null;
  if(control!==this) return "none";
  current=hit;
  while(current&&current!==label){
    if(separatelyInteractive.call(this,current)) return "interactive-descendant";
    current=composedParent(current);
  }
  return "label";
}`;

const TARGET_IS_ACTIVE_FUNCTION = `function () {
  const documentActiveDescriptor=Object.getOwnPropertyDescriptor(Document.prototype,"activeElement");
  const shadowActiveDescriptor=typeof ShadowRoot==="function"?Object.getOwnPropertyDescriptor(ShadowRoot.prototype,"activeElement"):null;
  const contains=Node.prototype.contains;
  let active=documentActiveDescriptor&&documentActiveDescriptor.get?Reflect.apply(documentActiveDescriptor.get,document,[]):null;
  while(active){
    if(active===this||contains.call(this,active)) return true;
    const shadowRoot=active.shadowRoot;
    if(!shadowRoot||!shadowActiveDescriptor||!shadowActiveDescriptor.get) break;
    const nested=Reflect.apply(shadowActiveDescriptor.get,shadowRoot,[]);
    if(!nested||nested===active) break;
    active=nested;
  }
  return false;
}`;

const TARGET_EDITABLE_STATE_FUNCTION = `function () {
  const contains=Node.prototype.contains;
  const documentActiveDescriptor=Object.getOwnPropertyDescriptor(Document.prototype,"activeElement");
  const active=documentActiveDescriptor&&documentActiveDescriptor.get?Reflect.apply(documentActiveDescriptor.get,document,[]):null;
  const contentEditableDescriptor=typeof HTMLElement==="function"?Object.getOwnPropertyDescriptor(HTMLElement.prototype,"isContentEditable"):null;
  const isContentEditable=!!(contentEditableDescriptor&&contentEditableDescriptor.get&&Reflect.apply(contentEditableDescriptor.get,this,[]));
  const activeMatches=active===this||contains.call(this,active)||(isContentEditable&&active instanceof Node&&contains.call(active,this));
  const input=this instanceof HTMLInputElement;
  const textarea=this instanceof HTMLTextAreaElement;
  let editable=false;
  let content=null;
  if(input){
    const typeDescriptor=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"type");
    const readOnlyDescriptor=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"readOnly");
    const type=String(typeDescriptor&&typeDescriptor.get?Reflect.apply(typeDescriptor.get,this,[]):"").toLowerCase();
    const readOnly=!!(readOnlyDescriptor&&readOnlyDescriptor.get&&Reflect.apply(readOnlyDescriptor.get,this,[]));
    editable=!readOnly&&!new Set(["button","checkbox","color","file","hidden","image","radio","range","reset","submit"]).has(type);
    const valueDescriptor=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value");
    content=valueDescriptor&&valueDescriptor.get?Reflect.apply(valueDescriptor.get,this,[]):null;
  }else if(textarea){
    const readOnlyDescriptor=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"readOnly");
    editable=!(readOnlyDescriptor&&readOnlyDescriptor.get&&Reflect.apply(readOnlyDescriptor.get,this,[]));
    const valueDescriptor=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value");
    content=valueDescriptor&&valueDescriptor.get?Reflect.apply(valueDescriptor.get,this,[]):null;
  }else{
    editable=isContentEditable;
    const textDescriptor=Object.getOwnPropertyDescriptor(Node.prototype,"textContent");
    content=textDescriptor&&textDescriptor.get?Reflect.apply(textDescriptor.get,this,[]):null;
  }
  return {active:activeMatches,editable:editable,length:typeof content==="string"?content.length:null};
}`;

const TARGET_REPLACE_SELECTION_FUNCTION = `function () {
  let proto=null;
  if(this instanceof HTMLInputElement) proto=HTMLInputElement.prototype;
  else if(this instanceof HTMLTextAreaElement) proto=HTMLTextAreaElement.prototype;
  else return {kind:"other",observable:false,selected:false};
  const valueDescriptor=Object.getOwnPropertyDescriptor(proto,"value");
  const startDescriptor=Object.getOwnPropertyDescriptor(proto,"selectionStart");
  const endDescriptor=Object.getOwnPropertyDescriptor(proto,"selectionEnd");
  if(!valueDescriptor||!valueDescriptor.get||!startDescriptor||!startDescriptor.get||!endDescriptor||!endDescriptor.get){
    return {kind:"value",observable:false,selected:false};
  }
  try{
    const value=Reflect.apply(valueDescriptor.get,this,[]);
    const start=Reflect.apply(startDescriptor.get,this,[]);
    const end=Reflect.apply(endDescriptor.get,this,[]);
    const observable=typeof value==="string"&&Number.isInteger(start)&&Number.isInteger(end);
    return {kind:"value",observable:observable,selected:observable&&start===0&&end===value.length};
  }catch{
    return {kind:"value",observable:false,selected:false};
  }
}`;

const TARGET_TEXT_MATCH_FUNCTION = `function (expected,replace,beforeLength) {
  let actual=null;
  if(this instanceof HTMLInputElement){
    const descriptor=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value");
    actual=descriptor&&descriptor.get?Reflect.apply(descriptor.get,this,[]):null;
  }else if(this instanceof HTMLTextAreaElement){
    const descriptor=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value");
    actual=descriptor&&descriptor.get?Reflect.apply(descriptor.get,this,[]):null;
  }else{
    const contentEditableDescriptor=typeof HTMLElement==="function"?Object.getOwnPropertyDescriptor(HTMLElement.prototype,"isContentEditable"):null;
    const isContentEditable=!!(contentEditableDescriptor&&contentEditableDescriptor.get&&Reflect.apply(contentEditableDescriptor.get,this,[]));
    if(isContentEditable){
      const textDescriptor=Object.getOwnPropertyDescriptor(Node.prototype,"textContent");
      actual=textDescriptor&&textDescriptor.get?Reflect.apply(textDescriptor.get,this,[]):null;
    }
  }
  if(typeof actual!=="string") return false;
  if(replace) return actual===expected;
  return Number.isInteger(beforeLength)&&actual.length===beforeLength+expected.length&&actual.endsWith(expected);
}`;

const TARGET_TOGGLE_STATE_FUNCTION = `function () {
  if(!(this instanceof HTMLInputElement)) return {ok:false};
  const typeDescriptor=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"type");
  const checkedDescriptor=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"checked");
  const type=String(typeDescriptor&&typeDescriptor.get?Reflect.apply(typeDescriptor.get,this,[]):"").toLowerCase();
  if((type!=="checkbox"&&type!=="radio")||!checkedDescriptor||!checkedDescriptor.get) return {ok:false};
  return {ok:true,checked:!!Reflect.apply(checkedDescriptor.get,this,[]),type:type};
}`;

const TARGET_SELECT_METADATA_FUNCTION = `function (requested) {
  if(!(this instanceof HTMLSelectElement)) return {ok:false};
  const disabledDescriptor=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"disabled");
  if(disabledDescriptor&&disabledDescriptor.get&&Reflect.apply(disabledDescriptor.get,this,[])) return {ok:false};
  const optionsDescriptor=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"options");
  const selectedIndexDescriptor=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"selectedIndex");
  if(!optionsDescriptor||!optionsDescriptor.get||!selectedIndexDescriptor||!selectedIndexDescriptor.get) return {ok:false};
  const options=Array.from(Reflect.apply(optionsDescriptor.get,this,[]));
  const valueDescriptor=Object.getOwnPropertyDescriptor(HTMLOptionElement.prototype,"value");
  const disabledOptionDescriptor=Object.getOwnPropertyDescriptor(HTMLOptionElement.prototype,"disabled");
  const disabledGroupDescriptor=typeof HTMLOptGroupElement==="function"?Object.getOwnPropertyDescriptor(HTMLOptGroupElement.prototype,"disabled"):null;
  const textDescriptor=Object.getOwnPropertyDescriptor(Node.prototype,"textContent");
  function optionDisabled(option){
    const ownDisabled=!!(disabledOptionDescriptor&&disabledOptionDescriptor.get&&Reflect.apply(disabledOptionDescriptor.get,option,[]));
    const parent=option.parentElement;
    const groupDisabled=parent instanceof HTMLOptGroupElement&&!!(disabledGroupDescriptor&&disabledGroupDescriptor.get&&Reflect.apply(disabledGroupDescriptor.get,parent,[]));
    return ownDisabled||groupDisabled;
  }
  const targetIndex=options.findIndex(function(option){
    const value=valueDescriptor&&valueDescriptor.get?String(Reflect.apply(valueDescriptor.get,option,[])):"";
    const text=textDescriptor&&textDescriptor.get?String(Reflect.apply(textDescriptor.get,option,[])||"").trim():"";
    return value===requested||text===requested;
  });
  if(targetIndex<0||optionDisabled(options[targetIndex])) return {ok:false};
  const enabledOptions=options.filter(function(option){return !optionDisabled(option);});
  const enabledSteps=enabledOptions.indexOf(options[targetIndex]);
  if(enabledSteps<0) return {ok:false};
  return {
    ok:true,
    currentIndex:Number(Reflect.apply(selectedIndexDescriptor.get,this,[])),
    targetIndex:targetIndex,
    enabledSteps:enabledSteps,
    targetValue:valueDescriptor&&valueDescriptor.get?String(Reflect.apply(valueDescriptor.get,options[targetIndex],[])):"",
    targetText:textDescriptor&&textDescriptor.get?String(Reflect.apply(textDescriptor.get,options[targetIndex],[])||"").trim():""
  };
}`;

const TARGET_SELECT_MATCH_FUNCTION = `function (targetIndex,targetValue,targetText) {
  if(!(this instanceof HTMLSelectElement)) return false;
  const selectedIndexDescriptor=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"selectedIndex");
  const optionsDescriptor=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"options");
  const valueDescriptor=Object.getOwnPropertyDescriptor(HTMLOptionElement.prototype,"value");
  const textDescriptor=Object.getOwnPropertyDescriptor(Node.prototype,"textContent");
  if(!selectedIndexDescriptor||!selectedIndexDescriptor.get||!optionsDescriptor||!optionsDescriptor.get) return false;
  const selectedIndex=Number(Reflect.apply(selectedIndexDescriptor.get,this,[]));
  const options=Array.from(Reflect.apply(optionsDescriptor.get,this,[]));
  const option=options[selectedIndex];
  if(selectedIndex!==targetIndex||!(option instanceof HTMLOptionElement)) return false;
  const actualValue=valueDescriptor&&valueDescriptor.get?String(Reflect.apply(valueDescriptor.get,option,[])):"";
  const actualText=textDescriptor&&textDescriptor.get?String(Reflect.apply(textDescriptor.get,option,[])||"").trim():"";
  return actualValue===targetValue&&actualText===targetText;
}`;

const TARGET_SELECT_POPUP_OPEN_FUNCTION = `function () {
  if(!(this instanceof HTMLSelectElement)) return false;
  const matches=Element.prototype.matches;
  if(typeof matches!=="function") return false;
  try{return !!Reflect.apply(matches,this,[":open"]);}catch{return false;}
}`;

const cursorIsolatedWorldBySession = new WeakMap<CdpSession, CursorIsolatedWorld>();
let cursorRemoteObjectGroupCounter = 0;

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

interface MainDocumentFrame {
  frameId: string;
  mainDocumentIdentity: string;
}

async function readMainDocumentFrame(cdp: CdpSession): Promise<MainDocumentFrame | null> {
  const frameTree = await settleBounded(
    cdp.send<PageFrameTreeResult>("Page.getFrameTree"),
    POINTER_ACTION_CAP_MS,
  );
  if (frameTree.status !== "fulfilled") return null;
  const frameId = frameTree.value.frameTree?.frame?.id;
  const loaderId = frameTree.value.frameTree?.frame?.loaderId;
  if (!frameId || !loaderId) return null;
  return {
    frameId,
    mainDocumentIdentity: `${frameId.length}:${frameId}:${loaderId.length}:${loaderId}`,
  };
}

async function createCursorIsolatedWorld(
  cdp: CdpSession,
  expectedMainDocumentIdentity?: string,
): Promise<CursorIsolatedWorld | null> {
  const frame = await readMainDocumentFrame(cdp);
  if (!frame) return null;
  if (
    expectedMainDocumentIdentity !== undefined &&
    frame.mainDocumentIdentity !== expectedMainDocumentIdentity
  ) {
    return null;
  }
  const cached = cursorIsolatedWorldBySession.get(cdp);
  if (
    cached?.frameId === frame.frameId &&
    cached.mainDocumentIdentity === frame.mainDocumentIdentity
  ) {
    return cached;
  }
  const world = await settleBounded(
    cdp.send<PageCreateIsolatedWorldResult>("Page.createIsolatedWorld", {
      frameId: frame.frameId,
      worldName: CURSOR_ISOLATED_WORLD,
    }),
    POINTER_ACTION_CAP_MS,
  );
  const executionContextId =
    world.status === "fulfilled" ? world.value.executionContextId : undefined;
  if (!positiveInteger(executionContextId)) return null;
  const created = {
    frameId: frame.frameId,
    mainDocumentIdentity: frame.mainDocumentIdentity,
    executionContextId,
  };
  cursorIsolatedWorldBySession.set(cdp, created);
  return created;
}

function invalidateCursorIsolatedWorld(cdp: CdpSession, executionContextId: number): void {
  if (cursorIsolatedWorldBySession.get(cdp)?.executionContextId === executionContextId) {
    cursorIsolatedWorldBySession.delete(cdp);
  }
}

function nextCursorRemoteObjectGroup(): string {
  cursorRemoteObjectGroupCounter += 1;
  return `${CURSOR_ISOLATED_WORLD}-${cursorRemoteObjectGroupCounter}`;
}

async function releaseRemoteObjectGroup(cdp: CdpSession, objectGroup: string): Promise<void> {
  await settleBounded(
    Promise.resolve().then(() => cdp.send("Runtime.releaseObjectGroup", { objectGroup })),
    CURSOR_EVAL_CAP_MS,
  );
}

async function releaseRemoteObjects(cdp: CdpSession, objectIds: string[]): Promise<void> {
  await Promise.all(
    objectIds.map(async (objectId) => {
      await settleBounded(
        Promise.resolve().then(() => cdp.send("Runtime.releaseObject", { objectId })),
        CURSOR_EVAL_CAP_MS,
      );
    }),
  );
}

async function resolveNodeInObjectGroup(
  cdp: CdpSession,
  backendNodeId: number,
  executionContextId: number,
  objectGroup: string,
): Promise<BoundedResult<RuntimeResolveNodeResult>> {
  const pending = Promise.resolve().then(() =>
    cdp.send<RuntimeResolveNodeResult>("DOM.resolveNode", {
      backendNodeId,
      executionContextId,
      objectGroup,
    }),
  );
  const result = await settleBounded(pending, POINTER_ACTION_CAP_MS);
  if (result.status === "timed-out") {
    // DOM.resolveNode may allocate a remote object after our deadline. A group
    // release performed before that response cannot reclaim the late object,
    // so release the same group again once the transport eventually settles.
    void pending.then(
      () => releaseRemoteObjectGroup(cdp, objectGroup),
      () => {},
    );
  }
  return result;
}

async function callIsolatedNode<T>(
  cdp: CdpSession,
  backendNodeId: number,
  executionContextId: number,
  functionDeclaration: string,
  argumentBackendNodeIds: number[] = [],
  argumentValues: unknown[] = [],
): Promise<BoundedResult<T>> {
  const objectGroup = nextCursorRemoteObjectGroup();
  const objectIds: string[] = [];
  try {
    const resolvedTarget = await resolveNodeInObjectGroup(
      cdp,
      backendNodeId,
      executionContextId,
      objectGroup,
    );
    if (resolvedTarget.status !== "fulfilled") {
      if (resolvedTarget.status === "rejected") {
        invalidateCursorIsolatedWorld(cdp, executionContextId);
      }
      return resolvedTarget;
    }
    const targetObjectId = resolvedTarget.value.object?.objectId;
    if (!targetObjectId) {
      invalidateCursorIsolatedWorld(cdp, executionContextId);
      return { status: "rejected" };
    }
    objectIds.push(targetObjectId);
    const argumentObjectIds: string[] = [];
    for (const argumentBackendNodeId of argumentBackendNodeIds) {
      const resolvedArgument = await resolveNodeInObjectGroup(
        cdp,
        argumentBackendNodeId,
        executionContextId,
        objectGroup,
      );
      if (resolvedArgument.status !== "fulfilled") return resolvedArgument;
      const objectId = resolvedArgument.value.object?.objectId;
      if (!objectId) return { status: "rejected" };
      objectIds.push(objectId);
      argumentObjectIds.push(objectId);
    }

    const called = await settleBounded(
      cdp.send<RuntimeCallFunctionResult>("Runtime.callFunctionOn", {
        objectId: targetObjectId,
        functionDeclaration,
        arguments: [
          ...argumentObjectIds.map((objectId) => ({ objectId })),
          ...argumentValues.map((value) => ({ value })),
        ],
        returnByValue: true,
        awaitPromise: false,
        userGesture: false,
        objectGroup,
      }),
      POINTER_ACTION_CAP_MS,
    );
    if (called.status !== "fulfilled") {
      if (called.status === "rejected") {
        invalidateCursorIsolatedWorld(cdp, executionContextId);
      }
      return called;
    }
    if (called.value.exceptionDetails || !called.value.result) {
      invalidateCursorIsolatedWorld(cdp, executionContextId);
      return { status: "rejected" };
    }
    return { status: "fulfilled", value: called.value.result.value as T };
  } finally {
    await releaseRemoteObjects(cdp, objectIds);
    await releaseRemoteObjectGroup(cdp, objectGroup);
  }
}

async function inspectBackendTarget(
  cdp: CdpSession,
  target: Pick<ResolvedElementCursorPoint, "backendNodeId" | "executionContextId">,
): Promise<BoundedResult<BackendTargetState>> {
  return await callIsolatedNode<BackendTargetState>(
    cdp,
    target.backendNodeId,
    target.executionContextId,
    TARGET_STATE_FUNCTION,
  );
}

interface ViewportMetrics {
  width: number;
  height: number;
  pageX?: number;
  pageY?: number;
}

interface BackendNodePoint {
  x: number;
  y: number;
  pageX?: number;
  pageY?: number;
  documentX?: number;
  documentY?: number;
}

function viewportMetrics(metrics: PageLayoutMetricsResult): ViewportMetrics | null {
  const viewport = metrics.cssVisualViewport ?? metrics.cssLayoutViewport ?? metrics.layoutViewport;
  const width = viewport?.clientWidth;
  const height = viewport?.clientHeight;
  if (
    typeof width !== "number" ||
    !Number.isFinite(width) ||
    width <= 0 ||
    typeof height !== "number" ||
    !Number.isFinite(height) ||
    height <= 0
  ) {
    return null;
  }
  const pageX = viewport?.pageX;
  const pageY = viewport?.pageY;
  return {
    width,
    height,
    ...(typeof pageX === "number" && Number.isFinite(pageX) ? { pageX } : {}),
    ...(typeof pageY === "number" && Number.isFinite(pageY) ? { pageY } : {}),
  };
}

async function readViewportMetrics(
  cdp: CdpSession,
): Promise<BoundedResult<ViewportMetrics | null>> {
  const metrics = await settleBounded(
    cdp.send<PageLayoutMetricsResult>("Page.getLayoutMetrics"),
    POINTER_ACTION_CAP_MS,
  );
  if (metrics.status !== "fulfilled") return metrics;
  return { status: "fulfilled", value: viewportMetrics(metrics.value) };
}

async function readViewportSize(
  cdp: CdpSession,
): Promise<BoundedResult<{ width: number; height: number } | null>> {
  const metrics = await readViewportMetrics(cdp);
  if (metrics.status !== "fulfilled" || !metrics.value) return metrics;
  return {
    status: "fulfilled",
    value: { width: metrics.value.width, height: metrics.value.height },
  };
}

/** CDP supplies both values from the browser process. Unlike URL or page
 * globals, this identity cannot be forged by site JavaScript and changes when
 * the main document receives a new loader. */
async function readMainDocumentIdentity(cdp: CdpSession): Promise<string | null> {
  return (await readMainDocumentFrame(cdp))?.mainDocumentIdentity ?? null;
}

function quadArea(quad: number[]): number {
  let area = 0;
  for (let index = 0; index < 4; index += 1) {
    const next = (index + 1) % 4;
    area += quad[index * 2]! * quad[next * 2 + 1]! - quad[next * 2]! * quad[index * 2 + 1]!;
  }
  return Math.abs(area / 2);
}

async function readBackendNodePoint(
  cdp: CdpSession,
  backendNodeId: number,
): Promise<BoundedResult<BackendNodePoint | null>> {
  // Box quads use viewport coordinates. Bracket the read with browser-process
  // viewport metrics so a scroll that races the query cannot manufacture a
  // false document-space invariant. One retry is enough; continued movement
  // remains fail-closed.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = await readViewportMetrics(cdp);
    if (before.status !== "fulfilled") return before;
    if (!before.value) return { status: "fulfilled", value: null };
    const box = await settleBounded(
      cdp.send<DomBoxModelResult>("DOM.getBoxModel", { backendNodeId }),
      POINTER_ACTION_CAP_MS,
    );
    if (box.status !== "fulfilled") return box;
    const border = box.value.model?.border;
    if (
      !Array.isArray(border) ||
      border.length < 8 ||
      border.slice(0, 8).some((coordinate) => !Number.isFinite(coordinate)) ||
      quadArea(border) <= 0
    ) {
      return { status: "fulfilled", value: null };
    }
    const after = await readViewportMetrics(cdp);
    if (after.status !== "fulfilled") return after;
    if (!after.value) return { status: "fulfilled", value: null };
    const beforeHasOrigin = before.value.pageX !== undefined && before.value.pageY !== undefined;
    const afterHasOrigin = after.value.pageX !== undefined && after.value.pageY !== undefined;
    const originStable =
      beforeHasOrigin === afterHasOrigin &&
      (!beforeHasOrigin ||
        (Math.abs(after.value.pageX! - before.value.pageX!) <= 0.5 &&
          Math.abs(after.value.pageY! - before.value.pageY!) <= 0.5));
    if (!originStable) {
      if (attempt === 0) continue;
      return { status: "fulfilled", value: null };
    }
    const centerX = (border[0]! + border[2]! + border[4]! + border[6]!) / 4;
    const centerY = (border[1]! + border[3]! + border[5]! + border[7]!) / 4;
    const pageX = after.value.pageX;
    const pageY = after.value.pageY;
    return {
      status: "fulfilled",
      value: {
        x: Math.max(0, Math.min(after.value.width - 1, centerX)),
        y: Math.max(0, Math.min(after.value.height - 1, centerY)),
        ...(pageX !== undefined ? { pageX, documentX: centerX + pageX } : {}),
        ...(pageY !== undefined ? { pageY, documentY: centerY + pageY } : {}),
      },
    };
  }
  return { status: "fulfilled", value: null };
}

async function resolveElementCursorPoint(
  cdp: CdpSession,
  selector: string,
): Promise<ResolvedElementCursorPoint | null> {
  const mainDocumentIdentity = await readMainDocumentIdentity(cdp);
  if (!mainDocumentIdentity) return null;
  const documentResult = await settleBounded(
    cdp.send<DomDocumentResult>("DOM.getDocument", { depth: 0, pierce: true }),
    POINTER_ACTION_CAP_MS,
  );
  const rootNodeId =
    documentResult.status === "fulfilled" ? documentResult.value.root?.nodeId : undefined;
  if (!positiveInteger(rootNodeId)) return null;
  const queryResult = await settleBounded(
    cdp.send<DomQuerySelectorResult>("DOM.querySelector", {
      nodeId: rootNodeId,
      selector,
    }),
    POINTER_ACTION_CAP_MS,
  );
  const nodeId = queryResult.status === "fulfilled" ? queryResult.value.nodeId : undefined;
  if (!positiveInteger(nodeId)) return null;
  const described = await settleBounded(
    cdp.send<DomDescribeNodeResult>("DOM.describeNode", { nodeId, depth: 0, pierce: true }),
    POINTER_ACTION_CAP_MS,
  );
  if (described.status !== "fulfilled") return null;
  const backendNodeId = described.value.node?.backendNodeId;
  if (!positiveInteger(backendNodeId)) return null;
  const nodeName = String(described.value.node?.nodeName ?? "").toUpperCase();
  let world = await createCursorIsolatedWorld(cdp, mainDocumentIdentity);
  if (!world) return null;
  let executionContextId = world.executionContextId;
  let identity = {
    backendNodeId,
    executionContextId,
  };
  let state = await inspectBackendTarget(cdp, identity);
  if (state.status === "rejected") {
    world = await createCursorIsolatedWorld(cdp, mainDocumentIdentity);
    const refreshedExecutionContextId = world?.executionContextId;
    if (refreshedExecutionContextId && refreshedExecutionContextId !== executionContextId) {
      executionContextId = refreshedExecutionContextId;
      identity = { backendNodeId, executionContextId };
      state = await inspectBackendTarget(cdp, identity);
    }
  }
  if (
    state.status !== "fulfilled" ||
    !state.value.connected ||
    state.value.disabled ||
    !state.value.visible
  ) {
    return null;
  }
  const scrolled = await settleBounded(
    cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }),
    POINTER_ACTION_CAP_MS,
  );
  if (scrolled.status !== "fulfilled") return null;
  const point = await readBackendNodePoint(cdp, backendNodeId);
  if (point.status !== "fulfilled" || !point.value) return null;
  if ((await readMainDocumentIdentity(cdp)) !== mainDocumentIdentity) return null;
  return {
    mainDocumentIdentity,
    ...point.value,
    kind: "element",
    backendNodeId,
    executionContextId,
    nodeName,
  };
}

function viewportOnlyCorrectionPoint(
  target: Extract<AgentCursorTarget, { kind: "element" }>,
  point: BackendNodePoint,
): BackendNodePoint | null {
  if (
    target.pageX === undefined ||
    target.pageY === undefined ||
    target.documentX === undefined ||
    target.documentY === undefined ||
    point.pageX === undefined ||
    point.pageY === undefined ||
    point.documentX === undefined ||
    point.documentY === undefined
  ) {
    return null;
  }
  const viewportMoved = Math.abs(point.x - target.x) > 1 || Math.abs(point.y - target.y) > 1;
  const pageMoved =
    Math.abs(point.pageX - target.pageX) > 0.5 || Math.abs(point.pageY - target.pageY) > 0.5;
  const documentCenterStable =
    Math.abs(point.documentX - target.documentX) <= 1 &&
    Math.abs(point.documentY - target.documentY) <= 1;
  return viewportMoved && pageMoved && documentCenterStable ? point : null;
}

async function readViewportScrollCorrection(
  cdp: CdpSession,
  target: AgentCursorTarget,
): Promise<BackendNodePoint | null> {
  if (target.kind !== "element") return null;
  const retained = await validateRetainedElement(cdp, target);
  if (!retained.ok) return null;
  const point = await readBackendNodePoint(cdp, target.backendNodeId);
  if (point.status !== "fulfilled" || !point.value) return null;
  return viewportOnlyCorrectionPoint(target, point.value);
}

async function correctCursorForViewportScroll(
  cdp: CdpSession,
  target: Extract<AgentCursorTarget, { kind: "element" }>,
  point: BackendNodePoint,
  action: AgentCursorAction,
  authorize?: NativeInputAuthorization,
): Promise<NativeInputOutcome> {
  if (!nativeInputAuthorized(authorize)) {
    return { status: "failed", reason: PRESENTATION_AUTHORIZATION_REVOKED };
  }
  if ((await readMainDocumentIdentity(cdp)) !== target.mainDocumentIdentity) {
    return { status: "failed", reason: "target-document-changed" };
  }
  const visualIdentity = cursorVisualIdentity(cdp, target.mainDocumentIdentity);
  const operationToken = `scroll-correction-${randomUUID()}`;
  const deadlineEpochMs = Date.now() + CURSOR_EVAL_CAP_MS;
  const movePromise = evalJsInCursorIsolatedWorld<CursorEvalResult>(
    cdp,
    cursorGlideExpr({ x: point.x, y: point.y, kind: "element" }, 0, action, target, {
      identity: visualIdentity,
      operationToken,
      deadlineEpochMs,
    }),
    target.mainDocumentIdentity,
  );
  const cleanup = async (): Promise<void> => {
    await settleBounded(
      evalJsInCursorIsolatedWorld(
        cdp,
        cursorMoveCleanupExpr(visualIdentity, operationToken),
        target.mainDocumentIdentity,
      ),
    );
  };
  const evaluated = await settleBounded(movePromise, CURSOR_EVAL_CAP_MS);
  if (evaluated.status !== "fulfilled" || !isCursorPoint(evaluated.value)) {
    await cleanup();
    if (evaluated.status === "timed-out") void movePromise.then(cleanup, cleanup);
    return { status: "failed", reason: "cursor-overlay-unavailable" };
  }
  if ((await readMainDocumentIdentity(cdp)) !== target.mainDocumentIdentity) {
    await cleanup();
    return { status: "failed", reason: "target-document-changed" };
  }
  const corrected = await dispatchBoundedPointerMove(
    cdp,
    point,
    target.mainDocumentIdentity,
    authorize,
    () => verifyCursorPathVisible(cdp, visualIdentity, operationToken),
  );
  if (corrected.status !== "completed") await cleanup();
  return corrected;
}

async function glideCursor(
  cdp: CdpSession,
  target: ResolvedCursorPoint,
  action: AgentCursorAction,
  authorize?: NativeInputAuthorization,
): Promise<AgentCursorTarget | null> {
  const viewport = await readViewportSize(cdp);
  if (viewport.status !== "fulfilled" || !viewport.value) return null;
  const mainDocumentIdentity = await readMainDocumentIdentity(cdp);
  if (!mainDocumentIdentity || target.mainDocumentIdentity !== mainDocumentIdentity) return null;
  const remembered = nativePointerPositionBySession.get(cdp);
  const start =
    mainDocumentIdentity && remembered?.mainDocumentIdentity === mainDocumentIdentity
      ? {
          x: Math.max(0, Math.min(viewport.value.width - 1, remembered.x)),
          y: Math.max(0, Math.min(viewport.value.height - 1, remembered.y)),
        }
      : {
          x: Math.max(0, viewport.value.width / 2 - 0.5),
          y: Math.max(0, viewport.value.height / 2 - 0.5),
        };
  const visualIdentity = cursorVisualIdentity(cdp, mainDocumentIdentity);
  const operationToken = `move-${randomUUID()}`;
  const deadlineEpochMs = Date.now() + CURSOR_EVAL_CAP_MS;
  const movePromise = evalJsInCursorIsolatedWorld<CursorEvalResult>(
    cdp,
    cursorGlideExpr(target, GLIDE_MS, action, start, {
      identity: visualIdentity,
      operationToken,
      deadlineEpochMs,
    }),
    mainDocumentIdentity,
  );
  const cleanup = async (): Promise<void> => {
    await settleBounded(
      evalJsInCursorIsolatedWorld(
        cdp,
        cursorMoveCleanupExpr(visualIdentity, operationToken),
        mainDocumentIdentity,
      ),
    );
  };
  const evaluated = await settleBounded(movePromise, CURSOR_EVAL_CAP_MS);
  if (evaluated.status !== "fulfilled" || !isCursorPoint(evaluated.value)) {
    await cleanup();
    if (evaluated.status === "timed-out") {
      void movePromise.then(cleanup, cleanup);
    }
    return null;
  }
  if ((await readMainDocumentIdentity(cdp)) !== mainDocumentIdentity) {
    await cleanup();
    return null;
  }
  const motion = await dispatchPointerPath(
    cdp,
    start,
    target,
    evaluated.value.reducedMotion === true,
    mainDocumentIdentity,
    authorize,
    () => verifyCursorPathVisible(cdp, visualIdentity, operationToken),
  );
  const result: AgentCursorTarget = {
    ...target,
    nativeMoved: motion.status === "completed",
    ...(motion.status === "completed" ? { nativeMoveCompletedBeforeFailure: true } : {}),
    ...(motion.status === "ambiguous"
      ? {
          nativeMoveAmbiguous: true,
          nativeMoveReason: motion.reason,
          ...(motion.partial === "pointer-move" ? { nativeMoveCompletedBeforeFailure: true } : {}),
        }
      : {}),
    ...(motion.status === "failed" && motion.reason === PRESENTATION_AUTHORIZATION_REVOKED
      ? { nativeAuthorizationRevoked: true }
      : {}),
  };
  if (motion.status === "completed" && result.kind === "element") {
    const correctionPoint = await readViewportScrollCorrection(cdp, result);
    if (correctionPoint) {
      const correction = await correctCursorForViewportScroll(
        cdp,
        result,
        correctionPoint,
        action,
        authorize,
      );
      if (correction.status === "completed") {
        result.x = correctionPoint.x;
        result.y = correctionPoint.y;
        if (correctionPoint.pageX !== undefined) result.pageX = correctionPoint.pageX;
        if (correctionPoint.pageY !== undefined) result.pageY = correctionPoint.pageY;
        if (correctionPoint.documentX !== undefined) result.documentX = correctionPoint.documentX;
        if (correctionPoint.documentY !== undefined) result.documentY = correctionPoint.documentY;
        // Re-run the complete retained-state, geometry, and occlusion proof at
        // the corrected point. There is intentionally no second correction;
        // downstream action validation reports any continued movement.
        const correctedValidation = await validateCursorTarget(cdp, result);
        if (!correctedValidation.ok) {
          result.nativeMoved = false;
          result.nativeMoveAmbiguous = true;
          result.nativeMoveReason = correctedValidation.reason;
          result.nativeMoveCompletedBeforeFailure = true;
        }
      } else {
        // The initial trusted move already completed. Any correction failure is
        // therefore retry-ambiguous even when the correction itself was safely
        // rejected before dispatch (for example after lease revocation).
        result.nativeMoved = false;
        result.nativeMoveAmbiguous = true;
        result.nativeMoveReason = correction.reason;
        result.nativeMoveCompletedBeforeFailure = true;
      }
    }
  }
  return result;
}

export async function glideCursorToSelector(
  cdp: CdpSession,
  selector: string,
  action: AgentCursorAction = "hover",
  authorize?: NativeInputAuthorization,
): Promise<AgentCursorTarget | null> {
  const target = await resolveElementCursorPoint(cdp, selector);
  return target ? await glideCursor(cdp, target, action, authorize) : null;
}

export async function glideCursorToViewportCenter(
  cdp: CdpSession,
  action: AgentCursorAction,
  authorize?: NativeInputAuthorization,
): Promise<AgentCursorTarget | null> {
  const viewport = await readViewportSize(cdp);
  if (viewport.status !== "fulfilled" || !viewport.value) return null;
  const mainDocumentIdentity = await readMainDocumentIdentity(cdp);
  if (!mainDocumentIdentity) return null;
  return await glideCursor(
    cdp,
    {
      mainDocumentIdentity,
      x: Math.max(0, viewport.value.width / 2 - 0.5),
      y: Math.max(0, viewport.value.height / 2 - 0.5),
      kind: "viewport",
    },
    action,
    authorize,
  );
}

export async function glideCursorToActiveTarget(
  cdp: CdpSession,
  action: AgentCursorAction,
  authorize?: NativeInputAuthorization,
): Promise<AgentCursorTarget | null> {
  const active = await resolveElementCursorPoint(cdp, ":focus");
  if (active && active.nodeName !== "BODY" && active.nodeName !== "HTML") {
    return await glideCursor(cdp, active, action, authorize);
  }
  return await glideCursorToViewportCenter(cdp, action, authorize);
}

export async function completeCursorAction(
  cdp: CdpSession,
  target: AgentCursorTarget | null,
  action: AgentCursorAction,
  details: CursorFeedbackDetails = {},
  authorize?: NativeInputAuthorization,
): Promise<void> {
  if (!target || !nativeInputAuthorized(authorize)) return;
  const mainDocumentIdentity = await readMainDocumentIdentity(cdp);
  if (!mainDocumentIdentity || mainDocumentIdentity !== target.mainDocumentIdentity) return;
  if (!nativeInputAuthorized(authorize)) return;
  const identity = cursorVisualIdentity(cdp, mainDocumentIdentity);
  await settleBounded(
    evalJsInCursorIsolatedWorld(
      cdp,
      cursorFeedbackExpr(target, action, details, {
        identity,
        operationToken: `feedback-${randomUUID()}`,
        deadlineEpochMs: Date.now() + CURSOR_EVAL_CAP_MS,
      }),
      mainDocumentIdentity,
    ),
  );
}

interface ValidatedCursorPoint {
  ok: true;
  x: number;
  y: number;
}

interface ValidatedRetainedElement {
  ok: true;
}

interface DomNodeForLocationResult {
  backendNodeId?: number;
}

type TargetHitRelation = "target" | "descendant" | "interactive-descendant" | "label" | "none";

function rejectedHitRelation(relation: TargetHitRelation): { ok: false; reason: string } | null {
  if (relation === "interactive-descendant") {
    return { ok: false, reason: "target-interactive-descendant" };
  }
  if (relation !== "target" && relation !== "descendant" && relation !== "label") {
    return { ok: false, reason: "target-occluded" };
  }
  return null;
}

async function validateRetainedElement(
  cdp: CdpSession,
  target: AgentCursorTarget,
): Promise<ValidatedRetainedElement | { ok: false; reason: string }> {
  if ((await readMainDocumentIdentity(cdp)) !== target.mainDocumentIdentity) {
    return { ok: false, reason: "target-document-changed" };
  }
  if (target.kind !== "element") return { ok: false, reason: "target-not-element" };
  const state = await inspectBackendTarget(cdp, target);
  if (state.status === "timed-out") {
    return { ok: false, reason: "target-validation-timeout" };
  }
  if (state.status === "rejected") {
    return { ok: false, reason: "target-validation-rejected" };
  }
  if (!state.value.connected) return { ok: false, reason: "target-removed" };
  if (state.value.disabled) return { ok: false, reason: "target-disabled" };
  if (!state.value.visible) return { ok: false, reason: "target-not-visible" };
  return { ok: true };
}

async function validateCursorTarget(
  cdp: CdpSession,
  target: AgentCursorTarget,
): Promise<ValidatedCursorPoint | { ok: false; reason: string }> {
  if (target.kind === "viewport") {
    if ((await readMainDocumentIdentity(cdp)) !== target.mainDocumentIdentity) {
      return { ok: false, reason: "target-document-changed" };
    }
    return { ok: true, x: target.x, y: target.y };
  }
  const retained = await validateRetainedElement(cdp, target);
  if (!retained.ok) return retained;

  const point = await readBackendNodePoint(cdp, target.backendNodeId);
  if (point.status === "timed-out") {
    return { ok: false, reason: "target-validation-timeout" };
  }
  if (point.status === "rejected") return { ok: false, reason: "target-removed" };
  if (!point.value) return { ok: false, reason: "target-not-visible" };
  if (Math.abs(point.value.x - target.x) > 1 || Math.abs(point.value.y - target.y) > 1) {
    return { ok: false, reason: "target-moved" };
  }

  const hit = await settleBounded(
    cdp.send<DomNodeForLocationResult>("DOM.getNodeForLocation", {
      x: Math.floor(point.value.x),
      y: Math.floor(point.value.y),
      includeUserAgentShadowDOM: false,
      ignorePointerEventsNone: false,
    }),
    POINTER_ACTION_CAP_MS,
  );
  if (hit.status === "timed-out") {
    return { ok: false, reason: "target-validation-timeout" };
  }
  if (hit.status === "rejected" || !positiveInteger(hit.value.backendNodeId)) {
    // Electron 43's webview guest rejects DOM.getNodeForLocation with
    // `No node found at given location` even for an exact visible target. Use
    // only the isolated world's native hit-test intrinsic as a compatibility
    // fallback. The call is still rooted at the retained backend node; page
    // JavaScript cannot replace the target or forge the returned relation.
    const relation = await callIsolatedNode<TargetHitRelation>(
      cdp,
      target.backendNodeId,
      target.executionContextId,
      TARGET_POINT_HIT_RELATION_FUNCTION,
      [],
      [Math.floor(point.value.x), Math.floor(point.value.y)],
    );
    if (relation.status === "timed-out") {
      return { ok: false, reason: "target-validation-timeout" };
    }
    if (relation.status !== "fulfilled") {
      return { ok: false, reason: "target-validation-rejected" };
    }
    const rejected = rejectedHitRelation(relation.value);
    if (rejected) return rejected;
  } else if (hit.value.backendNodeId !== target.backendNodeId) {
    const relation = await callIsolatedNode<TargetHitRelation>(
      cdp,
      target.backendNodeId,
      target.executionContextId,
      TARGET_HIT_RELATION_FUNCTION,
      [hit.value.backendNodeId],
    );
    if (relation.status === "timed-out") {
      return { ok: false, reason: "target-validation-timeout" };
    }
    if (relation.status !== "fulfilled") return { ok: false, reason: "target-occluded" };
    const rejected = rejectedHitRelation(relation.value);
    if (rejected) return rejected;
  }
  return { ok: true, x: point.value.x, y: point.value.y };
}

function nativeInputOutcomeFromBounded(
  result: BoundedInputResult,
  rejectedReason: string,
  timeoutReason: string,
): NativeInputOutcome {
  if (result.status === "fulfilled") return { status: "completed" };
  if (result.status === "unauthorized") {
    return { status: "failed", reason: PRESENTATION_AUTHORIZATION_REVOKED };
  }
  return {
    status: "ambiguous",
    reason: result.status === "timed-out" ? timeoutReason : rejectedReason,
  };
}

function nativeInputAuthorized(authorize?: NativeInputAuthorization): boolean {
  if (!authorize) return true;
  try {
    return authorize() === true;
  } catch {
    return false;
  }
}

async function dispatchInputBounded(
  cdp: CdpSession,
  method: "Input.dispatchMouseEvent" | "Input.dispatchKeyEvent" | "Input.insertText" | "DOM.focus",
  params: Record<string, unknown>,
  authorize?: NativeInputAuthorization,
  capMs = POINTER_ACTION_CAP_MS,
): Promise<BoundedInputResult> {
  // No await or queued microtask may separate this synchronous lease check
  // from the CDP send it authorizes.
  if (!nativeInputAuthorized(authorize)) return { status: "unauthorized" };
  try {
    return await settleBounded(cdp.send(method, params), capMs);
  } catch {
    return { status: "rejected" };
  }
}

/** Mouse-up and key-up are idempotent. Retry one time when transport state is
 * unknown so an interrupted action cannot leave Chromium's input state
 * latched, while keeping cleanup strictly bounded. */
async function retryIdempotentInputRelease(
  cdp: CdpSession,
  method: "Input.dispatchMouseEvent" | "Input.dispatchKeyEvent",
  params: Record<string, unknown>,
  firstResult?: BoundedInputResult,
  authorize?: NativeInputAuthorization,
): Promise<BoundedInputResult> {
  const first = firstResult ?? (await dispatchInputBounded(cdp, method, params, authorize));
  if (first.status === "fulfilled") return first;
  return await dispatchInputBounded(cdp, method, params, authorize);
}

/** Dispatch a trusted Chromium click only after same-node hit testing at the
 * exact endpoint. No synthetic fallback is used: a fallback could bypass an
 * overlay or double-activate a page after an ambiguous native command. */
export async function dispatchPointerClick(
  cdp: CdpSession,
  target: AgentCursorTarget,
  clickCount = 1,
  authorize?: NativeInputAuthorization,
): Promise<NativeInputOutcome> {
  if (target.nativeMoveAmbiguous) return targetPointerMoveAmbiguity(target);
  if (target.nativeAuthorizationRevoked) {
    return { status: "failed", reason: PRESENTATION_AUTHORIZATION_REVOKED };
  }
  if (!target.nativeMoved) return { status: "failed", reason: "pointer-path-rejected" };
  let nativePressStarted = false;
  let completedClickCount = 0;
  let buttonMayBeDown = false;
  let cleanupPayload: Record<string, unknown> | null = null;
  let mainDocumentNavigationObserved = false;
  const stopWatchingNavigation =
    typeof cdp.on === "function"
      ? cdp.on("Page.frameNavigated", (params) => {
          const frame = (params as { frame?: { parentId?: unknown } } | null)?.frame;
          if (frame && frame.parentId == null) mainDocumentNavigationObserved = true;
        })
      : () => undefined;
  const navigationNotObserved = (): boolean => !mainDocumentNavigationObserved;
  const inputAuthorizedForCurrentDocument = (): boolean =>
    navigationNotObserved() && nativeInputAuthorized(authorize) && navigationNotObserved();
  const targetDocumentStillCurrent = async (): Promise<boolean> => {
    if (!navigationNotObserved()) return false;
    const identity = await readMainDocumentIdentity(cdp);
    return navigationNotObserved() && identity === target.mainDocumentIdentity;
  };
  const releaseIfTargetDocumentStillCurrent = async (
    payload: Record<string, unknown>,
    firstResult?: BoundedInputResult,
  ): Promise<void> => {
    if (!(await targetDocumentStillCurrent())) return;
    await retryIdempotentInputRelease(
      cdp,
      "Input.dispatchMouseEvent",
      payload,
      firstResult,
      navigationNotObserved,
    );
  };
  try {
    if (!(await targetDocumentStillCurrent())) {
      return preserveCompletedPointerMove(target, {
        status: "failed",
        reason: "target-document-changed",
      });
    }
    let validated = await validateCursorTarget(cdp, target);
    if (!validated.ok) {
      return preserveCompletedPointerMove(target, {
        status: "failed",
        reason: validated.reason,
      });
    }
    if (!(await targetDocumentStillCurrent())) {
      return preserveCompletedPointerMove(target, {
        status: "failed",
        reason: "target-document-changed",
      });
    }
    const count = clickCount === 2 ? 2 : 1;
    for (let detail = 1; detail <= count; detail += 1) {
      if (detail > 1) {
        const repeatedValidation = await validateCursorTarget(cdp, target);
        if (!repeatedValidation.ok) {
          return completedSingleClickAmbiguity(`double-click-${repeatedValidation.reason}`);
        }
        if (!(await targetDocumentStillCurrent())) {
          return completedSingleClickAmbiguity("double-click-target-document-changed");
        }
        validated = repeatedValidation;
      }
      cleanupPayload = {
        type: "mouseReleased",
        x: validated.x,
        y: validated.y,
        button: "left",
        buttons: 0,
        clickCount: detail,
      };
      const pressed = await dispatchInputBounded(
        cdp,
        "Input.dispatchMouseEvent",
        {
          type: "mousePressed",
          x: validated.x,
          y: validated.y,
          button: "left",
          buttons: 1,
          clickCount: detail,
        },
        inputAuthorizedForCurrentDocument,
      );
      if (pressed.status !== "fulfilled") {
        if (pressed.status === "unauthorized") {
          const reason = mainDocumentNavigationObserved
            ? "target-document-changed"
            : PRESENTATION_AUTHORIZATION_REVOKED;
          return completedClickCount > 0
            ? completedSingleClickAmbiguity(reason)
            : preserveCompletedPointerMove(target, {
                status: "failed",
                reason,
              });
        }
        // A timeout or rejected transport does not prove Chromium rejected the
        // command. Release best-effort and never retry a possibly accepted
        // press as a second click.
        await releaseIfTargetDocumentStillCurrent(cleanupPayload);
        const pressFailure: NativeInputOutcome = {
          status: "ambiguous",
          reason:
            pressed.status === "timed-out" ? "pointer-press-timeout" : "pointer-press-rejected",
        };
        return completedClickCount > 0
          ? atLeastOneClickAmbiguity(pressFailure.reason)
          : pressFailure;
      }
      nativePressStarted = true;
      buttonMayBeDown = true;
      if (!(await targetDocumentStillCurrent())) {
        return completedClickCount > 0
          ? atLeastOneClickAmbiguity("target-document-changed")
          : { status: "ambiguous", reason: "target-document-changed" };
      }
      const released = await dispatchInputBounded(
        cdp,
        "Input.dispatchMouseEvent",
        cleanupPayload,
        inputAuthorizedForCurrentDocument,
      );
      if (released.status !== "fulfilled") {
        // A duplicate release is inert but prevents a rejected first release
        // from leaving Chromium's pointer state latched.
        await releaseIfTargetDocumentStillCurrent(cleanupPayload, released);
        const releaseFailureReason =
          released.status === "unauthorized"
            ? mainDocumentNavigationObserved
              ? "target-document-changed"
              : PRESENTATION_AUTHORIZATION_REVOKED
            : released.status === "timed-out"
              ? "pointer-release-timeout"
              : "pointer-release-rejected";
        return completedClickCount > 0
          ? atLeastOneClickAmbiguity(releaseFailureReason)
          : {
              status: "ambiguous",
              reason: releaseFailureReason,
            };
      }
      buttonMayBeDown = false;
      completedClickCount += 1;
    }
    return { status: "completed" };
  } catch {
    // Falling back after Chromium accepted a press could activate the target a
    // second time. Once native input starts, treat the sequence as authoritative
    // even if a later response is lost (for example during navigation).
    if (buttonMayBeDown && cleanupPayload) {
      await releaseIfTargetDocumentStillCurrent(cleanupPayload);
    }
    if (completedClickCount > 0) return atLeastOneClickAmbiguity("pointer-sequence-interrupted");
    return nativePressStarted
      ? { status: "ambiguous", reason: "pointer-sequence-interrupted" }
      : preserveCompletedPointerMove(target, {
          status: "failed",
          reason: "pointer-sequence-rejected",
        });
  } finally {
    stopWatchingNavigation();
  }
}

/** Dispatch a trusted Chromium wheel event at the visible cursor position. */
export async function dispatchPointerWheel(
  cdp: CdpSession,
  target: AgentCursorTarget,
  deltaX: number,
  deltaY: number,
  authorize?: NativeInputAuthorization,
): Promise<NativeInputOutcome> {
  if (target.nativeMoveAmbiguous) return targetPointerMoveAmbiguity(target);
  if (target.nativeAuthorizationRevoked) {
    return { status: "failed", reason: PRESENTATION_AUTHORIZATION_REVOKED };
  }
  if (!target.nativeMoved) return { status: "failed", reason: "pointer-path-rejected" };
  const validated = await validateCursorTarget(cdp, target);
  if (!validated.ok) {
    return target.nativeMoveCompletedBeforeFailure
      ? completedPointerMoveAmbiguity(validated.reason)
      : { status: "failed", reason: validated.reason };
  }
  const dispatched = await dispatchInputBounded(
    cdp,
    "Input.dispatchMouseEvent",
    {
      type: "mouseWheel",
      x: validated.x,
      y: validated.y,
      deltaX,
      deltaY,
    },
    authorize,
  );
  return preserveCompletedPointerMove(
    target,
    nativeInputOutcomeFromBounded(dispatched, "pointer-wheel-rejected", "pointer-wheel-timeout"),
  );
}

async function focusTargetNative(
  cdp: CdpSession,
  target: AgentCursorTarget,
  authorize?: NativeInputAuthorization,
): Promise<NativeInputOutcome> {
  if (target.kind !== "element") {
    return { status: "failed", reason: "focus-target-unavailable" };
  }
  const focused = await dispatchInputBounded(
    cdp,
    "DOM.focus",
    { backendNodeId: target.backendNodeId },
    authorize,
  );
  const focusOutcome = nativeInputOutcomeFromBounded(focused, "focus-rejected", "focus-timeout");
  if (focusOutcome.status !== "completed") {
    return preserveCompletedPointerMove(target, focusOutcome);
  }
  return preservePriorNativeInputAmbiguity(await verifyTargetActive(cdp, target));
}

async function verifyTargetActive(
  cdp: CdpSession,
  target: Extract<AgentCursorTarget, { kind: "element" }>,
): Promise<NativeInputOutcome> {
  const verified = await callIsolatedNode<boolean>(
    cdp,
    target.backendNodeId,
    target.executionContextId,
    TARGET_IS_ACTIVE_FUNCTION,
  );
  if (verified.status === "fulfilled" && verified.value === true) {
    return { status: "completed" };
  }
  if (verified.status === "timed-out") {
    return { status: "ambiguous", reason: "focus-verification-timeout" };
  }
  return { status: "failed", reason: "focus-did-not-apply" };
}

function normalizedKey(rawKey: string): {
  key: string;
  code: string;
  virtualKeyCode: number;
  text?: string;
} {
  const alias: Record<string, string> = { Esc: "Escape", Space: " " };
  const key = alias[rawKey] ?? rawKey;
  const special: Record<string, { code: string; virtualKeyCode: number; text?: string }> = {
    Escape: { code: "Escape", virtualKeyCode: 27 },
    Enter: { code: "Enter", virtualKeyCode: 13, text: "\r" },
    Tab: { code: "Tab", virtualKeyCode: 9, text: "\t" },
    Backspace: { code: "Backspace", virtualKeyCode: 8 },
    Delete: { code: "Delete", virtualKeyCode: 46 },
    ArrowLeft: { code: "ArrowLeft", virtualKeyCode: 37 },
    ArrowUp: { code: "ArrowUp", virtualKeyCode: 38 },
    ArrowRight: { code: "ArrowRight", virtualKeyCode: 39 },
    ArrowDown: { code: "ArrowDown", virtualKeyCode: 40 },
    Home: { code: "Home", virtualKeyCode: 36 },
    End: { code: "End", virtualKeyCode: 35 },
    " ": { code: "Space", virtualKeyCode: 32, text: " " },
  };
  const descriptor = special[key];
  if (descriptor) return { key, ...descriptor };
  if (key.length === 1) {
    const upper = key.toUpperCase();
    return {
      key,
      code: /[A-Z]/.test(upper) ? `Key${upper}` : `Digit${key}`,
      virtualKeyCode: upper.charCodeAt(0),
      text: key,
    };
  }
  return { key, code: key, virtualKeyCode: 0 };
}

async function dispatchKeyStroke(
  cdp: CdpSession,
  rawKey: string,
  options: NativeKeyboardInputOptions = {},
  authorize?: NativeInputAuthorization,
): Promise<NativeInputOutcome> {
  const documentGuard = await validateNativeInputDocument(cdp);
  if (documentGuard.status !== "completed") return documentGuard;
  const descriptor = normalizedKey(rawKey);
  const modifiers = (options.modifiers ?? 0) | (options.shift ? 8 : 0);
  const text = modifiers & (1 | 2 | 4) ? undefined : descriptor.text;
  const keyUpPayload = {
    type: "keyUp",
    key: descriptor.key,
    code: descriptor.code,
    windowsVirtualKeyCode: descriptor.virtualKeyCode,
    nativeVirtualKeyCode: descriptor.virtualKeyCode,
    modifiers,
  };
  const releaseIfInputDocumentStillCurrent = async (
    firstResult?: BoundedInputResult,
  ): Promise<void> => {
    const current = await validateNativeInputDocument(cdp);
    if (current.status !== "completed") return;
    await retryIdempotentInputRelease(cdp, "Input.dispatchKeyEvent", keyUpPayload, firstResult);
  };
  const down = await dispatchInputBounded(
    cdp,
    "Input.dispatchKeyEvent",
    {
      type: text ? "keyDown" : "rawKeyDown",
      key: descriptor.key,
      code: descriptor.code,
      windowsVirtualKeyCode: descriptor.virtualKeyCode,
      nativeVirtualKeyCode: descriptor.virtualKeyCode,
      modifiers,
      ...(text ? { text } : {}),
      ...(options.commands?.length ? { commands: options.commands } : {}),
    },
    authorize,
  );
  if (down.status !== "fulfilled") {
    if (down.status === "unauthorized") {
      return { status: "failed", reason: PRESENTATION_AUTHORIZATION_REVOKED };
    }
    await releaseIfInputDocumentStillCurrent();
    return {
      status: "ambiguous",
      reason: down.status === "timed-out" ? "key-down-timeout" : "key-down-rejected",
    };
  }
  const postDownDocumentGuard = await validateNativeInputDocument(cdp);
  if (postDownDocumentGuard.status !== "completed") {
    return preservePriorNativeInputAmbiguity(postDownDocumentGuard);
  }
  const up = await dispatchInputBounded(cdp, "Input.dispatchKeyEvent", keyUpPayload, authorize);
  if (up.status === "fulfilled") return { status: "completed" };
  await releaseIfInputDocumentStillCurrent(up);
  return {
    status: "ambiguous",
    reason:
      up.status === "unauthorized"
        ? PRESENTATION_AUTHORIZATION_REVOKED
        : up.status === "timed-out"
          ? "key-up-timeout"
          : "key-up-rejected",
  };
}

async function dispatchKeyboardKeyStroke(
  cdp: CdpSession,
  rawKey: string,
  options: NativeKeyboardInputOptions,
  authorize: NativeInputAuthorization | undefined,
  nativeKeyboard: NativeKeyboardInputDispatcher | undefined,
): Promise<NativeInputOutcome> {
  if (!nativeKeyboard) return await dispatchKeyStroke(cdp, rawKey, options, authorize);
  const documentGuard = await validateNativeInputDocument(cdp);
  if (documentGuard.status !== "completed") return documentGuard;
  if (!nativeInputAuthorized(authorize)) {
    return { status: "failed", reason: PRESENTATION_AUTHORIZATION_REVOKED };
  }
  return await nativeKeyboard.key(rawKey, options);
}

async function requireValidElementTarget(
  cdp: CdpSession,
  target: AgentCursorTarget,
): Promise<NativeInputOutcome> {
  if (target.nativeMoveAmbiguous) return targetPointerMoveAmbiguity(target);
  if (target.nativeAuthorizationRevoked) {
    return { status: "failed", reason: PRESENTATION_AUTHORIZATION_REVOKED };
  }
  if (!target.nativeMoved) return { status: "failed", reason: "pointer-path-rejected" };
  const validated = await validateCursorTarget(cdp, target);
  if (!validated.ok) {
    return target.nativeMoveCompletedBeforeFailure
      ? completedPointerMoveAmbiguity(validated.reason)
      : { status: "failed", reason: validated.reason };
  }
  nativeInputDocumentBySession.set(cdp, target.mainDocumentIdentity);
  return { status: "completed" };
}

async function requireValidRetainedElement(
  cdp: CdpSession,
  target: AgentCursorTarget,
): Promise<NativeInputOutcome> {
  if (target.nativeMoveAmbiguous) return targetPointerMoveAmbiguity(target);
  if (target.nativeAuthorizationRevoked) {
    return { status: "failed", reason: PRESENTATION_AUTHORIZATION_REVOKED };
  }
  if (!target.nativeMoved) return { status: "failed", reason: "pointer-path-rejected" };
  const validated = await validateRetainedElement(cdp, target);
  if (!validated.ok) return { status: "failed", reason: validated.reason };
  nativeInputDocumentBySession.set(cdp, target.mainDocumentIdentity);
  return { status: "completed" };
}

async function validateNativeInputDocument(cdp: CdpSession): Promise<NativeInputOutcome> {
  const expected = nativeInputDocumentBySession.get(cdp);
  if (!expected || (await readMainDocumentIdentity(cdp)) !== expected) {
    return { status: "failed", reason: "target-document-changed" };
  }
  return { status: "completed" };
}

export async function confirmCursorTarget(
  cdp: CdpSession,
  target: AgentCursorTarget,
): Promise<NativeInputOutcome> {
  return await requireValidElementTarget(cdp, target);
}

export async function dispatchNativeFocus(
  cdp: CdpSession,
  _selector: string,
  target: AgentCursorTarget,
  authorize?: NativeInputAuthorization,
): Promise<NativeInputOutcome> {
  const valid = await requireValidElementTarget(cdp, target);
  if (valid.status !== "completed") return valid;
  return await focusTargetNative(cdp, target, authorize);
}

export async function dispatchNativeKey(
  cdp: CdpSession,
  selector: string | undefined,
  target: AgentCursorTarget,
  key: string,
  options: { shift?: boolean } = {},
  authorize?: NativeInputAuthorization,
  nativeKeyboard?: NativeKeyboardInputDispatcher,
): Promise<NativeInputOutcome> {
  const valid = await requireValidElementTarget(cdp, target);
  if (valid.status !== "completed") return valid;
  let targetWasFocused = false;
  if (selector) {
    const focused = await focusTargetNative(cdp, target, authorize);
    if (focused.status !== "completed") return focused;
    targetWasFocused = true;
  } else if (target.kind === "element") {
    const active = await verifyTargetActive(cdp, target);
    if (active.status !== "completed") return preserveCompletedPointerMove(target, active);
  }
  const keyed = await dispatchKeyboardKeyStroke(cdp, key, options, authorize, nativeKeyboard);
  return targetWasFocused
    ? preservePriorNativeInputAmbiguity(keyed)
    : preserveCompletedPointerMove(target, keyed);
}

export async function dispatchNativeText(
  cdp: CdpSession,
  _selector: string,
  target: AgentCursorTarget,
  text: string,
  options: { replace: boolean; submit: boolean },
  authorize?: NativeInputAuthorization,
  nativeKeyboard?: NativeKeyboardInputDispatcher,
): Promise<NativeInputOutcome> {
  const valid = await requireValidElementTarget(cdp, target);
  if (valid.status !== "completed") return valid;
  if (target.kind !== "element") {
    return { status: "failed", reason: "text-target-not-editable" };
  }
  const preflight = await callIsolatedNode<EditableTargetState>(
    cdp,
    target.backendNodeId,
    target.executionContextId,
    TARGET_EDITABLE_STATE_FUNCTION,
  );
  if (preflight.status === "timed-out") {
    return { status: "ambiguous", reason: "text-target-state-timeout" };
  }
  if (preflight.status !== "fulfilled" || !preflight.value.editable) {
    return { status: "failed", reason: "text-target-not-editable" };
  }
  if (!options.replace && !Number.isInteger(preflight.value.length)) {
    return { status: "failed", reason: "text-target-state-unavailable" };
  }
  const clicked = await dispatchPointerClick(cdp, target, 1, authorize);
  if (clicked.status !== "completed") return clicked;
  const focused = await focusTargetNative(cdp, target, authorize);
  if (focused.status !== "completed") return preservePriorNativeInputAmbiguity(focused);
  const editable = await callIsolatedNode<EditableTargetState>(
    cdp,
    target.backendNodeId,
    target.executionContextId,
    TARGET_EDITABLE_STATE_FUNCTION,
  );
  if (editable.status === "timed-out") {
    return { status: "ambiguous", reason: "text-target-state-timeout" };
  }
  if (editable.status !== "fulfilled" || !editable.value.active) {
    return { status: "ambiguous", reason: "text-target-not-active" };
  }
  if (!editable.value.editable) {
    return { status: "ambiguous", reason: "text-target-not-editable" };
  }
  if (!options.replace && !Number.isInteger(editable.value.length)) {
    return { status: "ambiguous", reason: "text-target-state-unavailable" };
  }
  if (options.replace) {
    const selectAll = await dispatchKeyboardKeyStroke(
      cdp,
      "a",
      {
        modifiers: process.platform === "darwin" ? 4 : 2,
        commands: ["selectAll"],
      },
      authorize,
      nativeKeyboard,
    );
    if (selectAll.status !== "completed") {
      return preservePriorNativeInputAmbiguity(selectAll);
    }
    const selectionTargetActive = await verifyTargetActive(cdp, target);
    if (selectionTargetActive.status !== "completed") {
      return preservePriorNativeInputAmbiguity(selectionTargetActive);
    }
    const selection = await callIsolatedNode<TextReplaceSelectionState>(
      cdp,
      target.backendNodeId,
      target.executionContextId,
      TARGET_REPLACE_SELECTION_FUNCTION,
    );
    if (selection.status !== "fulfilled") {
      return {
        status: "ambiguous",
        reason:
          selection.status === "timed-out"
            ? "text-selection-verification-timeout"
            : "text-selection-verification-rejected",
      };
    }
    if (
      selection.value.kind === "value" &&
      selection.value.observable &&
      !selection.value.selected
    ) {
      return { status: "ambiguous", reason: "text-selection-did-not-apply" };
    }
    const cleared = await dispatchKeyboardKeyStroke(
      cdp,
      "Backspace",
      {},
      authorize,
      nativeKeyboard,
    );
    if (cleared.status !== "completed") return preservePriorNativeInputAmbiguity(cleared);
    const clearedState = await callIsolatedNode<EditableTargetState>(
      cdp,
      target.backendNodeId,
      target.executionContextId,
      TARGET_EDITABLE_STATE_FUNCTION,
    );
    if (clearedState.status !== "fulfilled") {
      return {
        status: "ambiguous",
        reason:
          clearedState.status === "timed-out"
            ? "text-clear-verification-timeout"
            : "text-clear-verification-rejected",
      };
    }
    if (!clearedState.value.active) {
      return { status: "ambiguous", reason: "text-target-not-active" };
    }
    if (!clearedState.value.editable || !Number.isInteger(clearedState.value.length)) {
      return { status: "ambiguous", reason: "text-target-state-unavailable" };
    }
    if (clearedState.value.length !== 0) {
      return { status: "ambiguous", reason: "text-clear-did-not-commit" };
    }
  } else {
    const movedToEnd = await dispatchKeyboardKeyStroke(
      cdp,
      "End",
      {
        commands: ["moveToEndOfDocument"],
      },
      authorize,
      nativeKeyboard,
    );
    if (movedToEnd.status !== "completed") {
      return preservePriorNativeInputAmbiguity(movedToEnd);
    }
  }
  if (text.length > 0) {
    const documentGuard = await validateNativeInputDocument(cdp);
    if (documentGuard.status !== "completed") {
      return preservePriorNativeInputAmbiguity(documentGuard);
    }
    if (nativeKeyboard) {
      if (!nativeInputAuthorized(authorize)) {
        return {
          status: "ambiguous",
          reason: PRESENTATION_AUTHORIZATION_REVOKED,
        };
      }
      const inserted = await nativeKeyboard.insertText(text);
      if (inserted.status !== "completed") {
        return preservePriorNativeInputAmbiguity(inserted);
      }
    } else {
      const inserted = await dispatchInputBounded(cdp, "Input.insertText", { text }, authorize);
      if (inserted.status !== "fulfilled") {
        if (inserted.status === "unauthorized") {
          return {
            status: "ambiguous",
            reason: PRESENTATION_AUTHORIZATION_REVOKED,
          };
        }
        return {
          status: "ambiguous",
          reason: inserted.status === "timed-out" ? "text-input-timeout" : "text-input-rejected",
        };
      }
    }
  }
  const verified = await callIsolatedNode<boolean>(
    cdp,
    target.backendNodeId,
    target.executionContextId,
    TARGET_TEXT_MATCH_FUNCTION,
    [],
    [text, options.replace, editable.value.length ?? 0],
  );
  if (verified.status !== "fulfilled" || verified.value !== true) {
    return {
      status: "ambiguous",
      reason:
        verified.status === "timed-out"
          ? "text-verification-timeout"
          : verified.status === "rejected"
            ? "text-verification-rejected"
            : "text-did-not-commit",
    };
  }
  if (!options.submit) return { status: "completed" };
  const submitted = await dispatchKeyboardKeyStroke(cdp, "Enter", {}, authorize, nativeKeyboard);
  return preservePriorNativeInputAmbiguity(submitted);
}

export async function dispatchNativeToggle(
  cdp: CdpSession,
  _selector: string,
  target: AgentCursorTarget,
  checked: boolean,
  authorize?: NativeInputAuthorization,
): Promise<NativeInputOutcome> {
  const valid = await requireValidElementTarget(cdp, target);
  if (valid.status !== "completed") return valid;
  if (target.kind !== "element") {
    return { status: "failed", reason: "toggle-target-unavailable" };
  }
  const state = await callIsolatedNode<ToggleTargetState>(
    cdp,
    target.backendNodeId,
    target.executionContextId,
    TARGET_TOGGLE_STATE_FUNCTION,
  );
  if (state.status !== "fulfilled" || state.value.ok !== true) {
    return state.status === "timed-out"
      ? { status: "ambiguous", reason: "toggle-state-timeout" }
      : { status: "failed", reason: "toggle-target-unavailable" };
  }
  if (state.value.checked === checked) return { status: "completed" };
  if (state.value.type === "radio" && !checked) {
    return { status: "failed", reason: "radio-cannot-be-unchecked" };
  }
  const clicked = await dispatchPointerClick(cdp, target, 1, authorize);
  if (clicked.status !== "completed") return clicked;
  const verified = await callIsolatedNode<ToggleTargetState>(
    cdp,
    target.backendNodeId,
    target.executionContextId,
    TARGET_TOGGLE_STATE_FUNCTION,
  );
  if (
    verified.status === "fulfilled" &&
    verified.value.ok === true &&
    verified.value.checked === checked
  ) {
    return { status: "completed" };
  }
  return {
    status: "ambiguous",
    reason:
      verified.status === "timed-out"
        ? "toggle-verification-timeout"
        : verified.status === "rejected"
          ? "toggle-verification-rejected"
          : "toggle-did-not-commit",
  };
}

export async function dispatchNativeSelect(
  cdp: CdpSession,
  _selector: string,
  target: AgentCursorTarget,
  value: string,
  dispatchNativeMenuKey: NativeSelectMenuKeyDispatcher,
  authorize?: NativeInputAuthorization,
  strategy: NativeSelectInputStrategy = "native-menu",
  nativeKeyboard?: NativeKeyboardInputDispatcher,
): Promise<NativeInputOutcome> {
  const valid = await requireValidElementTarget(cdp, target);
  if (valid.status !== "completed") return valid;
  if (target.kind !== "element") {
    return { status: "failed", reason: "select-option-unavailable" };
  }
  const focused = await focusTargetNative(cdp, target, authorize);
  if (focused.status !== "completed") return focused;
  // Focus handlers are allowed to mutate or reorder the option list. Resolve
  // the requested option only after focus so key navigation never uses a stale
  // index or enabled-option ordinal.
  const metadata = await callIsolatedNode<SelectTargetState>(
    cdp,
    target.backendNodeId,
    target.executionContextId,
    TARGET_SELECT_METADATA_FUNCTION,
    [],
    [value],
  );
  if (
    metadata.status !== "fulfilled" ||
    metadata.value.ok !== true ||
    !Number.isInteger(metadata.value.currentIndex) ||
    !Number.isInteger(metadata.value.targetIndex) ||
    !Number.isInteger(metadata.value.enabledSteps) ||
    metadata.value.enabledSteps! < 0
  ) {
    return preservePriorNativeInputAmbiguity(
      metadata.status === "timed-out"
        ? { status: "ambiguous", reason: "select-state-timeout" }
        : { status: "failed", reason: "select-option-unavailable" },
    );
  }
  const targetIndex = metadata.value.targetIndex!;
  // Older isolated-world responses cannot omit these fields in production,
  // but conservative request-value fallbacks keep mixed-version transports
  // fail-closed at postcondition verification instead of dispatching blindly.
  const targetValue = metadata.value.targetValue ?? value;
  const targetText = metadata.value.targetText ?? value;
  if (metadata.value.currentIndex === targetIndex) {
    const unchanged = await callIsolatedNode<boolean>(
      cdp,
      target.backendNodeId,
      target.executionContextId,
      TARGET_SELECT_MATCH_FUNCTION,
      [],
      [targetIndex, targetValue, targetText],
    );
    if (unchanged.status === "fulfilled" && unchanged.value === true) {
      return { status: "completed" };
    }
    return preservePriorNativeInputAmbiguity(
      unchanged.status === "timed-out"
        ? { status: "ambiguous", reason: "select-verification-timeout" }
        : { status: "failed", reason: "select-did-not-stay-selected" },
    );
  }
  if (strategy === "typeahead") {
    if (targetText.length === 0) {
      return { status: "ambiguous", reason: "select-typeahead-unavailable" };
    }
    // macOS Chromium exposes a focused closed <select> to trusted keyboard
    // typeahead exactly like a user typing an option name. This avoids the
    // OS-owned popup boundary while still producing native trusted key,
    // input, and change events. Stop at the first exact match so a unique
    // prefix emits the fewest possible keystrokes. ASCII option labels use
    // unshifted lowercase keys, matching the physical typeahead gesture and
    // keeping the CDP key meaning consistent with its active modifiers.
    for (const character of Array.from(targetText)) {
      if (!nativeInputAuthorized(authorize)) {
        return { status: "ambiguous", reason: PRESENTATION_AUTHORIZATION_REVOKED };
      }
      const stillValid = await requireValidRetainedElement(cdp, target);
      if (stillValid.status !== "completed") {
        return preservePriorNativeInputAmbiguity(stillValid);
      }
      const stillActive = await verifyTargetActive(cdp, target);
      if (stillActive.status !== "completed") {
        return preservePriorNativeInputAmbiguity(stillActive);
      }
      const typeaheadKey = /^[A-Z]$/u.test(character) ? character.toLowerCase() : character;
      const typed = await dispatchKeyboardKeyStroke(
        cdp,
        typeaheadKey,
        {},
        authorize,
        nativeKeyboard,
      );
      if (typed.status !== "completed") return preservePriorNativeInputAmbiguity(typed);
      const matched = await callIsolatedNode<boolean>(
        cdp,
        target.backendNodeId,
        target.executionContextId,
        TARGET_SELECT_MATCH_FUNCTION,
        [],
        [targetIndex, targetValue, targetText],
      );
      if (matched.status === "fulfilled" && matched.value === true) {
        return { status: "completed" };
      }
      if (matched.status === "timed-out") {
        return { status: "ambiguous", reason: "select-verification-timeout" };
      }
      if (matched.status === "rejected") {
        return { status: "ambiguous", reason: "select-verification-rejected" };
      }
    }
    return { status: "ambiguous", reason: "select-did-not-commit" };
  }
  // Native-menu platforms need the OS-owned picker open before ordinal key
  // navigation. Open it the same way a person does—with a trusted pointer
  // click on the exact retained select—confirm that select is :open, and only
  // then navigate its enabled-option ordinal by keyboard.
  const opened = await dispatchPointerClick(cdp, target, 1, authorize);
  if (opened.status !== "completed") return preservePriorNativeInputAmbiguity(opened);
  const popupOpen = await callIsolatedNode<boolean>(
    cdp,
    target.backendNodeId,
    target.executionContextId,
    TARGET_SELECT_POPUP_OPEN_FUNCTION,
  );
  if (popupOpen.status !== "fulfilled" || popupOpen.value !== true) {
    return preservePriorNativeInputAmbiguity(
      popupOpen.status === "timed-out"
        ? { status: "ambiguous", reason: "select-popup-verification-timeout" }
        : popupOpen.status === "rejected"
          ? { status: "failed", reason: "select-popup-verification-rejected" }
          : { status: "failed", reason: "select-popup-did-not-open" },
    );
  }
  const dispatchSelectMenuKey = async (key: NativeSelectMenuKey): Promise<NativeInputOutcome> => {
    if (!nativeInputAuthorized(authorize)) {
      return { status: "failed", reason: PRESENTATION_AUTHORIZATION_REVOKED };
    }
    // Revalidate the retained node and loader immediately before every OS-menu
    // key. The dispatcher performs the final synchronous presentation + exact
    // WebContents check at the actual sendInputEvent side effect.
    // Once the OS-owned picker is open, its keyboard destination is the exact
    // retained select rather than a screen coordinate. Revalidate that node,
    // document, and visibility without rejecting legitimate focus/layout
    // movement caused by the native picker itself. The pointer opener above
    // still used full geometry and hit-test validation.
    const stillValid = await requireValidRetainedElement(cdp, target);
    if (stillValid.status !== "completed") return stillValid;
    const stillOpen = await callIsolatedNode<boolean>(
      cdp,
      target.backendNodeId,
      target.executionContextId,
      TARGET_SELECT_POPUP_OPEN_FUNCTION,
    );
    if (stillOpen.status !== "fulfilled" || stillOpen.value !== true) {
      return stillOpen.status === "timed-out"
        ? { status: "ambiguous", reason: "select-popup-verification-timeout" }
        : { status: "failed", reason: "select-popup-closed-before-key" };
    }
    if (!nativeInputAuthorized(authorize)) {
      return { status: "failed", reason: PRESENTATION_AUTHORIZATION_REVOKED };
    }
    return await dispatchNativeMenuKey(key);
  };
  const closePopupAfterFailure = async (
    outcome: NativeInputOutcome,
  ): Promise<NativeInputOutcome> => {
    // Cleanup Escape is safe only while the original retained select is still
    // the active, open picker in the trusted document. A blind Escape after
    // removal, navigation, or focus transfer could reach unrelated content.
    const retained = await requireValidRetainedElement(cdp, target);
    if (retained.status === "completed") {
      const active = await verifyTargetActive(cdp, target);
      if (active.status === "completed") {
        const open = await callIsolatedNode<boolean>(
          cdp,
          target.backendNodeId,
          target.executionContextId,
          TARGET_SELECT_POPUP_OPEN_FUNCTION,
        );
        if (open.status === "fulfilled" && open.value === true) {
          await dispatchNativeMenuKey("Escape", { cleanup: true }).catch(() => undefined);
        }
      }
    }
    return preservePriorNativeInputAmbiguity(outcome);
  };

  const home = await dispatchSelectMenuKey("Home");
  if (home.status !== "completed") return await closePopupAfterFailure(home);
  for (let index = 0; index < metadata.value.enabledSteps!; index += 1) {
    const down = await dispatchSelectMenuKey("ArrowDown");
    if (down.status !== "completed") return await closePopupAfterFailure(down);
  }
  const committed = await dispatchSelectMenuKey("Enter");
  if (committed.status !== "completed") return await closePopupAfterFailure(committed);
  const verified = await callIsolatedNode<boolean>(
    cdp,
    target.backendNodeId,
    target.executionContextId,
    TARGET_SELECT_MATCH_FUNCTION,
    [],
    [targetIndex, targetValue, targetText],
  );
  if (verified.status === "fulfilled" && verified.value === true) return { status: "completed" };
  return {
    status: "ambiguous",
    reason:
      verified.status === "timed-out"
        ? "select-verification-timeout"
        : verified.status === "rejected"
          ? "select-verification-rejected"
          : "select-did-not-commit",
  };
}

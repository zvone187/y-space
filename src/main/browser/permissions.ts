import { shell, systemPreferences, type WebContents, type Session } from "electron";

const ALLOWED_PERMISSIONS = new Set<string>([
  "clipboard-read",
  "clipboard-sanitized-write",
  "fullscreen",
]);

const BLOCKED_NAVIGATION_PROTOCOLS = new Set<string>([
  "file:",
  "chrome:",
  "chrome-extension:",
  "chrome-devtools:",
  "devtools:",
  "javascript:",
  "view-source:",
]);

/** Local PDF preview in the in-app browser uses Chromium's built-in viewer. */
export function isLocalPdfFileUrl(url: URL): boolean {
  if (url.protocol !== "file:") return false;
  try {
    const path = decodeURIComponent(url.pathname).toLowerCase();
    return path.endsWith(".pdf");
  } catch {
    return false;
  }
}

export function isNavigationUrlAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    // Allow only PDF file:// navigations so attachment preview can open in the
    // in-app browser tab (Chrome PDF viewer). Other file:// stays blocked.
    if (parsed.protocol === "file:") return isLocalPdfFileUrl(parsed);
    return !BLOCKED_NAVIGATION_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

function isSensitiveNavigationUrlAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return true;
    if (parsed.protocol !== "http:") return false;
    // Connect terminal redirects are served by a main-owned loopback receiver.
    // Never let remote OAuth content downgrade to arbitrary cleartext origins.
    return (
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

function isPermissionAllowed(webContents: WebContents | null, permission: string): boolean {
  if (permission === "media") {
    return webContents?.getType() === "window";
  }
  return ALLOWED_PERMISSIONS.has(permission);
}

// Granting Chromium's "media" permission is not enough on macOS: microphone
// capture is also gated by the OS-level TCC grant, which is a separate layer.
// Without it getUserMedia resolves but yields a silent (all-zero) audio track
// and no system prompt appears. Drive the OS prompt from the main process so
// recording works regardless of how the Electron/Chromium getUserMedia path
// happens to handle TCC. macOS-only; other platforms have no such gate.
async function ensureMacMicrophoneAccess(): Promise<boolean> {
  if (process.platform !== "darwin") {
    return true;
  }
  const status = systemPreferences.getMediaAccessStatus("microphone");
  if (status === "granted") {
    return true;
  }
  // "denied"/"restricted" won't re-open the system alert — the user must change
  // it in System Settings (or it's blocked by MDM/policy) — so report the
  // denial rather than silently hanging.
  if (status === "denied" || status === "restricted") {
    console.error(
      `[poracode][mic] OS microphone access is "${status}"; not prompting (change in System Settings › Privacy & Security › Microphone)`,
    );
    return false;
  }
  try {
    const granted = await systemPreferences.askForMediaAccess("microphone");
    console.error(`[poracode][mic] OS prompt result: ${granted ? "granted" : "denied"}`);
    return granted;
  } catch (error) {
    console.error("[poracode][mic] askForMediaAccess(microphone) failed", error);
    return false;
  }
}

// Deep-link to the OS microphone privacy pane so a user who previously denied
// access can re-enable it. macOS won't re-prompt once denied, and the
// Microphone pane has no "add app" affordance, so deep-linking is the only
// recovery path. No universal scheme exists on Linux.
const MICROPHONE_SETTINGS_URL: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  win32: "ms-settings:privacy-microphone",
};

export async function openMicrophoneSettings(): Promise<void> {
  const url = MICROPHONE_SETTINGS_URL[process.platform];
  if (!url) {
    return;
  }
  await shell.openExternal(url);
}

export function installSessionPermissions(session: Session): void {
  session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (!isPermissionAllowed(webContents, permission)) {
      callback(false);
      return;
    }
    if (permission === "media") {
      void ensureMacMicrophoneAccess().then(callback);
      return;
    }
    callback(true);
  });
  session.setPermissionCheckHandler((webContents, permission) =>
    isPermissionAllowed(webContents, permission),
  );
}

/** OAuth/Connect content runs in an exact ephemeral session and receives no
 * ambient Electron permission grants. User-driven native paste remains
 * available; remote content cannot read the clipboard or enter fullscreen. */
export function installSensitiveSessionPermissions(session: Session): void {
  session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
}

export function installNavigationGuards(
  webContents: WebContents,
  onPopup: (url: string) => void,
  profile: "ordinary" | "sensitive" = "ordinary",
): () => void {
  const isAllowed = (url: string) =>
    profile === "sensitive" ? isSensitiveNavigationUrlAllowed(url) : isNavigationUrlAllowed(url);
  webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowed(url)) {
      onPopup(url);
    }
    return { action: "deny" };
  });

  const onWillNavigate = (event: Electron.Event, url: string): void => {
    if (!isAllowed(url)) {
      event.preventDefault();
    }
  };
  const onWillFrameNavigate = (event: Electron.Event & { url: string }): void => {
    if (!isAllowed(event.url)) {
      event.preventDefault();
    }
  };
  const onWillRedirect = (event: Electron.Event, url: string): void => {
    if (!isAllowed(url)) event.preventDefault();
  };
  webContents.on("will-navigate", onWillNavigate);
  webContents.on("will-frame-navigate", onWillFrameNavigate);
  webContents.on("will-redirect", onWillRedirect);

  return () => {
    // setWindowOpenHandler is not an EventEmitter listener. Replacing it is
    // required so a closing guest cannot invoke the retained callback after
    // its sensitive ownership has begun teardown.
    webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    webContents.removeListener("will-navigate", onWillNavigate);
    webContents.removeListener("will-frame-navigate", onWillFrameNavigate);
    webContents.removeListener("will-redirect", onWillRedirect);
  };
}

import { nativeTheme } from "electron";
import { release } from "node:os";
import type { ThemeMode } from "@/shared/contracts";

/**
 * Native "liquid glass" window materials.
 *
 * The opt-in translucent sidebar relies on an OS-composited blur behind the
 * window (macOS `NSVisualEffectView` vibrancy / Windows 11 DWM acrylic). On
 * macOS main windows are created with a vibrancy backing so Electron initializes
 * a clear WebContents background without `transparent: true`; the native
 * material can then be toggled live. This module centralizes the OS capability
 * check and native-theme sync.
 *
 * macOS 26 "Liquid Glass" (`NSGlassEffectView`) is not exposed by Electron, so
 * the closest officially-supported material is `vibrancy: "sidebar"`, which the
 * OS already re-skins toward the Tahoe look.
 */

/**
 * Windows 11 22H2 (build 22621) is the first build with a stable DWM acrylic
 * system backdrop; earlier Windows builds and Windows 10 have no usable native
 * blur, so they fall back to the in-app CSS imitation.
 */
function isWindows11AcrylicCapable(platform: NodeJS.Platform, osRelease: string): boolean {
  if (platform !== "win32") return false;
  const build = Number(osRelease.split(".")[2] ?? "0");
  return Number.isFinite(build) && build >= 22621;
}

export interface NativeWindowMaterialInput {
  platform: NodeJS.Platform;
  release: string;
  requested: boolean;
  reducedTransparency: boolean;
}

export interface NativeWindowMaterialDecision {
  supported: boolean;
  active: boolean;
  macVibrancy: "sidebar" | null;
  windowsMaterial: "acrylic" | "none";
}

/**
 * Pure native-material policy shared by startup and live IPC updates. Keeping
 * this decision free of Electron state makes unsupported/reduced-transparency
 * behavior explicit and exhaustively testable.
 */
export function decideNativeWindowMaterial(
  input: NativeWindowMaterialInput,
): NativeWindowMaterialDecision {
  const macOS = input.platform === "darwin";
  const windowsAcrylic = isWindows11AcrylicCapable(input.platform, input.release);
  const supported = macOS || windowsAcrylic;
  const active = supported && input.requested && !input.reducedTransparency;
  return {
    supported,
    active,
    macVibrancy: macOS && active ? "sidebar" : null,
    windowsMaterial: windowsAcrylic && active ? "acrylic" : "none",
  };
}

/** Resolve the policy against the current Electron host and OS preference. */
export function decideCurrentNativeWindowMaterial(
  requested: boolean,
): NativeWindowMaterialDecision {
  return decideNativeWindowMaterial({
    platform: process.platform,
    release: release(),
    requested,
    reducedTransparency: nativeTheme.prefersReducedTransparency === true,
  });
}

/**
 * Mirrors the app appearance onto the native theme so an active vibrancy/acrylic
 * material renders in the matching light/dark variant. Without this it follows
 * the OS appearance (e.g. a light app over a dark OS shows a dark frosted sidebar).
 */
export function syncNativeThemeForMaterial(themeMode: ThemeMode): void {
  nativeTheme.themeSource = themeMode;
}

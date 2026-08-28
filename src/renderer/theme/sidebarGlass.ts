import { isMac, isWindows } from "@/renderer/bridge";

/**
 * User-tunable frosting for the translucent ("liquid glass") sidebar.
 *
 * The sidebar paints `var(--sidebar-glass-tint)` over the OS blur material; the
 * tint is `content-background` at a partial alpha. A higher alpha is more
 * frosted (the sidebar holds its theme color), a lower one shows more of the
 * blurred backdrop. The Appearance slider overrides that alpha per light/dark.
 *
 * Tunable on the native-material platforms (Windows 11 acrylic, macOS vibrancy),
 * where the tint var is consumed and the slider is shown. Windows leans heavier
 * because DWM acrylic blurs the desktop behind the window and can wash the
 * sidebar out. Text-bearing native material keeps a contrast-safe theme scrim
 * even at its clearest setting; blur and saturation carry the glass effect.
 * An unset (null) override leaves the per-platform styles.css default authoritative.
 */

type Appearance = "light" | "dark";

const CSS_VAR = "--sidebar-glass-tint";

/**
 * Default mix percentage per appearance, by platform. Mirrors the
 * `--sidebar-glass-tint` rules in styles.css — keep the two in sync:
 *   - Windows: the `html[data-platform="win32"][data-native-material="on"]`
 *     overrides (98% light / 88% dark).
 *   - macOS: the base `@layer` tokens, since no win32 override applies there —
 *     the `:root` light default (98%) and the `.dark` block default (82%).
 * Used to seed the slider when there is no override.
 */
const WINDOWS_GLASS_TINT_DEFAULT: Record<Appearance, number> = {
  light: 98,
  dark: 88,
};
const MACOS_GLASS_TINT_DEFAULT: Record<Appearance, number> = {
  light: 98,
  dark: 82,
};

const GLASS_TINT_MINIMUM: Record<Appearance, number> = {
  light: 98,
  dark: 80,
};

export function sidebarGlassTintMinimum(appearance: Appearance): number {
  return GLASS_TINT_MINIMUM[appearance];
}

/** The styles.css default frosting for the current platform and appearance. */
export function sidebarGlassTintDefault(appearance: Appearance): number {
  const defaults = isMac() ? MACOS_GLASS_TINT_DEFAULT : WINDOWS_GLASS_TINT_DEFAULT;
  return defaults[appearance];
}

/** The `color-mix()` expression for a frosting percentage (0–100). */
export function sidebarGlassTintExpr(pct: number): string {
  return `color-mix(in oklab, var(--content-background) ${pct}%, transparent)`;
}

/**
 * Apply (or clear) the user's sidebar frosting override as an inline custom
 * property on the document root. Inline wins over the styles.css defaults;
 * clearing falls back to them. Only the native-material platforms (Windows
 * acrylic / macOS vibrancy) consume the tint, so it's a no-op elsewhere.
 */
export function applySidebarGlassTint(
  root: HTMLElement,
  override: number | null,
  enabled: boolean,
  appearance: Appearance,
): void {
  if (enabled && (isWindows() || isMac()) && override != null) {
    const safeTint = Math.max(sidebarGlassTintMinimum(appearance), Math.min(100, override));
    root.style.setProperty(CSS_VAR, sidebarGlassTintExpr(safeTint));
  } else {
    root.style.removeProperty(CSS_VAR);
  }
}

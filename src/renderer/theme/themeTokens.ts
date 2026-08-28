/**
 * Theme token derivation.
 *
 * A theme preset is authored as a handful of anchor colors (`ThemeSpec`); the
 * full set of app CSS custom properties is derived from them here via
 * `color-mix` so palettes stay internally consistent and cheap to author. The
 * derived values intentionally mirror the relationships baked into the base
 * theme in `styles.css` (secondary/tertiary surfaces step toward the
 * foreground, the scrollbar is a translucent muted, etc.).
 *
 * Authoring anchors in plain hex (the canonical color each editor theme ships)
 * keeps the catalog faithful to the upstream themes; only layout-neutral color
 * tokens are themed, so radius, spacing, fonts, and semantic status colors
 * (success/warning/danger) stay on the base values.
 */

import {
  deriveMutedColor,
  deriveReadableTextColor,
  ensureReadableForeground,
  mixHex,
} from "./colorMath";

export type ThemeVariantVars = Record<string, string>;

export interface ThemeSpec {
  /** Editor/content background (the largest surface). */
  bg: string;
  /** Panel/card surface (sidebars, popovers, composer). Slightly off `bg`. */
  surface: string;
  /** Primary text color. */
  fg: string;
  /** Accent / primary action color. */
  accent: string;
  /** Optional accent-hued text color with 4.5:1 contrast on app surfaces. */
  accentText?: string;
  /** Text rendered on top of `accent`. */
  accentFg: string;
  /** Hairline border / separator base color. */
  border: string;
  /** Optional explicit sidebar background. Defaults to `surface`. */
  sidebar?: string;
  /** Optional explicit content-area background. Defaults to `bg`. */
  content?: string;
}

/**
 * Secondary ("muted") text is derived by blending `fg` toward `bg` rather than
 * taken from each editor theme's comment color. Editor comment colors are tuned
 * to recede behind code and fail as readable UI text (e.g. One's `#5c6370` is
 * ~2.3:1 on its background). The blend is pushed only as far as needed to clear
 * a WCAG contrast floor, so muted stays recessive while matching the base
 * Y Space theme's readability (~4.5–6:1) for every palette, and still
 * inherits each theme's tint because `fg` / `bg` are themed.
 *
 * The strict floor applies to the content background (where settings
 * descriptions and primary body copy sit); panels (surface) and the sidebar
 * get a relaxed floor so muted lands dimmer there — keeping a clear visual gap
 * from the active foreground without over-brightening it.
 */
const MUTED_BG_FLOOR = 4.5;
const MUTED_PANEL_FLOOR = 4.5;
const MUTED_MIN_FRACTION = 0.3;
const MUTED_MAX_FRACTION = 0.85;
const CONTROL_BOUNDARY_FLOOR = 3.0;

/**
 * Every CSS custom property this module sets on the document root. Switching to
 * the base theme clears exactly these so the `.light` / `.dark` rules in
 * `styles.css` take over again.
 */
export const MANAGED_THEME_VARS = [
  "--background",
  "--foreground",
  "--surface",
  "--surface-secondary",
  "--surface-tertiary",
  "--overlay",
  "--muted",
  "--scrollbar",
  "--default",
  "--accent",
  "--accent-text",
  "--accent-foreground",
  "--field-background",
  "--field-foreground",
  "--field-placeholder",
  "--field-border",
  "--control-border",
  "--segment",
  "--border",
  "--separator",
  "--sidebar-background",
  "--content-background",
  "--composer-surface",
] as const;

const mix = (a: string, aPct: number, b: string): string =>
  `color-mix(in oklab, ${a} ${aPct}%, ${b} ${100 - aPct}%)`;

/** Blend `color` with transparency (a translucent tint of itself). */
const fade = (color: string, pct: number): string =>
  `color-mix(in oklab, ${color} ${pct}%, transparent)`;

export function buildVariant(spec: ThemeSpec, mode: "light" | "dark"): ThemeVariantVars {
  const { bg, surface, fg, accent, accentFg, border } = spec;
  const sidebar = spec.sidebar ?? surface;
  const content = spec.content ?? bg;

  // Derive readable secondary text from fg→bg with a contrast floor. Fields,
  // placeholders, and interactive boundaries get their own independent floors;
  // pale separators remain free to stay visually quiet.
  const fieldBackground = mixHex(surface, fg, 0.95);
  const muted = deriveMutedColor(
    fg,
    [
      { color: bg, floor: MUTED_BG_FLOOR },
      { color: surface, floor: MUTED_PANEL_FLOOR },
      { color: sidebar, floor: MUTED_PANEL_FLOOR },
      { color: content, floor: MUTED_BG_FLOOR },
    ],
    { minFraction: MUTED_MIN_FRACTION, maxFraction: MUTED_MAX_FRACTION },
  );
  const placeholder = deriveMutedColor(
    fg,
    [
      { color: fieldBackground, floor: 4.5 },
      { color: bg, floor: 4.5 },
      { color: surface, floor: 4.5 },
      { color: content, floor: 4.5 },
    ],
    { minFraction: MUTED_MIN_FRACTION, maxFraction: 0.92 },
  ).hex;
  const controlBorder = deriveMutedColor(
    fg,
    [
      { color: fieldBackground, floor: CONTROL_BOUNDARY_FLOOR },
      { color: bg, floor: CONTROL_BOUNDARY_FLOOR },
      { color: surface, floor: CONTROL_BOUNDARY_FLOOR },
      { color: content, floor: CONTROL_BOUNDARY_FLOOR },
    ],
    { minFraction: 0.1, maxFraction: 0.85 },
  ).hex;
  const accentText =
    spec.accentText ??
    deriveReadableTextColor(accent, fg, [
      { color: bg, floor: 4.5 },
      { color: surface, floor: 4.5 },
      { color: sidebar, floor: 4.5 },
      { color: content, floor: 4.5 },
    ]);

  return {
    "--background": bg,
    "--foreground": fg,
    "--surface": surface,
    "--surface-secondary": mix(surface, 92, fg),
    "--surface-tertiary": mix(surface, 85, fg),
    // Floating chrome (modals, menus, popovers). In dark themes it drops to
    // just above the surface so fields (mixed toward fg, below) read as raised
    // cards on it; in light themes it dims below the surface, where the
    // barely-lighter field fill already reads as a card.
    "--overlay": mode === "light" ? mix(surface, 93, fg) : mix(surface, 98, fg),
    "--muted": muted.hex,
    "--scrollbar": fade(muted.hex, 60),
    // Neutral fill for secondary/tertiary buttons, selects, chips, toggle and
    // checkbox/radio controls. Stepped toward fg so the controls separate from
    // the panel — more in light (where surfaces cluster near white and would
    // otherwise swallow the fill, ~1.35:1 vs page) than in dark, where
    // over-stepping would lighten the fill into the (light) accent label.
    "--default": mix(surface, mode === "light" ? 82 : 86, fg),
    "--accent": accent,
    "--accent-text": accentText,
    "--accent-foreground": ensureReadableForeground(accentFg, accent),
    // Fields sit a step lighter than the surface/overlay (below) so they read
    // as raised cards on panels and floating chrome in both modes.
    "--field-background": fieldBackground,
    "--field-foreground": fg,
    "--field-placeholder": placeholder,
    "--field-border": controlBorder,
    "--control-border": controlBorder,
    "--segment": surface,
    "--border": border,
    "--separator": fade(border, 75),
    "--sidebar-background": sidebar,
    "--content-background": content,
    "--composer-surface": mix(surface, 90, fg),
  };
}

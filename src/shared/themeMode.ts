import type { ThemeMode } from "./contracts";

/**
 * Version 1 marks theme selections saved after Y Space changed its factory
 * appearance from dark to light. It lets upgraded profiles adopt the new
 * default once without overriding a later explicit dark choice on every boot.
 */
export const THEME_DEFAULT_VERSION = 1;

export function migrateLegacyThemeDefault(
  mode: ThemeMode,
  themePreset: string,
  persistedVersion: unknown,
): ThemeMode {
  const hasCurrentDefaultVersion =
    typeof persistedVersion === "number" &&
    Number.isInteger(persistedVersion) &&
    persistedVersion >= THEME_DEFAULT_VERSION;
  if (hasCurrentDefaultVersion) return mode;

  // Before this marker existed, dark + the base preset was the factory
  // default. Custom presets and system mode necessarily reflect user intent.
  return mode === "dark" && themePreset === "default" ? "light" : mode;
}

export function resolveThemeMode(mode: ThemeMode, systemPrefersDark: boolean): "light" | "dark" {
  if (mode === "system") {
    return systemPrefersDark ? "dark" : "light";
  }
  return mode;
}

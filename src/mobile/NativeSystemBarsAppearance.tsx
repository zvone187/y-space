import { useEffect } from "react";
import { SystemBars, SystemBarsStyle } from "@capacitor/core";
import { useResolvedAppearance } from "@/renderer/components/ui/provider";
import { isNativeApp } from "./pwaInstall";

/**
 * Keeps the native status/navigation-bar content readable when the in-app
 * appearance changes. Capacitor names the styles after the surrounding
 * surface: LIGHT renders dark icons; DARK renders light icons.
 */
export function NativeSystemBarsAppearance() {
  const appearance = useResolvedAppearance();

  useEffect(() => {
    if (!isNativeApp()) return;

    void SystemBars.setStyle({
      style: appearance === "dark" ? SystemBarsStyle.Dark : SystemBarsStyle.Light,
    }).catch((error: unknown) => {
      // A missing/older native bridge must not prevent the mobile UI from
      // rendering. The static LIGHT config remains the safe launch default.
      console.warn("[system-bars] Failed to sync appearance", error);
    });
  }, [appearance]);

  return null;
}

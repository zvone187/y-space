import { readBridge } from "@/renderer/bridge";

/** Bring the extracted browser window back into the right panel. Fire-and-forget. */
export function injectBrowserToMain(): void {
  readBridge()
    .browserInjectToMain()
    .catch(() => {});
}

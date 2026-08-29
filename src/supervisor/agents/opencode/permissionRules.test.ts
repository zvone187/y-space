import { describe, expect, it } from "vitest";
import { buildOpenCodePermissionRules } from "./permissionRules";

describe("buildOpenCodePermissionRules", () => {
  it("keeps the original full-access rule when Y Space Browser is unavailable", () => {
    expect(buildOpenCodePermissionRules("yolo", false)).toEqual([
      { permission: "*", pattern: "*", action: "allow" },
    ]);
  });

  it("blocks browser alternatives without hiding unrelated skills", () => {
    const rules = buildOpenCodePermissionRules("yolo", true);

    expect(rules).toEqual(
      expect.arrayContaining([
        { permission: "webfetch", pattern: "*", action: "deny" },
        { permission: "websearch", pattern: "*", action: "deny" },
        { permission: "skill", pattern: "gstack", action: "deny" },
        { permission: "skill", pattern: "control-in-app-browser", action: "deny" },
        { permission: "skill", pattern: "playwright", action: "deny" },
        { permission: "bash", pattern: "*playwright*", action: "deny" },
        { permission: "bash", pattern: "*open -a*Safari*", action: "deny" },
        { permission: "bash", pattern: "open *https://*", action: "deny" },
        { permission: "bash", pattern: "xdg-open *https://*", action: "deny" },
        { permission: "bash", pattern: "gio open *https://*", action: "deny" },
        { permission: "bash", pattern: "Start-Process *https://*", action: "deny" },
        { permission: "bash", pattern: "start *https://*", action: "deny" },
        { permission: "bash", pattern: "explorer.exe *https://*", action: "deny" },
        { permission: "bash", pattern: "google-chrome*", action: "deny" },
        { permission: "bash", pattern: "*\\msedge.exe*", action: "deny" },
        { permission: "bash", pattern: "bash -lc 'open *https://*", action: "deny" },
        { permission: "bash", pattern: "sh -lc 'open *https://*", action: "deny" },
        { permission: "bash", pattern: "zsh -lc 'firefox*", action: "deny" },
        { permission: "bash", pattern: "bash -c 'open *https://*", action: "deny" },
        { permission: "bash", pattern: "env DISPLAY=* firefox*", action: "deny" },
        { permission: "bash", pattern: "FOO=* firefox*", action: "deny" },
        { permission: "bash", pattern: "command firefox*", action: "deny" },
        { permission: "bash", pattern: "nohup chromium*", action: "deny" },
      ]),
    );
    expect(rules).not.toContainEqual({ permission: "skill", pattern: "*", action: "deny" });
    expect(rules).not.toContainEqual({ permission: "skill", pattern: "qa", action: "deny" });
  });
});

import { describe, expect, it } from "vitest";
import type { RuntimeChatItem } from "@/renderer/state/slices/runtimeEventSlice";
import { claimsBrowserVerification, resolveBrowserVerificationBadge } from "./browserVerification";

describe("browser final-response verification", () => {
  it("counts only app-owned successful Browser evidence in the final response's turn", () => {
    const items = byId([
      item("user-1", "user_message"),
      evidence("browser-1", "snapshot"),
      evidence("browser-2", "click"),
      item("answer-1", "assistant_message"),
    ]);
    expect(
      resolveBrowserVerificationBadge(
        items,
        ["user-1", "browser-1", "browser-2", "answer-1"],
        ["answer-1"],
        "I verified the web page.",
      ),
    ).toEqual({ kind: "verified", actionCount: 2 });
  });

  it("does not accept provider-authored Browser-looking rows as proof", () => {
    const items = byId([
      item("user-1", "user_message"),
      {
        ...item("provider-row", "mcp_tool_call"),
        payload: { name: "snapshot", serverId: "browser", status: "success" },
      },
      item("answer-1", "assistant_message"),
    ]);
    expect(
      resolveBrowserVerificationBadge(
        items,
        ["user-1", "provider-row", "answer-1"],
        ["answer-1"],
        "I checked the website in the browser.",
      ),
    ).toEqual({ kind: "unverified" });
  });

  it("does not carry proof across a later user turn", () => {
    const items = byId([
      item("user-1", "user_message"),
      evidence("browser-1", "snapshot"),
      item("answer-1", "assistant_message"),
      item("user-2", "user_message"),
      item("answer-2", "assistant_message"),
    ]);
    expect(
      resolveBrowserVerificationBadge(
        items,
        ["user-1", "browser-1", "answer-1", "user-2", "answer-2"],
        ["answer-2"],
        "I verified the browser page.",
      ),
    ).toEqual({ kind: "unverified" });
  });

  it("accepts authenticated proof reported after the settled final but before the next user turn", () => {
    const items = byId([
      item("user-1", "user_message"),
      item("answer-1", "assistant_message"),
      evidence("browser-late", "snapshot"),
    ]);
    expect(
      resolveBrowserVerificationBadge(
        items,
        ["user-1", "answer-1", "browser-late"],
        ["answer-1"],
        "I verified the website.",
      ),
    ).toEqual({ kind: "verified", actionCount: 1 });
  });

  it("does not label non-browser global file or PDF tab claims", () => {
    expect(claimsBrowserVerification("I opened the PDF in a new tab.")).toBe(false);
    expect(claimsBrowserVerification("I checked the spreadsheet page and saved it.")).toBe(false);
    expect(claimsBrowserVerification("I opened the browser tab and checked the web page.")).toBe(
      true,
    );
  });

  it("does not treat Browser setup or tab metadata as proof of a website test", () => {
    const items = byId([
      item("user-1", "user_message"),
      evidence("browser-enable", "enable"),
      evidence("browser-list", "list_tabs"),
      evidence("browser-disable", "disable"),
      item("answer-1", "assistant_message"),
    ]);
    expect(
      resolveBrowserVerificationBadge(
        items,
        ["user-1", "browser-enable", "browser-list", "browser-disable", "answer-1"],
        ["answer-1"],
        "I tested the website in the browser.",
      ),
    ).toEqual({ kind: "unverified" });
  });

  it("requires inspection for test claims but accepts navigation for open claims", () => {
    const items = byId([
      item("user-1", "user_message"),
      evidence("browser-nav", "navigate"),
      item("answer-1", "assistant_message"),
    ]);
    const ids = ["user-1", "browser-nav", "answer-1"];
    expect(
      resolveBrowserVerificationBadge(
        items,
        ids,
        ["answer-1"],
        "I tested the website in the browser.",
      ),
    ).toEqual({ kind: "unverified" });
    expect(
      resolveBrowserVerificationBadge(
        items,
        ids,
        ["answer-1"],
        "I opened the website in the browser.",
      ),
    ).toEqual({ kind: "verified", actionCount: 1 });
  });

  it.each([
    "Browser testing passed.",
    "Verification succeeded.",
    "I was testing the website.",
    "The browser verification was successful.",
  ])("marks unsupported noun, gerund, and passive claims as unverified: %s", (claim) => {
    const items = byId([item("user-1", "user_message"), item("answer-1", "assistant_message")]);

    expect(
      resolveBrowserVerificationBadge(items, ["user-1", "answer-1"], ["answer-1"], claim),
    ).toEqual({ kind: "unverified" });
  });

  it("requires inspection rather than navigation for gerund test claims", () => {
    const items = byId([
      item("user-1", "user_message"),
      evidence("browser-nav", "navigate"),
      item("answer-1", "assistant_message"),
    ]);

    expect(
      resolveBrowserVerificationBadge(
        items,
        ["user-1", "browser-nav", "answer-1"],
        ["answer-1"],
        "I was testing the website in the embedded browser.",
      ),
    ).toEqual({ kind: "unverified" });
  });

  it("treats a bare HTTP(S) URL or Browser tab ID as a verification claim", () => {
    expect(
      claimsBrowserVerification("Result: https://example.test/alpha?secret=redacted#done"),
    ).toBe(true);
    expect(claimsBrowserVerification("Active tab: tab-12345678-abcd-4abc-8abc-1234567890ab")).toBe(
      true,
    );
  });

  it("matches a claimed full URL against privacy-bounded origin-only evidence", () => {
    const items = byId([
      item("user-1", "user_message"),
      evidence("browser-1", "snapshot", {
        tabId: "tab-12345678-abcd-4abc-8abc-1234567890ab",
        url: "http://127.0.0.1:41739",
      }),
      item("answer-1", "assistant_message"),
    ]);

    expect(
      resolveBrowserVerificationBadge(
        items,
        ["user-1", "browser-1", "answer-1"],
        ["answer-1"],
        "http://127.0.0.1:41739/alpha?fixture=1#saved",
      ),
    ).toEqual({ kind: "verified", actionCount: 1 });
  });

  it("never verifies a claimed URL from evidence for another origin", () => {
    const items = byId([
      item("user-1", "user_message"),
      evidence("browser-1", "snapshot", {
        tabId: "tab-12345678-abcd-4abc-8abc-1234567890ab",
        url: "https://actual.example.test",
      }),
      item("answer-1", "assistant_message"),
    ]);

    expect(
      resolveBrowserVerificationBadge(
        items,
        ["user-1", "browser-1", "answer-1"],
        ["answer-1"],
        "Browser testing passed at https://claimed.example.test/private/path.",
      ),
    ).toEqual({ kind: "unverified" });
  });

  it("never verifies a claimed tab ID from evidence for another tab", () => {
    const items = byId([
      item("user-1", "user_message"),
      evidence("browser-1", "snapshot", {
        tabId: "tab-actual",
        url: "https://example.test",
      }),
      item("answer-1", "assistant_message"),
    ]);

    expect(
      resolveBrowserVerificationBadge(
        items,
        ["user-1", "browser-1", "answer-1"],
        ["answer-1"],
        "Active tab: tab-claimed",
      ),
    ).toEqual({ kind: "unverified" });
  });

  it("does not stitch a claimed tab and origin together from unrelated evidence", () => {
    const items = byId([
      item("user-1", "user_message"),
      evidence("browser-tab-only", "snapshot", {
        tabId: "tab-claimed",
        url: "https://other.example.test",
      }),
      evidence("browser-origin-only", "snapshot", {
        tabId: "tab-other",
        url: "https://claimed.example.test",
      }),
      item("answer-1", "assistant_message"),
    ]);

    expect(
      resolveBrowserVerificationBadge(
        items,
        ["user-1", "browser-tab-only", "browser-origin-only", "answer-1"],
        ["answer-1"],
        "Active tab tab-claimed is at https://claimed.example.test/private/path.",
      ),
    ).toEqual({ kind: "unverified" });
  });

  it("requires every claimed Browser origin to have matching turn evidence", () => {
    const items = byId([
      item("user-1", "user_message"),
      evidence("browser-1", "snapshot", {
        tabId: "tab-one",
        url: "https://one.example.test",
      }),
      item("answer-1", "assistant_message"),
    ]);

    expect(
      resolveBrowserVerificationBadge(
        items,
        ["user-1", "browser-1", "answer-1"],
        ["answer-1"],
        "Checked https://one.example.test/a and https://two.example.test/b.",
      ),
    ).toEqual({ kind: "unverified" });
  });

  it("requires an interaction action when a URL-only claim says it was clicked", () => {
    const items = byId([
      item("user-1", "user_message"),
      evidence("browser-nav", "navigate", {
        tabId: "tab-one",
        url: "https://one.example.test",
      }),
      item("answer-1", "assistant_message"),
    ]);

    expect(
      resolveBrowserVerificationBadge(
        items,
        ["user-1", "browser-nav", "answer-1"],
        ["answer-1"],
        "Clicked https://one.example.test/save.",
      ),
    ).toEqual({ kind: "unverified" });
  });

  it("verifies a tab-and-URL claim only when one action carries the matching pair", () => {
    const items = byId([
      item("user-1", "user_message"),
      evidence("browser-1", "snapshot", {
        tabId: "tab-claimed",
        url: "https://claimed.example.test",
      }),
      item("answer-1", "assistant_message"),
    ]);

    expect(
      resolveBrowserVerificationBadge(
        items,
        ["user-1", "browser-1", "answer-1"],
        ["answer-1"],
        "Active tab tab-claimed is at https://claimed.example.test/private/path.",
      ),
    ).toEqual({ kind: "verified", actionCount: 1 });
  });

  it("does not mistake a tab-shaped URL path segment for a Browser tab ID", () => {
    const items = byId([
      item("user-1", "user_message"),
      evidence("browser-1", "snapshot", {
        tabId: "tab-real",
        url: "https://claimed.example.test",
      }),
      item("answer-1", "assistant_message"),
    ]);

    expect(
      resolveBrowserVerificationBadge(
        items,
        ["user-1", "browser-1", "answer-1"],
        ["answer-1"],
        "https://claimed.example.test/tabs/tab-route-name",
      ),
    ).toEqual({ kind: "verified", actionCount: 1 });
  });
});

function item(id: string, type: RuntimeChatItem["type"]): RuntimeChatItem {
  return { id, type, state: "completed", streams: {} };
}

function evidence(
  id: string,
  name: string,
  metadata: { tabId?: string; url?: string } = {},
): RuntimeChatItem {
  return {
    ...item(id, "mcp_tool_call"),
    payload: {
      name,
      serverId: "browser",
      status: "success",
      browserEvidence: { source: "y-space-browser-mcp", occurredAt: 1, ...metadata },
    },
  };
}

function byId(items: RuntimeChatItem[]): Record<string, RuntimeChatItem> {
  return Object.fromEntries(items.map((entry) => [entry.id, entry]));
}

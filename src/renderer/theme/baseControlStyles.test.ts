import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "./colorMath";

const styles = readFileSync(join(process.cwd(), "src/renderer/styles.css"), "utf8");

function ruleFor(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = styles.match(new RegExp(`${escapedSelector}\\s*\\{([^}]+)\\}`));
  if (!match?.[1]) throw new Error(`Missing base style for ${selector}`);
  return match[1];
}

function exactRuleFor(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [
    ...styles.matchAll(new RegExp(`(?:^|\\n)${escapedSelector}\\s*\\{([^}]+)\\}`, "g")),
  ];
  const match = matches.at(-1);
  if (!match?.[1]) throw new Error(`Missing base style for ${selector}`);
  return match[1];
}

describe("base control styles", () => {
  it("keeps neutral button variants on the theme foreground", () => {
    for (const selector of [".button--secondary", ".button--tertiary"]) {
      expect(ruleFor(selector)).toContain("--button-fg: var(--foreground)");
    }
  });

  it("keeps light and dark field text and control boundaries independently readable", () => {
    const checks: [string, string, number][] = [
      ["#747473", "#ffffff", 4.5],
      ["#747473", "#fbfbfa", 4.5],
      ["#828284", "#18181b", 4.5],
      ["#929291", "#ffffff", 3],
      ["#929291", "#fbfbfa", 3],
      ["#656567", "#18181b", 3],
    ];
    for (const [foreground, background, floor] of checks) {
      expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(floor);
    }
    expect(ruleFor(".radio__control,\n.checkbox__control")).toContain(
      "border: 1px solid var(--control-border)",
    );
    expect(styles).toContain("--field-border: var(--control-border)");
    expect(styles).toContain("--field-border-width: 1px");
  });

  it("does not force white text onto neutral buttons", () => {
    const files = [
      "src/renderer/views/WhatsNewOverlay.tsx",
      "src/renderer/components/mcp/McpServerEditor.tsx",
      "src/renderer/views/PrReviewOverlay/parts/PrConversationTab.tsx",
      "src/renderer/components/thread/ThreadGoalControls.tsx",
      "src/renderer/components/thread/ThreadRuntimeRequestPanel/parts/QuestionRows.tsx",
      "src/renderer/components/thread/ThreadRuntimeRequestPanel/ThreadRuntimeRequestPanel.tsx",
      "src/renderer/views/GitReviewOverlay/parts/GitReviewSidebar/GitReviewSidebar.tsx",
    ];
    for (const file of files) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source).not.toMatch(/variant="(?:secondary|tertiary)"[\s\S]{0,160}!?text-white/);
    }
  });

  it("uses the orange identity for primary actions", () => {
    expect(ruleFor(".button--primary")).toContain("--button-bg: var(--accent)");
    expect(ruleFor(".button--primary")).toContain("--button-fg: var(--accent-foreground)");
    expect(styles).not.toMatch(
      /\.light \.button--primary|\[data-theme="light"\] \.button--primary/,
    );
  });

  it("uses airy light glass and restrained dark glass for macOS floating chrome", () => {
    expect(styles).toMatch(
      /html\[data-platform="darwin"\]\s*\{[^}]*--floating-chrome-surface:\s*color-mix\(in oklab, var\(--sidebar-background\) 76%, transparent\);[^}]*--floating-chrome-backdrop:\s*blur\(16px\) saturate\(145%\);/s,
    );
    expect(styles).toMatch(
      /html\[data-platform="darwin"\]\.dark,[^{]*html\[data-platform="darwin"\]\[data-theme="dark"\]\s*\{[^}]*--floating-chrome-surface:\s*color-mix\(in oklab, var\(--sidebar-background\) 24%, transparent\);[^}]*--floating-chrome-backdrop:\s*blur\(10px\) saturate\(135%\);/s,
    );
    expect(styles).toMatch(
      /html:is\(\[data-platform="darwin"\], \[data-platform="win32"\]\) \.poracode-floating-chrome\s*\{[^}]*border-color:\s*color-mix\(in oklab, var\(--foreground\) 8%, transparent\);[^}]*background-image:\s*none;[^}]*backdrop-filter:\s*var\(--floating-chrome-backdrop\);[^}]*box-shadow:\s*0 4px 18px rgb\(24 20 16 \/ 0\.08\);/s,
    );
    expect(styles).toMatch(
      /--floating-chrome-active-surface:\s*color-mix\(\s*in oklab,\s*var\(--floating-chrome-surface\) 84%,\s*var\(--sidebar-background\) 16%\s*\);/s,
    );
    expect(styles).toMatch(
      /\.poracode-floating-chrome--active\s*\{\s*background-color:\s*var\(--floating-chrome-active-surface\);/s,
    );
  });

  it("uses slightly denser liquid glass for Windows floating chrome", () => {
    expect(styles).toMatch(
      /html\[data-platform="win32"\]\s*\{[^}]*--floating-chrome-surface:\s*color-mix\(in oklab, var\(--sidebar-background\) 82%, transparent\);[^}]*--floating-chrome-backdrop:\s*blur\(16px\) saturate\(140%\);/s,
    );
    expect(styles).toMatch(
      /html\[data-platform="win32"\]\.dark,[^{]*html\[data-platform="win32"\]\[data-theme="dark"\]\s*\{[^}]*--floating-chrome-surface:\s*color-mix\(in oklab, var\(--sidebar-background\) 30%, transparent\);[^}]*--floating-chrome-backdrop:\s*blur\(10px\) saturate\(130%\);/s,
    );
  });

  it("uses a calm elevated composer with one orange send action", () => {
    expect(exactRuleFor(".poracode-composer-shell")).toContain("border-radius: 18px");
    expect(exactRuleFor(".poracode-composer-shell")).toContain(
      "backdrop-filter: var(--glass-backdrop)",
    );
    expect(exactRuleFor(".poracode-composer-shell")).toContain("0 8px 28px");
    expect(exactRuleFor(".poracode-composer-shell:focus-within")).toContain("var(--accent)");
    expect(exactRuleFor(".poracode-composer-shell:focus-within")).toContain(
      "border-color: var(--accent)",
    );
    expect(exactRuleFor(".poracode-composer-send")).toContain("background: var(--accent)");
    expect(exactRuleFor(".poracode-composer-send")).toContain("color: var(--accent-foreground)");
    expect(styles).not.toContain("poracode-composer-border-glow");
    expect(styles).not.toContain("poracode-composer-border-spin");
  });

  it("limits translucent chrome to stable shell surfaces with an opaque accessibility fallback", () => {
    expect(styles).toMatch(
      /\.poracode-workspace-tab-strip,\s*\.popover,\s*\.dropdown__popover,\s*\.poracode-composer-shell\s*\{[^}]*background:\s*var\(--glass-surface\);[^}]*backdrop-filter:\s*var\(--glass-backdrop\);/s,
    );
    expect(ruleFor(".poracode-workspace-tab-strip")).toContain("border-color: var(--glass-border)");
    expect(styles).toMatch(
      /@media \(prefers-reduced-transparency: reduce\)[\s\S]*?\.poracode-workspace-tab-strip,[\s\S]*?\.poracode-composer-shell\s*\{[^}]*background:\s*var\(--overlay\);[^}]*backdrop-filter:\s*none;/,
    );
  });
});

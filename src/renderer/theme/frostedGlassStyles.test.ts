import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, type AtRule, type Declaration, type Rule } from "postcss";
import { describe, expect, it } from "vitest";

const styles = readFileSync(join(process.cwd(), "src/renderer/styles.css"), "utf8");
const root = parse(styles);

function rulesFor(selector: string): Rule[] {
  const matches: Rule[] = [];
  root.walkRules((rule) => {
    if (rule.selectors.includes(selector)) matches.push(rule);
  });
  return matches;
}

function declaration(rule: Rule, property: string): Declaration | undefined {
  return rule.nodes.find(
    (node): node is Declaration => node.type === "decl" && node.prop === property,
  );
}

function valueFor(selector: string, property: string): string {
  for (const rule of rulesFor(selector)
    .filter(
      (candidate) =>
        candidate.parent?.type !== "atrule" ||
        !(candidate.parent as AtRule).params.includes("reduced-transparency"),
    )
    .toReversed()) {
    const match = declaration(rule, property);
    if (match) return match.value;
  }
  throw new Error(`Missing ${property} on ${selector}`);
}

describe("frosted glass material", () => {
  it("puts a vivid local color field behind the docked native sidebar", () => {
    const ambient = valueFor(":root", "--glass-ambient");
    expect(ambient.match(/radial-gradient/g) ?? []).toHaveLength(3);
    expect(ambient).toContain("var(--accent)");

    expect(valueFor('html[data-native-material="on"] .poracode-shell', "background-image")).toBe(
      "var(--glass-ambient)",
    );
    expect(valueFor('html[data-native-material="on"] .poracode-shell', "background-size")).toBe(
      "100% 100%",
    );
    expect(valueFor('html[data-native-material="on"] .poracode-shell main', "background")).toBe(
      "var(--content-background)",
    );
    expect(
      valueFor(
        'html[data-native-material="on"] .poracode-sidebar-aside:not(.poracode-sidebar-aside--overlay)',
        "backdrop-filter",
      ),
    ).toBe("var(--glass-backdrop)");
    expect(
      valueFor(
        'html[data-native-material="on"] .poracode-sidebar-aside:not(.poracode-sidebar-aside--overlay)',
        "-webkit-backdrop-filter",
      ),
    ).toBe("var(--glass-backdrop)");

    const reducedShellRule = rulesFor('html[data-native-material="on"] .poracode-shell').find(
      (rule) =>
        rule.parent?.type === "atrule" &&
        (rule.parent as AtRule).params.includes("reduced-transparency"),
    );
    expect(declaration(reducedShellRule!, "background-image")?.value).toBe("none");

    const reducedSidebarRule = rulesFor(
      'html[data-native-material="on"] .poracode-sidebar-aside:not(.poracode-sidebar-aside--overlay)',
    ).find(
      (rule) =>
        rule.parent?.type === "atrule" &&
        (rule.parent as AtRule).params.includes("reduced-transparency"),
    );
    expect(declaration(reducedSidebarRule!, "background")?.value).toBe("var(--sidebar-background)");
    expect(declaration(reducedSidebarRule!, "background-image")?.value).toBe("none");
    expect(declaration(reducedSidebarRule!, "backdrop-filter")?.value).toBe("none");
    expect(declaration(reducedSidebarRule!, "-webkit-backdrop-filter")?.value).toBe("none");
  });

  it("uses a visibly diffused blur and saturation recipe on stable chrome", () => {
    const recipe = valueFor(":root", "--glass-backdrop");
    const blur = Number(recipe.match(/blur\((\d+)px\)/)?.[1] ?? 0);
    const saturation = Number(recipe.match(/saturate\((\d+)%\)/)?.[1] ?? 0);

    expect(blur).toBeGreaterThanOrEqual(36);
    expect(saturation).toBeGreaterThanOrEqual(175);
    expect(valueFor(":root", "--glass-grain")).toContain("feTurbulence");
    expect(valueFor(":root", "--glass-grain")).toContain("opacity='.09'");
    expect(valueFor(":root", "--glass-specular")).toContain("18%");
    expect(valueFor(".dark", "--glass-specular")).toContain("13%");

    for (const selector of [
      ".poracode-glass-chrome",
      ".popover",
      ".dropdown__popover",
      ".poracode-mention-popover",
    ]) {
      expect(valueFor(selector, "backdrop-filter")).toBe("var(--glass-backdrop)");
      expect(valueFor(selector, "-webkit-backdrop-filter")).toBe("var(--glass-backdrop)");
      expect(valueFor(selector, "background-image")).toContain("var(--glass-grain)");
      expect(valueFor(selector, "background-blend-mode")).toBe("normal, normal");
    }

    expect(valueFor(".poracode-glass-chrome", "background-blend-mode")).toBe("normal, normal");

    // Pane-local toolbars can multiply with splits and embedded webviews. They
    // reuse the tint/rim language, but must not allocate another filtered
    // compositor surface per pane.
    for (const selector of [".poracode-thread-header-glass", ".poracode-browser-chrome"]) {
      expect(
        rulesFor(selector).some((rule) => {
          const filter = declaration(rule, "backdrop-filter");
          return filter !== undefined && filter.value !== "none";
        }),
      ).toBe(false);
    }
  });

  it("separates optical rim and lens layers from interactive content", () => {
    for (const selector of [".poracode-glass-chrome::before", ".poracode-glass-chrome::after"]) {
      expect(valueFor(selector, "content")).toBe('""');
      expect(valueFor(selector, "position")).toBe("absolute");
      expect(valueFor(selector, "inset")).toBe("0");
      expect(valueFor(selector, "border-radius")).toBe("inherit");
      expect(valueFor(selector, "pointer-events")).toBe("none");
    }

    const reducedTransparencyRules = rulesFor(".poracode-glass-chrome::before").filter((rule) => {
      const parent = rule.parent;
      return (
        parent?.type === "atrule" && (parent as AtRule).params.includes("reduced-transparency")
      );
    });
    expect(reducedTransparencyRules).toHaveLength(1);
    expect(declaration(reducedTransparencyRules[0]!, "display")?.value).toBe("none");
  });

  it("never blurs browser guests, content planes, or per-tab controls", () => {
    root.walkRules((rule) => {
      const hasFilter = rule.nodes.some(
        (node) =>
          node.type === "decl" &&
          ["filter", "backdrop-filter", "-webkit-backdrop-filter"].includes(node.prop),
      );
      if (!hasFilter) return;
      expect(rule.selector).not.toMatch(
        /webview|data-y-space-browser-host|poracode-browser-content-plane|poracode-thread-content-plane|poracode-workspace-tab(?!-strip)/,
      );
    });

    const browserHost = readFileSync(
      join(
        process.cwd(),
        "src/renderer/views/MainView/parts/RightPanel/parts/BrowserPanel/BrowserHost.tsx",
      ),
      "utf8",
    );
    const browserPanel = readFileSync(
      join(
        process.cwd(),
        "src/renderer/views/MainView/parts/RightPanel/parts/BrowserPanel/BrowserPanel.tsx",
      ),
      "utf8",
    );
    const tabStrip = readFileSync(
      join(process.cwd(), "src/renderer/components/layout/RightWorkspaceTabStrip.tsx"),
      "utf8",
    );
    expect(browserHost).not.toContain("poracode-glass-chrome");
    expect(browserPanel).not.toContain("poracode-glass-chrome");
    expect(tabStrip.match(/poracode-glass-chrome/g) ?? []).toHaveLength(1);
  });
});

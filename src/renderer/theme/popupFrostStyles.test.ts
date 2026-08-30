import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, type AtRule, type Declaration, type Rule } from "postcss";
import { describe, expect, it } from "vitest";

const styles = readFileSync(join(process.cwd(), "src/renderer/styles.css"), "utf8");
const responsiveMenuSource = readFileSync(
  join(process.cwd(), "src/renderer/components/common/ResponsiveMenuSurface.tsx"),
  "utf8",
);
const viteConfigSource = readFileSync(join(process.cwd(), "vite.config.ts"), "utf8");
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

describe("frosted popup material", () => {
  it("marks every desktop responsive menu as a real frosted surface", () => {
    expect(responsiveMenuSource).toContain("poracode-frosted-popover");
    expect(responsiveMenuSource).toMatch(/className=\{desktopContentClassName\}/);
  });

  it("uses a strong bounded blur and a visible local color field", () => {
    const recipe = valueFor(":root", "--popup-frost-backdrop");
    const blur = Number(recipe.match(/blur\((\d+)px\)/)?.[1] ?? 0);
    const saturation = Number(recipe.match(/saturate\((\d+)%\)/)?.[1] ?? 0);

    expect(blur).toBeGreaterThanOrEqual(48);
    expect(saturation).toBeGreaterThanOrEqual(185);
    expect(
      valueFor(":root", "--popup-frost-color-field").match(/radial-gradient/g) ?? [],
    ).toHaveLength(3);
    expect(valueFor(":root", "--popup-frost-color-field")).not.toContain("white 5%, transparent");
    expect(valueFor(".poracode-frosted-popover", "position")).toBe("relative");
    expect(valueFor(".poracode-frosted-popover", "isolation")).toBe("isolate");
    expect(valueFor(".poracode-frosted-popover", "overflow")).toBe("hidden");
    expect(valueFor(".poracode-frosted-popover", "background")).toBe("var(--popup-frost-surface)");
    expect(valueFor(".poracode-frosted-popover", "background-image")).toContain(
      "var(--popup-frost-color-field)",
    );
    expect(valueFor(".poracode-frosted-popover", "backdrop-filter")).toBe(
      "var(--popup-frost-backdrop)",
    );
    expect(valueFor(".poracode-frosted-popover", "-webkit-backdrop-filter")).toBe(
      "var(--popup-frost-backdrop)",
    );
  });

  it("preserves the standard backdrop-filter declaration in production CSS", () => {
    // Tailwind 4.3.2's Lightning CSS optimization currently collapses the
    // standard and prefixed declarations to only -webkit-backdrop-filter.
    // Electron 43 does not expose that alias, so the packaged app computes
    // `none` even though dev/source CSS looks correct. Esbuild retains both.
    expect(viteConfigSource).toContain("tailwindcss({ optimize: false })");
    expect(viteConfigSource).toContain('cssMinify: "esbuild"');
  });

  it("keeps content sharp above non-interactive optical rim and lens layers", () => {
    for (const selector of [
      ".poracode-frosted-popover::before",
      ".poracode-frosted-popover::after",
    ]) {
      expect(valueFor(selector, "content")).toBe('""');
      expect(valueFor(selector, "position")).toBe("absolute");
      expect(valueFor(selector, "inset")).toBe("0");
      expect(valueFor(selector, "border-radius")).toBe("inherit");
      expect(valueFor(selector, "pointer-events")).toBe("none");
    }

    expect(valueFor('.poracode-frosted-popover [data-slot="popover-dialog"]', "position")).toBe(
      "relative",
    );
    expect(valueFor('.poracode-frosted-popover [data-slot="popover-dialog"]', "z-index")).toBe("1");
    expect(valueFor('.poracode-frosted-popover [data-slot="popover-dialog"]', "background")).toBe(
      "transparent",
    );
  });

  it("becomes opaque and removes optical layers for reduced transparency", () => {
    const reducedSurface = rulesFor(".poracode-frosted-popover").find(
      (rule) =>
        rule.parent?.type === "atrule" &&
        (rule.parent as AtRule).params.includes("reduced-transparency"),
    );
    expect(declaration(reducedSurface!, "background")?.value).toBe("var(--overlay)");
    expect(declaration(reducedSurface!, "background-image")?.value).toBe("none");
    expect(declaration(reducedSurface!, "backdrop-filter")?.value).toBe("none");
    expect(declaration(reducedSurface!, "-webkit-backdrop-filter")?.value).toBe("none");

    for (const selector of [
      ".poracode-frosted-popover::before",
      ".poracode-frosted-popover::after",
    ]) {
      const reducedOptics = rulesFor(selector).find(
        (rule) =>
          rule.parent?.type === "atrule" &&
          (rule.parent as AtRule).params.includes("reduced-transparency"),
      );
      expect(declaration(reducedOptics!, "display")?.value).toBe("none");
    }
  });
});

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SKILLS_ROOT = join(process.cwd(), "resources", "skills");

const EXPECTED_SKILLS = [
  "y-space-app-control",
  "y-space-browser",
  "y-space-integrations",
  "y-space-skill-creator",
] as const;

describe("Y Space bundled skills", () => {
  it("ships every core capability as an app-private built-in skill", async () => {
    const folders = (await readdir(SKILLS_ROOT, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(folders).toEqual(EXPECTED_SKILLS);
  });

  it.each(EXPECTED_SKILLS)("keeps %s portable and branded", async (folder) => {
    const source = await readFile(join(SKILLS_ROOT, folder, "SKILL.md"), "utf8");

    expect(source).toMatch(/^---\nname: [a-z0-9]+(?:-[a-z0-9]+)*\ndescription: .+\n---\n/u);
    expect(source).toContain(`name: ${folder}`);
    expect(source).toContain("Y Space");
    expect(source).not.toMatch(/\b(?:Lightcode|Poracode)\b/u);
  });

  it("teaches agents to inventory and reuse embedded tabs", async () => {
    const source = await readFile(join(SKILLS_ROOT, "y-space-browser", "SKILL.md"), "utf8");

    expect(source).toContain("browser.list_tabs");
    expect(source).toContain("embedded browser");
    expect(source).toContain("orange cursor");
    expect(source).toContain("inventory and inspection stay in the background");
    expect(source).toContain("Do not open or control an external browser");
  });

  it("keeps Pipedream secrets outside agent context", async () => {
    const source = await readFile(join(SKILLS_ROOT, "y-space-integrations", "SKILL.md"), "utf8");

    expect(source).toContain("Pipedream");
    expect(source).toContain("composer **+** menu");
    expect(source).toContain("embedded browser");
    expect(source).toContain("available to the running agent automatically");
    expect(source).toContain("never request, reveal, or persist credentials");
  });
});

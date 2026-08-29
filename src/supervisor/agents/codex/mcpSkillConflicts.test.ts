import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedMcpServer } from "@/shared/contracts";
import {
  buildCodexMcpSkillConflictArgs,
  buildCodexMcpSkillConflictArgsForPaths,
  resolveCodexProfileHomePaths,
  serializeSkillConfigOverride,
} from "./mcpSkillConflicts";

const tempDirs: string[] = [];
const originalCodexHome = process.env.CODEX_HOME;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
});

function browserServer(): ResolvedMcpServer {
  return {
    id: "browser",
    name: "browser",
    timeoutMs: 30_000,
    transport: { type: "http", url: "http://127.0.0.1:9000/mcp", headers: {} },
  };
}

describe("Codex MCP skill conflicts", () => {
  it("serializes preserved skill settings and the Poracode-specific disable", () => {
    expect(
      serializeSkillConfigOverride([
        { path: "/skills/user/SKILL.md", enabled: true },
        {
          path: "C:\\Users\\demo\\.codex\\plugins\\browser\\SKILL.md",
          enabled: false,
        },
      ]),
    ).toBe(
      '[{ path = "/skills/user/SKILL.md", enabled = true }, { path = "C:\\\\Users\\\\demo\\\\.codex\\\\plugins\\\\browser\\\\SKILL.md", enabled = false }]',
    );
  });

  it("disables known browser skills only for a launch with Y Space Browser MCP", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "poracode-codex-skill-"));
    tempDirs.push(codexHome);
    const browserSkill = join(
      codexHome,
      "plugins",
      "cache",
      "openai-bundled",
      "browser",
      "1.2.3",
      "skills",
      "control-in-app-browser",
      "SKILL.md",
    );
    mkdirSync(join(browserSkill, ".."), { recursive: true });
    writeFileSync(browserSkill, "---\nname: control-in-app-browser\n---\n");
    const gstackSkill = join(codexHome, "skills", "gstack", "SKILL.md");
    const browserUseSkill = join(codexHome, "skills", "browser-use", "SKILL.md");
    const playwrightSkill = join(codexHome, "skills", "playwright", "SKILL.md");
    const genericQaSkill = join(codexHome, "skills", "qa", "SKILL.md");
    const unrelatedSkill = join(codexHome, "skills", "code-review", "SKILL.md");
    for (const skillPath of [
      gstackSkill,
      browserUseSkill,
      playwrightSkill,
      genericQaSkill,
      unrelatedSkill,
    ]) {
      mkdirSync(join(skillPath, ".."), { recursive: true });
      writeFileSync(skillPath, `---\nname: ${join(skillPath, "..").split("/").at(-1)}\n---\n`);
    }
    const configPath = join(codexHome, "config.toml");
    writeFileSync(
      configPath,
      [
        '[[skills.config]]\npath = "/skills/keep-disabled/SKILL.md"\nenabled = false',
        `[[skills.config]]\npath = ${JSON.stringify(gstackSkill)}\nenabled = true`,
        `[[skills.config]]\npath = ${JSON.stringify(browserUseSkill)}\nenabled = true`,
        `[[skills.config]]\npath = ${JSON.stringify(playwrightSkill)}\nenabled = true`,
        `[[skills.config]]\npath = ${JSON.stringify(genericQaSkill)}\nenabled = true`,
        `[[skills.config]]\npath = ${JSON.stringify(unrelatedSkill)}\nenabled = true`,
        '[mcp_servers.node_repl]\ncommand = "node_repl"',
        '[mcp_servers.playwright]\ncommand = "playwright"',
        '[mcp_servers.chrome_devtools]\nurl = "http://chrome.test/mcp"',
        '[mcp_servers.github]\nurl = "https://github.test/mcp"',
        '[mcp_servers.pipedream]\ncommand = "node"\ncwd = "/repo/y-space-browser-default-collapse"',
        '[mcp_servers.analytics]\nurl = "https://integrations.test/browser-events/mcp"',
      ].join("\n"),
    );

    const args = buildCodexMcpSkillConflictArgsForPaths([browserServer()], codexHome, codexHome, [
      configPath,
    ]);

    expect(args[0]).toBe("-c");
    expect(args[1]).toContain('path = "/skills/keep-disabled/SKILL.md", enabled = false');
    expect(args[1]).toContain(`path = ${JSON.stringify(browserSkill)}, enabled = false`);
    expect(args[1]).toContain(`path = ${JSON.stringify(gstackSkill)}, enabled = false`);
    expect(args[1]).toContain(`path = ${JSON.stringify(browserUseSkill)}, enabled = false`);
    expect(args[1]).toContain(`path = ${JSON.stringify(playwrightSkill)}, enabled = false`);
    expect(args[1]).toContain(`path = ${JSON.stringify(genericQaSkill)}, enabled = true`);
    expect(args[1]).toContain(`path = ${JSON.stringify(unrelatedSkill)}, enabled = true`);
    const overrides = args.flatMap((arg, index) => (arg === "-c" ? [args[index + 1]] : []));
    expect(overrides).toEqual(
      expect.arrayContaining([
        "mcp_servers.node_repl.enabled=false",
        "mcp_servers.playwright.enabled=false",
        "mcp_servers.chrome_devtools.enabled=false",
        "mcp_servers.github.enabled=false",
        "mcp_servers.pipedream.enabled=false",
        "mcp_servers.analytics.enabled=false",
      ]),
    );
  });

  it("inspects the same custom CODEX_HOME source used to seed the private launch profile", () => {
    const root = mkdtempSync(join(tmpdir(), "y-space-codex-custom-profile-"));
    tempDirs.push(root);
    const customHome = join(root, "custom-codex-home");
    const project = join(root, "project");
    mkdirSync(customHome, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(customHome, "config.toml"),
      '[mcp_servers.neutral]\nurl = "https://neutral-profile.test/mcp"\n',
    );
    process.env.CODEX_HOME = customHome;

    const args = buildCodexMcpSkillConflictArgs({ kind: "posix", path: project }, [
      browserServer(),
    ]);

    expect(args).toContain("mcp_servers.neutral.enabled=false");
  });

  it("resolves a custom WSL CODEX_HOME from the launch login-shell profile", () => {
    const paths = resolveCodexProfileHomePaths(
      {
        kind: "wsl",
        distro: "Ubuntu",
        linuxPath: "/work/repo",
        uncPath: "\\\\wsl.localhost\\Ubuntu\\work\\repo",
      },
      { HOME: "/home/demo", CODEX_HOME: "/srv/codex-profile" },
    );

    expect(paths?.providerPath).toBe("/srv/codex-profile");
    expect(paths?.hostPath.replace(/\\/gu, "/")).toContain("/srv/codex-profile");
  });

  it("does not copy malformed config contents or credentials into logs", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "poracode-codex-malformed-"));
    tempDirs.push(codexHome);
    const configPath = join(codexHome, "config.toml");
    const secret = "pd-secret-must-not-reach-logs";
    writeFileSync(configPath, `[mcp_servers.pipedream]\ntoken = "${secret}`);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(
      buildCodexMcpSkillConflictArgsForPaths([browserServer()], codexHome, codexHome, [configPath]),
    ).toEqual([]);
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
    warn.mockRestore();
  });

  it("does not alter skills when Poracode browser MCP is absent", () => {
    expect(buildCodexMcpSkillConflictArgsForPaths([], "/missing", "/missing", [])).toEqual([]);
  });

  it("requires the canonical Y Space Browser identity before suppressing routes", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "y-space-codex-noncanonical-browser-"));
    tempDirs.push(codexHome);
    const browserSkill = join(codexHome, "skills", "playwright", "SKILL.md");
    mkdirSync(join(browserSkill, ".."), { recursive: true });
    writeFileSync(browserSkill, "---\nname: playwright\n---\n");

    expect(
      buildCodexMcpSkillConflictArgsForPaths(
        [{ ...browserServer(), name: "documentation" }],
        codexHome,
        codexHome,
        [],
      ),
    ).toEqual([]);
  });

  it("disables browser skills in the project and every scanned ancestor only", () => {
    const workspace = mkdtempSync(join(tmpdir(), "y-space-codex-project-skills-"));
    tempDirs.push(workspace);
    const project = join(workspace, "repo");
    const nested = join(project, "packages", "desktop");
    const ancestorBrowser = join(project, ".agents", "skills", "browse", "SKILL.md");
    const nestedBrowser = join(nested, ".agents", "skills", "control-in-app-browser", "SKILL.md");
    const unrelated = join(project, ".agents", "skills", "code-review", "SKILL.md");
    for (const skillPath of [ancestorBrowser, nestedBrowser, unrelated]) {
      mkdirSync(join(skillPath, ".."), { recursive: true });
      writeFileSync(skillPath, `---\nname: ${join(skillPath, "..").split("/").at(-1)}\n---\n`);
    }

    const args = buildCodexMcpSkillConflictArgs({ kind: "posix", path: nested }, [browserServer()]);
    const skillOverride = args.find((arg) => arg.startsWith("skills.config="));

    expect(skillOverride).toContain(`path = ${JSON.stringify(ancestorBrowser)}, enabled = false`);
    expect(skillOverride).toContain(`path = ${JSON.stringify(nestedBrowser)}, enabled = false`);
    expect(skillOverride).not.toContain(unrelated);
  });
});

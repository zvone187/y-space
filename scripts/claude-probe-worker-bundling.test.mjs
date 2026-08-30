import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

void test("bundles the Claude SDK only into the portable WSL probe worker", () => {
  const config = readFileSync(resolve(repoRoot, "tsdown.config.ts"), "utf8");
  const helper = readFileSync(resolve(repoRoot, "scripts", "prepare-wsl-helpers.mjs"), "utf8");

  assert.match(
    config,
    /alwaysBundle:\s*\[\.\.\.deps\.alwaysBundle,\s*"@anthropic-ai\/claude-agent-sdk"\]/u,
  );
  assert.match(
    config,
    /neverBundle:\s*deps\.neverBundle\.filter\([\s\S]*dependency !== "@anthropic-ai\/claude-agent-sdk"/u,
  );
  assert.match(config, /entry:\s*\{ claudeSdkProbeWorker:[\s\S]*?deps:\s*claudeProbeDeps/u);
  assert.match(helper, /assertSelfContainedWorker\(src, "Claude SDK probe worker"\)/u);
});

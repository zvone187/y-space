/**
 * Stages every Node helper that we run *inside* a WSL distro into
 * `resources/wsl-helpers/`. Executable JavaScript stays packed in ASAR:
 *
 *   1. `bridge.mjs` — the in-distro server (hook ingress + /v1/fs/*
 *      + /v1/watch/*). Copied from `src/supervisor/wsl/bridge/bridge.mjs`.
 *   2. The MCP probe/filter and Cursor workers stay adjacent to the supervisor
 *      in packed `dist/main`; this script verifies they are self-contained but
 *      never creates a mutable packaged copy.
 *
 * The separately deployed `claudeSdkProbeWorker.mjs` is also verified here;
 * it stays in the packed ASAR and is read through Electron before deployment.
 *
 * Helpers are compared byte-for-byte before copy, avoiding redundant writes
 * without the stale-resource risk of size/mtime heuristics.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const destDir = join(repoRoot, "resources", "wsl-helpers");

mkdirSync(destDir, { recursive: true });

stageHookBridge();
verifyMcpProbe();
verifyMcpFilter();
verifyCursorSdkWorker();
verifyClaudeSdkProbeWorker();

function stageHookBridge() {
  const src = join(repoRoot, "src", "supervisor", "wsl", "bridge", "bridge.mjs");
  if (!existsSync(src)) {
    throw new Error(`hook bridge source missing: ${src}`);
  }
  const dest = join(destDir, "bridge.mjs");
  copyIfChanged(src, dest, "bridge.mjs");
}

function verifyMcpProbe() {
  const src = join(repoRoot, "dist", "main", "mcpProbeWorker.mjs");
  if (!existsSync(src)) {
    throw new Error(`MCP probe worker missing; run build:electron first: ${src}`);
  }
  assertSelfContainedWorker(src);
  console.log("[prepare-wsl-helpers] verified self-contained MCP probe worker");
}

function verifyMcpFilter() {
  const src = join(repoRoot, "dist", "main", "mcpToolFilterWorker.mjs");
  if (!existsSync(src)) {
    throw new Error(`MCP filter worker missing; run build:electron first: ${src}`);
  }
  assertSelfContainedWorker(src);
  console.log("[prepare-wsl-helpers] verified self-contained MCP filter worker");
}

function verifyCursorSdkWorker() {
  const src = join(repoRoot, "dist", "main", "cursorSdkWorker.mjs");
  if (!existsSync(src)) {
    throw new Error(`Cursor SDK worker missing; run build:electron first: ${src}`);
  }
  assertSelfContainedWorker(src, "Cursor SDK worker");
  console.log("[prepare-wsl-helpers] verified self-contained Cursor SDK worker");
}

function verifyClaudeSdkProbeWorker() {
  const src = join(repoRoot, "dist", "main", "claudeSdkProbeWorker.mjs");
  if (!existsSync(src)) {
    throw new Error(`Claude SDK probe worker missing; run build:electron first: ${src}`);
  }
  assertSelfContainedWorker(src, "Claude SDK probe worker");
  console.log("[prepare-wsl-helpers] verified self-contained Claude SDK probe worker");
}

function copyIfChanged(src, dest, label) {
  if (existsSync(dest) && readFileSync(src).equals(readFileSync(dest))) {
    console.log(`[prepare-wsl-helpers] ${label} already current, skipping`);
    return;
  }
  copyFileSync(src, dest);
  console.log(`[prepare-wsl-helpers] ${label} -> ${dest}`);
}

function assertSelfContainedWorker(path, label = "MCP probe worker") {
  const source = readFileSync(path, "utf8");
  const imports = source.matchAll(/^import(?:[\s\S]*?\sfrom\s*)?["']([^"']+)["'];?$/gm);
  const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
  const external = [...imports].map((match) => match[1]).filter((name) => !builtins.has(name));
  if (external.length > 0) {
    throw new Error(`${label} is not self-contained: ${[...new Set(external)].join(", ")}`);
  }
}

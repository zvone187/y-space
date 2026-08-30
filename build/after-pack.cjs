// electron-builder afterPack hook.
//
// node-pty ships a `spawn-helper` binary that posix_spawn invokes to set up
// the pty. Keep only the target platform/architecture prebuild in each thin
// package, then restore +x because electron-builder's asar-unpack copy can
// strip the execute bit and make posix_spawnp fail with the opaque
// "posix_spawnp failed." error.

const {
  existsSync,
  statSync,
  chmodSync,
  readdirSync,
  mkdirSync,
  cpSync,
  rmSync,
} = require("node:fs");
const { join, resolve } = require("node:path");
const { prepareMacAppBundleForPackaging } = require("./mac-signing.cjs");

// electron-builder's Arch enum is numeric: ia32=0, x64=1, armv7l=2, arm64=3,
// universal=4. Map to the node-pty prebuilds/<plat>-<arch> directory names.
const ARCH_NAME = { 0: "ia32", 1: "x64", 2: "arm", 3: "arm64", 4: "universal" };

function ensureExecutable(path) {
  if (!existsSync(path)) return false;
  const stat = statSync(path);
  if (!stat.isFile()) return false;
  if ((stat.mode & 0o111) === 0o111) return false;
  chmodSync(path, stat.mode | 0o111);
  return true;
}

function findResourcesDir(appOutDir, electronPlatformName) {
  if (electronPlatformName === "darwin" || electronPlatformName === "mas") {
    const entries = readdirSync(appOutDir).filter((name) => name.endsWith(".app"));
    if (entries.length === 0) return null;
    return join(appOutDir, entries[0], "Contents", "Resources");
  }
  if (electronPlatformName === "linux") {
    return join(appOutDir, "resources");
  }
  if (electronPlatformName === "win32") {
    return join(appOutDir, "resources");
  }
  return null;
}

// Walk an @electron/asar raw header to a nested file entry, or null if absent.
function lookupAsarEntry(header, segments) {
  let node = header;
  for (const seg of segments) {
    node = node && node.files && node.files[seg];
    if (!node) return null;
  }
  return node;
}

function platformTag(electronPlatformName) {
  if (electronPlatformName === "darwin" || electronPlatformName === "mas") return "darwin";
  if (electronPlatformName === "win32") return "win32";
  return "linux";
}

// npm installs every node-pty prebuild from its package tarball. electron-builder
// preserves all of them under app.asar.unpacked, including the Intel-only macOS
// spawn-helper in an arm64 app. macOS treats that nested helper as an Intel-based
// component and displays its end-of-support warning even though Poracode itself
// and the helper it actually loads are arm64. Remove all foreign prebuilds from
// each thin package before signing. Older better-sqlite3 packages used a similar
// bin/<platform>-<arch>-<abi> layout, so prune those defensively as well.
function pruneForeignNativePrebuilds(resourcesDir, electronPlatformName, archName) {
  const expectedPrefix = `${platformTag(electronPlatformName)}-${archName}`;
  const roots = [
    {
      path: join(resourcesDir, "app.asar.unpacked", "node_modules", "node-pty", "prebuilds"),
      keep: (entry) => entry === expectedPrefix,
    },
    {
      path: join(resourcesDir, "app.asar.unpacked", "node_modules", "better-sqlite3", "bin"),
      keep: (entry) => entry === expectedPrefix || entry.startsWith(`${expectedPrefix}-`),
    },
  ];

  const removed = [];
  for (const root of roots) {
    if (!existsSync(root.path)) continue;
    for (const entry of readdirSync(root.path)) {
      if (root.keep(entry)) continue;
      const foreignPath = join(root.path, entry);
      rmSync(foreignPath, { recursive: true, force: true });
      removed.push(foreignPath);
    }
  }
  return removed;
}

// The packaging script (build-desktop-artifact.mjs) rebuilds better-sqlite3 for
// every target arch and stages each under <stageRoot>/native/<arch>/. A single
// multi-arch electron-builder pass packs only one of those binaries into BOTH
// installers, so the off-host arch would otherwise ship a wrong-arch
// better_sqlite3.node and crash. Inject the arch-correct staged binary into this
// arch's app.asar.unpacked (where the asar-unpacked module loads it), before
// code signing. Required for x64/arm64 — throw if the staged binary is missing.
function injectBetterSqliteBinary(context, resourcesDir, archName) {
  if (archName !== "x64" && archName !== "arm64") return;
  const projectDir =
    context.packager?.info?.projectDir ??
    context.packager?.projectDir ??
    resolve(context.appOutDir, "..", "..");
  const staged = join(projectDir, "native", archName, "better_sqlite3.node");
  if (!existsSync(staged)) {
    throw new Error(
      `[afterPack] FATAL: staged better-sqlite3 binary for ${archName} missing at ${staged}; ` +
        `refusing to ship a wrong-arch package.`,
    );
  }
  const destDir = join(
    resourcesDir,
    "app.asar.unpacked",
    "node_modules",
    "better-sqlite3",
    "build",
    "Release",
  );
  mkdirSync(destDir, { recursive: true });
  cpSync(staged, join(destDir, "better_sqlite3.node"));
  console.log(`[afterPack] injected ${archName} better_sqlite3.node`);
}

// Fail-fast guard: native binaries must remain ordinary files while every JS
// loader stays inside the integrity-checked ASAR. Electron redirects native
// entries marked `unpacked` to app.asar.unpacked while resolving their packed
// JavaScript callers normally. If any invariant is violated we THROW so a
// mutable unpacked script can never execute inside main or supervisor.
function assertNativeBinaries(resourcesDir, electronPlatformName, arch) {
  const archName = ARCH_NAME[arch];
  if (!archName) {
    throw new Error(`[afterPack] FATAL: unknown electron-builder Arch enum value ${arch}`);
  }
  const platTag = platformTag(electronPlatformName);

  const unpacked = join(resourcesDir, "app.asar.unpacked", "node_modules");

  // 1. better-sqlite3 compiled binary present in the unpacked tree.
  const betterSqliteBinary = join(
    unpacked,
    "better-sqlite3",
    "build",
    "Release",
    "better_sqlite3.node",
  );
  if (!existsSync(betterSqliteBinary)) {
    throw new Error(
      `[afterPack] FATAL: better-sqlite3 native binary missing — refusing to publish a broken app:\n  ${betterSqliteBinary}`,
    );
  }

  // 2. Inspect the ASAR header: native code must be marked unpacked, while all
  //    JavaScript/MJS entrypoints that execute in trusted processes must carry
  //    packed offsets and must never be shadowed as unpacked entries.
  const asarPath = join(resourcesDir, "app.asar");
  if (existsSync(asarPath)) {
    let asar;
    try {
      asar = require("@electron/asar");
    } catch {
      console.warn("[afterPack] @electron/asar unavailable; skipping in-asar packing check");
      asar = null;
    }
    if (asar) {
      const { header } = asar.getRawHeader(asarPath);
      const packedTrustedEntries = [
        ["node_modules", "better-sqlite3", "lib", "database.js"],
        ["node_modules", "node-pty", "lib", "index.js"],
        ["node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.mjs"],
        ["dist", "main", "claudeSdkProbeWorker.mjs"],
        ["dist", "main", "cursorSdkWorker.mjs"],
        ["dist", "main", "mcpProbeWorker.mjs"],
        ["dist", "main", "mcpToolFilterWorker.mjs"],
        ["resources", "wsl-helpers", "bridge.mjs"],
        ["resources", "agent-plugins", "_runtime", "poracode-hook-runtime.mjs"],
        ["resources", "skills", "y-space-browser", "SKILL.md"],
        ["resources", "plugins", "outlook", "mcp.json"],
      ];
      for (const segments of packedTrustedEntries) {
        const entry = lookupAsarEntry(header, segments);
        if (!entry || entry.unpacked === true || entry.offset === undefined) {
          throw new Error(
            `[afterPack] FATAL: trusted resource must be packed in app.asar: ${segments.join("/")}`,
          );
        }
      }
      const nativeEntry = lookupAsarEntry(header, [
        "node_modules",
        "better-sqlite3",
        "build",
        "Release",
        "better_sqlite3.node",
      ]);
      if (!nativeEntry || nativeEntry.unpacked !== true) {
        throw new Error(
          "[afterPack] FATAL: better-sqlite3 native binding is not marked unpacked in app.asar.",
        );
      }
    }
  }

  // 3. node-pty must ship a loadable binary for this arch. It loads from
  //    build/Release/pty.node (Linux, which has no prebuild) OR from a
  //    prebuilds/<plat>-<arch>/pty.node (mac/win ship prebuilts).
  const ptyCandidates = [
    join(unpacked, "node-pty", "build", "Release", "pty.node"),
    join(unpacked, "node-pty", "prebuilds", `${platTag}-${archName}`, "pty.node"),
  ];
  if (!ptyCandidates.some((p) => existsSync(p))) {
    throw new Error(
      `[afterPack] FATAL: node-pty native binary missing for ${platTag}-${archName} — refusing to publish:\n  ${ptyCandidates.join("\n  ")}`,
    );
  }

  console.log(
    `[afterPack] verified packed JavaScript and native binaries for ${platTag}-${archName}`,
  );
}

function assertNoUnpackedJavaScript(resourcesDir) {
  const pending = ["app.asar.unpacked", "wsl-helpers", "agent-plugins", "skills", "plugins"]
    .map((name) => join(resourcesDir, name))
    .filter((path) => existsSync(path));
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (/\.(?:cjs|js|mjs)$/iu.test(entry.name)) {
        throw new Error(
          `[afterPack] FATAL: executable JavaScript escaped the integrity-checked ASAR: ${path}`,
        );
      }
    }
  }
}

function chmodNodePtyHelpers(resourcesDir) {
  const prebuildsRoot = join(
    resourcesDir,
    "app.asar.unpacked",
    "node_modules",
    "node-pty",
    "prebuilds",
  );
  if (!existsSync(prebuildsRoot)) return [];
  const fixed = [];
  for (const platformDir of readdirSync(prebuildsRoot)) {
    const helper = join(prebuildsRoot, platformDir, "spawn-helper");
    if (ensureExecutable(helper)) fixed.push(helper);
  }
  return fixed;
}

module.exports = async function afterPack(context) {
  const resourcesDir = findResourcesDir(context.appOutDir, context.electronPlatformName);
  if (!resourcesDir) {
    throw new Error(
      `[afterPack] FATAL: could not locate resources dir for platform ${context.electronPlatformName}`,
    );
  }
  // Replace the (possibly off-host-arch) binary electron-builder packed with the
  // arch-correct one staged per target arch.
  const archName = ARCH_NAME[context.arch];
  injectBetterSqliteBinary(context, resourcesDir, archName);
  const removed = pruneForeignNativePrebuilds(resourcesDir, context.electronPlatformName, archName);
  for (const path of removed) {
    console.log(`[afterPack] pruned foreign native prebuild ${path}`);
  }
  // Throws if a required native binary is missing or mis-packed, so a broken
  // app can never be packaged or published.
  assertNativeBinaries(resourcesDir, context.electronPlatformName, context.arch);
  assertNoUnpackedJavaScript(resourcesDir);
  const fixed = chmodNodePtyHelpers(resourcesDir);
  for (const path of fixed) {
    console.log(`[afterPack] chmod +x ${path}`);
  }
  // Local macOS builds without configured credentials must still be signed
  // before electron-builder creates a DMG/ZIP. A later certificate signing pass
  // replaces this ad-hoc signature when keychain auto-discovery finds one.
  prepareMacAppBundleForPackaging(context);
};

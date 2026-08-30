import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { getCachedWslHomeDirectory, resolveWslHomeDirectory } from "../agents/base";

/**
 * Shared "stage files into a WSL distro" primitive used by both the git
 * watcher (parcel native binding + watcher.cjs) and the CLI hook bridge
 * (bridge.mjs). Copies happen via `\\wsl.localhost\<distro>\...` UNC paths,
 * which Node's `fs` writes to natively — no `wsl.exe -- cp` round trip
 * required.
 */

export interface WslHomeDeployResult {
  /** Linux path of the user's home directory inside the distro. */
  home: string;
  /** Linux path of the deploy base (`<home>/.poracode`). */
  linuxBaseDir: string;
}

export type WslDeployFile =
  | {
      /** Absolute Windows source path. */
      readonly src: string;
      /** POSIX path relative to the selected WSL deployment base. */
      readonly relDest: string;
    }
  | {
      /** Bytes already read through Electron's integrity-checked ASAR layer. */
      readonly content: string | Buffer;
      /** POSIX path relative to the selected WSL deployment base. */
      readonly relDest: string;
    };

export interface WslBaseDeployResult {
  /** Linux path of the deploy base inside the distro. */
  linuxBaseDir: string;
  /** Best-effort, idempotent removal of this exact private deployment. */
  cleanup(): void;
}

function createWslTempBaseCleanup(uncBase: string): () => void {
  let cleaned = false;
  return () => {
    if (cleaned) return;
    try {
      rmSync(uncBase, { recursive: true, force: true });
      cleaned = true;
    } catch {
      // Best effort; a later lifecycle callback may retry the removal.
    }
  };
}

/**
 * Resolve the directory containing WSL helper assets shipped with the app
 * (bridge.mjs, probe workers, …). The main process exports
 * `PORACODE_WSL_HELPERS_DIR`; we keep a back-compat fallback to the legacy
 * `PORACODE_WSL_WATCHER_DIR` for one release while installs roll over.
 */
export function resolveWslHelpersDir(): string | undefined {
  return process.env.PORACODE_WSL_HELPERS_DIR ?? process.env.PORACODE_WSL_WATCHER_DIR;
}

/**
 * Idempotently stage a set of files into a WSL distro's
 * `<home>/.poracode/<relDest>`. Returns the resolved home + linuxBaseDir on
 * success, or `null` when:
 *   - `$HOME` cannot be resolved through the bootstrap WSL path
 *   - any source file is missing
 *   - the UNC copy errors out (permission, disk, distro restart, …)
 *
 * Idempotent in the same sense as `prepare-wsl-helpers.mjs` is for the
 * Windows side — re-runs are cheap because identical size+mtime files are
 * skipped.
 */
export function deployFilesToWslHome(
  distro: string,
  files: readonly WslDeployFile[],
): WslHomeDeployResult | null {
  const home = getCachedWslHomeDirectory(distro) ?? resolveWslHomeDirectory(distro);
  if (!home) return null;

  for (const file of files) {
    if ("src" in file && !existsSync(file.src)) return null;
  }

  const uncHome = `\\\\wsl.localhost\\${distro}${home.replaceAll("/", "\\")}`;
  const linuxBaseDir = `${home}/.poracode`;

  try {
    for (const file of files) {
      const segments = file.relDest.split("/").filter((segment) => segment.length > 0);
      const winDest = [uncHome, ".poracode", ...segments].join("\\");
      mkdirSync(dirname(winDest), { recursive: true });
      if ("src" in file) {
        if (isFresh(file.src, winDest)) continue;
        copyFileSync(file.src, winDest);
      } else {
        if (isFreshContent(file.content, winDest)) continue;
        writeFileSync(winDest, file.content, { mode: 0o600 });
      }
    }
  } catch {
    return null;
  }

  return { home, linuxBaseDir };
}

export function deployFilesToWslTempBase(
  distro: string,
  baseName: string,
  files: readonly WslDeployFile[],
): WslBaseDeployResult | null {
  for (const file of files) {
    if ("src" in file && !existsSync(file.src)) return null;
  }

  const privateBaseName = createWslPrivateTempBaseName(baseName);
  const linuxBaseDir = `/tmp/${privateBaseName}`;
  const uncBase = `\\\\wsl.localhost\\${distro}\\tmp\\${privateBaseName}`;
  let created = false;
  let cleanup: (() => void) | undefined;

  try {
    // High-entropy, exclusive base creation prevents an untrusted sibling
    // process from preplanting helper paths before trusted bytes arrive.
    mkdirSync(uncBase, { recursive: false, mode: 0o700 });
    created = true;
    cleanup = createWslTempBaseCleanup(uncBase);
    for (const file of files) {
      const segments = file.relDest.split("/").filter((segment) => segment.length > 0);
      const winDest = [uncBase, ...segments].join("\\");
      mkdirSync(dirname(winDest), { recursive: true });
      if ("src" in file) {
        copyFileSync(file.src, winDest, constants.COPYFILE_EXCL);
      } else {
        writeFileSync(winDest, file.content, { flag: "wx", mode: 0o600 });
      }
    }
  } catch {
    if (created) {
      cleanup?.();
    }
    return null;
  }

  if (!cleanup) return null;
  return { linuxBaseDir, cleanup };
}

export function createWslPrivateTempBaseName(
  baseName: string,
  uuid: () => string = randomUUID,
): string {
  const safePrefix = baseName.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80) || "y-space";
  return `${safePrefix}-${uuid()}`;
}

const VERIFIED_ESM_LOADER = String.raw`
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
const [scriptPath, expectedHash, ...scriptArgs] = process.argv.slice(1);
const bytes = await readFile(scriptPath);
const actualHash = createHash("sha256").update(bytes).digest("hex");
if (actualHash !== expectedHash) throw new Error("Y Space helper integrity check failed");
process.argv = [process.argv[0], scriptPath, ...scriptArgs];
const fileUrl = pathToFileURL(scriptPath).href;
const source = bytes.toString("utf8").replaceAll("import.meta.url", JSON.stringify(fileUrl));
await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
`;

/**
 * Build Node argv that reads a deployed module into memory, authenticates the
 * exact bytes, and only then imports that in-memory source. The helper's path
 * may be owner-writable in a same-uid WSL distro; replacing it can therefore
 * cause a clean refusal, but can never substitute executable code.
 */
export function buildVerifiedWslEsmArgv(
  scriptPath: string,
  trustedContent: string | Buffer,
  scriptArgs: readonly string[] = [],
): string[] {
  const expectedHash = createHash("sha256").update(trustedContent).digest("hex");
  return [
    "--input-type=module",
    "--eval",
    VERIFIED_ESM_LOADER,
    scriptPath,
    expectedHash,
    ...scriptArgs,
  ];
}

function isFresh(src: string, dest: string): boolean {
  try {
    if (!existsSync(dest)) return false;
    const sourceStat = statSync(src);
    const destStat = statSync(dest);
    if (sourceStat.size !== destStat.size) return false;
    if (sourceStat.mtimeMs > destStat.mtimeMs) return false;
    return true;
  } catch {
    return false;
  }
}

function isFreshContent(content: string | Buffer, dest: string): boolean {
  try {
    return existsSync(dest) && readFileSync(dest).equals(Buffer.from(content));
  } catch {
    return false;
  }
}

/**
 * Read a `const <NAME> = "<x.y.z>"` (or `let` / `var`) declaration out of a
 * bundled WSL helper file and return the literal value. Used by the
 * Windows-side managers to know which version they *expect* to be running
 * inside WSL, so they can compare against the `boot:<version>` line every
 * helper emits on startup. We read from the same `helpersDir` that actually
 * gets deployed, so "expected" always matches "what we just staged" — this
 * way a version mismatch unambiguously means "an older copy is still
 * running" (from a previous supervisor process / before the latest deploy
 * overwrote the file), and the caller can respond accordingly.
 *
 * Returns `undefined` when:
 *   - `resolveWslHelpersDir()` is unset (dev-without-env or test stub)
 *   - the file is missing or unreadable
 *   - the constant cannot be found (older helper without versioning)
 * All of these are treated as "don't version-check" by callers.
 */
export function readBundledHelperVersion(
  filename: string,
  constantName: string,
  helpersDir: string | undefined = resolveWslHelpersDir(),
): string | undefined {
  if (!helpersDir) return undefined;
  try {
    const source = readFileSync(join(helpersDir, filename), "utf8");
    // Anchor to start-of-line (with the `m` flag) so comment-indented
    // example snippets like `//   const X = "x.y.z"` don't match ahead of
    // the real declaration. Only whitespace is allowed before the keyword.
    const pattern = new RegExp(
      `^\\s*(?:export\\s+)?(?:const|let|var)\\s+${constantName}\\s*=\\s*["']([^"'\\s]+)["']`,
      "m",
    );
    return pattern.exec(source)?.[1];
  } catch {
    return undefined;
  }
}

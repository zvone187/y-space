import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

/**
 * Filesystem containment used to enforce the Agent Plugins package boundary.
 *
 * The specification requires that every package file remain within the
 * filesystem-resolved root *after* resolving symlinks, junctions, and reparse
 * points — so containment is decided on real paths, not lexical ones.
 *
 * @see https://agent-plugins.org/client-implementers/loading-and-discovery
 */

/** Strips Windows `\\?\` / `\\?\UNC\` prefixes so paths compare consistently. */
export function normalizeWindowsNamespacePath(path: string): string {
  let normalized = path;
  if (normalized.startsWith("\\\\?\\UNC\\")) normalized = `\\\\${normalized.slice(8)}`;
  else if (normalized.startsWith("\\\\?\\")) normalized = normalized.slice(4);
  else if (normalized.startsWith("//?/UNC/")) normalized = `//${normalized.slice(8)}`;
  else if (normalized.startsWith("//?/")) normalized = normalized.slice(4);
  return normalized;
}

/** Lexical containment. Returns the relative path when `target` is under `root`. */
export function relativePathInside(root: string, target: string): string | undefined {
  const candidate = relative(root, target);
  if (!candidate || isAbsolute(candidate) || candidate.split(/[\\/]/u)[0] === "..") {
    return undefined;
  }
  return candidate;
}

/**
 * Canonicalize the existing prefix of a path while retaining any missing tail.
 *
 * This matters on macOS where temporary paths are commonly authored through
 * `/var` but `realpath` reports `/private/var`. A policy target may not exist
 * yet, so resolving the complete target fails even though its existing parent
 * is enough to reconcile the aliases. Resolving the nearest existing ancestor
 * also preserves the security property for symlinks: an existing prefix that
 * escapes the package is canonicalized to its outside location before the
 * missing tail is appended.
 */
function resolveExistingPrefix(path: string): string | undefined {
  const missingSegments: string[] = [];
  let candidate = path;
  while (true) {
    try {
      return resolve(realpathSync.native(candidate), ...missingSegments);
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) return undefined;
      missingSegments.unshift(basename(candidate));
      candidate = parent;
    }
  }
}

/**
 * Real-path containment. Returns the relative path when `target` resolves inside
 * `root`, or `undefined` when it escapes.
 *
 * Falls back to normalized lexical comparison when a path does not exist yet,
 * which is what callers validating a *configured* path (not an existing file)
 * need.
 */
export function relativePolicyPath(root: string, target: string): string | undefined {
  const normalizedRoot = resolve(normalizeWindowsNamespacePath(root));
  const normalizedTarget = resolve(normalizeWindowsNamespacePath(target));
  try {
    return relativePathInside(
      resolve(realpathSync.native(root)),
      resolve(realpathSync.native(target)),
    );
  } catch {
    // Fall through to the normalized aliases for non-existent paths.
  }
  const direct = relativePathInside(normalizedRoot, normalizedTarget);
  if (direct) return direct;
  const resolvedRoot = resolveExistingPrefix(normalizedRoot);
  const resolvedTarget = resolveExistingPrefix(normalizedTarget);
  return resolvedRoot && resolvedTarget
    ? relativePathInside(resolvedRoot, resolvedTarget)
    : undefined;
}

/** True when `target` is the same path as `root` or resolves inside it. */
export function isPathInsideRoot(root: string, target: string): boolean {
  if (relativePolicyPath(root, target) !== undefined) return true;
  try {
    return resolve(realpathSync.native(root)) === resolve(realpathSync.native(target));
  } catch {
    return (
      resolve(normalizeWindowsNamespacePath(root)) ===
      resolve(normalizeWindowsNamespacePath(target))
    );
  }
}

/**
 * Resolves the filesystem-resolved package boundary for a plugin directory.
 * Returns `undefined` when the directory cannot be resolved.
 */
export function resolvePackageBoundary(root: string): string | undefined {
  try {
    return resolve(realpathSync.native(root));
  } catch {
    return undefined;
  }
}

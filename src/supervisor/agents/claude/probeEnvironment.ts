import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path, { posix as posixPath } from "node:path";
import { resolvePoracodePaths } from "@/shared/poracodePaths";
import type { ProjectLocation } from "@/shared/contracts";
import { readWslLoginShellCommandOutputAsync, resolveWslHomeDirectoryAsync } from "../base";

const CLAUDE_PROBE_DIR_NAME = "claude-probes";

export interface ClaudeProbeEnvironmentInput {
  adapterKind: string;
  location: ProjectLocation;
  baseDir?: string;
  profileConfigDir?: string;
  customEnv?: Record<string, string>;
}

export type ClaudeProbeEnvironmentResult =
  | {
      ok: true;
      probeEnv: Record<string, string> & {
        CLAUDE_CONFIG_DIR: string;
        CLAUDE_SECURESTORAGE_CONFIG_DIR: string;
      };
      /** Intentional profile environment for terminal authentication only. */
      authEnv?: Record<string, string>;
    }
  | { ok: false };

function profileSegment(adapterKind: string): string {
  if (adapterKind === "claude") return "default";
  const hash = createHash("sha256").update(adapterKind).digest("hex").slice(0, 16);
  return `profile-${hash}`;
}

function resolveNativeProfileConfigDir(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return path.join(homedir(), trimmed.slice(2));
  return trimmed;
}

function resolveWslProfileConfigDir(rawPath: string, homeDir: string): string {
  const trimmed = rawPath.trim();
  if (trimmed === "~") return homeDir;
  if (trimmed.startsWith("~/")) return posixPath.join(homeDir, trimmed.slice(2));
  return trimmed;
}

function buildProbeEnvironments(
  privateConfigDir: string,
  resolvedProfileConfigDir: string | undefined,
  customEnv: Record<string, string> | undefined,
): Extract<ClaudeProbeEnvironmentResult, { ok: true }> {
  // Preserve the exact environment intentional profile launches already use.
  // The private probe config wins only in the probe copy below.
  const authEnv: Record<string, string> = { ...customEnv };
  if (resolvedProfileConfigDir) {
    authEnv.CLAUDE_CONFIG_DIR = resolvedProfileConfigDir;
  }

  const authConfigDir = authEnv.CLAUDE_CONFIG_DIR?.trim();
  const secureStorageConfigDir =
    authEnv.CLAUDE_SECURESTORAGE_CONFIG_DIR !== undefined
      ? authEnv.CLAUDE_SECURESTORAGE_CONFIG_DIR
      : (authConfigDir ?? "");
  const probeEnv = {
    ...authEnv,
    CLAUDE_CONFIG_DIR: privateConfigDir,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: secureStorageConfigDir,
  };

  return {
    ok: true,
    probeEnv,
    ...(Object.keys(authEnv).length > 0 ? { authEnv } : {}),
  };
}

function createNativePrivateConfigDir(baseDir: string | undefined, segment: string): string {
  const configuredBaseDir = baseDir?.trim() || process.env.PORACODE_DATA_DIR?.trim() || undefined;
  const identityDir = path.join(
    resolvePoracodePaths(configuredBaseDir).cacheDir,
    CLAUDE_PROBE_DIR_NAME,
    segment,
  );
  const configDir = path.join(identityDir, "config");
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    // `mode` only affects newly-created directories. Re-assert it so a
    // pre-existing probe directory can never become a wider persistence sink.
    chmodSync(identityDir, 0o700);
    chmodSync(configDir, 0o700);
  }
  return configDir;
}

async function createWslPrivateConfigDir(
  location: Extract<ProjectLocation, { kind: "wsl" }>,
  segment: string,
): Promise<{ configDir: string; homeDir: string } | undefined> {
  const homeDir = await resolveWslHomeDirectoryAsync(location.distro);
  if (!homeDir) return undefined;
  const identityDir = posixPath.join(homeDir, ".poracode", "cache", CLAUDE_PROBE_DIR_NAME, segment);
  const configDir = posixPath.join(identityDir, "config");
  const created = await readWslLoginShellCommandOutputAsync(
    location.distro,
    "/",
    "sh",
    [
      "-c",
      'umask 077; mkdir -p -- "$1" "$2" && chmod 700 -- "$1" "$2"',
      "y-space-claude-probe",
      identityDir,
      configDir,
    ],
    { timeout: 5_000 },
  );
  return created.ok ? { configDir, homeDir } : undefined;
}

/**
 * Build the environment used only by Claude install/status/capability probes.
 *
 * Claude persists startup metadata next to `CLAUDE_CONFIG_DIR`, even for
 * read-looking commands such as `auth status` and SDK initialization. Probes
 * therefore receive a stable Y Space-owned private directory, while
 * `CLAUDE_SECURESTORAGE_CONFIG_DIR` points at the existing auth namespace. No
 * credential material is copied into the private directory.
 */
export async function resolveClaudeProbeEnvironment(
  input: ClaudeProbeEnvironmentInput,
): Promise<ClaudeProbeEnvironmentResult> {
  const segment = profileSegment(input.adapterKind);
  try {
    if (input.location.kind === "wsl") {
      const privateDir = await createWslPrivateConfigDir(input.location, segment);
      if (!privateDir) return { ok: false };
      const profileConfigDir = input.profileConfigDir?.trim()
        ? resolveWslProfileConfigDir(input.profileConfigDir, privateDir.homeDir)
        : undefined;
      return buildProbeEnvironments(privateDir.configDir, profileConfigDir, input.customEnv);
    }

    const privateConfigDir = createNativePrivateConfigDir(input.baseDir, segment);
    const profileConfigDir = input.profileConfigDir?.trim()
      ? resolveNativeProfileConfigDir(input.profileConfigDir)
      : undefined;
    return buildProbeEnvironments(privateConfigDir, profileConfigDir, input.customEnv);
  } catch {
    // Failing to provision the private target must skip probes, never fall
    // through to Claude's canonical profile.
    return { ok: false };
  }
}

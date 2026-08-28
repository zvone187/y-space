import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "@/shared/atomicFile";
import {
  capturePipedreamBootstrapEnvText,
  PIPEDREAM_ENV_FILE_MAX_BYTES,
  type PipedreamBootstrap,
} from "@/shared/pipedreamBootstrap";

const PIPEDREAM_ENV_FILE_SETTINGS_NAME = "pipedream-env-file.json";

// Version 1 is a path-only main-process boundary. Credential values belong in
// the selected file and are never copied into this metadata file.
const pipedreamEnvFileSettingsSchema = z
  .object({
    version: z.literal(1),
    envFilePath: z
      .string()
      .min(1)
      .max(4_096)
      .refine((value) => isAbsolute(value)),
  })
  .strict();

function settingsPath(baseDir: string): string {
  return join(baseDir, PIPEDREAM_ENV_FILE_SETTINGS_NAME);
}

export function readPipedreamEnvFilePath(baseDir: string): string | undefined {
  const path = settingsPath(baseDir);
  if (!existsSync(path)) return undefined;
  try {
    return pipedreamEnvFileSettingsSchema.parse(JSON.parse(readFileSync(path, "utf8"))).envFilePath;
  } catch {
    return undefined;
  }
}

export function writePipedreamEnvFilePath(baseDir: string, envFilePath: string): void {
  const settings = pipedreamEnvFileSettingsSchema.parse({ version: 1, envFilePath });
  writeFileAtomic(settingsPath(baseDir), `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function clearPipedreamEnvFilePath(baseDir: string): void {
  rmSync(settingsPath(baseDir), { force: true });
}

/**
 * Rehydrates a user-selected file only when no explicit file or process
 * environment configured this launch. The selected path stays main-only.
 */
export function applyPersistedPipedreamEnvFile(
  baseDir: string,
  startupBootstrap: PipedreamBootstrap,
): PipedreamBootstrap {
  if (startupBootstrap.state !== "absent") return startupBootstrap;
  const envFilePath = readPipedreamEnvFilePath(baseDir);
  if (!envFilePath) return startupBootstrap;
  try {
    const metadata = statSync(envFilePath);
    if (!metadata.isFile() || metadata.size > PIPEDREAM_ENV_FILE_MAX_BYTES) {
      return startupBootstrap;
    }
    const serialized = readFileSync(envFilePath, "utf8");
    if (Buffer.byteLength(serialized, "utf8") > PIPEDREAM_ENV_FILE_MAX_BYTES) {
      return startupBootstrap;
    }
    return capturePipedreamBootstrapEnvText(serialized);
  } catch {
    return startupBootstrap;
  }
}

import { readFileSync } from "node:fs";

export const PIPEDREAM_ENV_KEYS = [
  "PIPEDREAM_CLIENT_ID",
  "PIPEDREAM_CLIENT_SECRET",
  "PIPEDREAM_PROJECT_ID",
  "PIPEDREAM_ENVIRONMENT",
] as const;

export type PipedreamEnvKey = (typeof PIPEDREAM_ENV_KEYS)[number];
export type PipedreamEnvironment = "development" | "production";

export interface PipedreamBootstrapCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly projectId: string;
  readonly environment: PipedreamEnvironment;
}

export type PipedreamBootstrap =
  | { readonly state: "absent" }
  | { readonly state: "partial"; readonly missingKeys: readonly PipedreamEnvKey[] }
  | {
      readonly state: "ready";
      readonly source: "environment";
      readonly credentials: PipedreamBootstrapCredentials;
    };

/**
 * Takes a one-time copy of Pipedream's developer credentials and immediately
 * removes every related variable from the supplied environment. Call this
 * before spawning any agent process so developer credentials cannot be
 * inherited accidentally.
 *
 * A partial set is never returned as usable credentials. An unsupported
 * environment value is treated as a missing environment, which keeps startup
 * recoverable while preserving the all-or-nothing boundary.
 */
export function capturePipedreamBootstrapEnv(
  env: NodeJS.ProcessEnv = process.env,
): PipedreamBootstrap {
  const captured: Record<PipedreamEnvKey, string | undefined> = {
    PIPEDREAM_CLIENT_ID: env.PIPEDREAM_CLIENT_ID,
    PIPEDREAM_CLIENT_SECRET: env.PIPEDREAM_CLIENT_SECRET,
    PIPEDREAM_PROJECT_ID: env.PIPEDREAM_PROJECT_ID,
    PIPEDREAM_ENVIRONMENT: env.PIPEDREAM_ENVIRONMENT,
  };

  for (const key of PIPEDREAM_ENV_KEYS) delete env[key];

  const clientId = normalizeEnvValue(captured.PIPEDREAM_CLIENT_ID);
  const clientSecret = normalizeEnvValue(captured.PIPEDREAM_CLIENT_SECRET);
  const projectId = normalizeEnvValue(captured.PIPEDREAM_PROJECT_ID);
  const environment = normalizeEnvironment(captured.PIPEDREAM_ENVIRONMENT);

  const allValuesAbsent = PIPEDREAM_ENV_KEYS.every(
    (key) => normalizeEnvValue(captured[key]) === undefined,
  );
  if (allValuesAbsent) return { state: "absent" };

  const missingKeys: PipedreamEnvKey[] = [];
  if (!clientId) missingKeys.push("PIPEDREAM_CLIENT_ID");
  if (!clientSecret) missingKeys.push("PIPEDREAM_CLIENT_SECRET");
  if (!projectId) missingKeys.push("PIPEDREAM_PROJECT_ID");
  if (!environment) missingKeys.push("PIPEDREAM_ENVIRONMENT");
  if (!clientId || !clientSecret || !projectId || !environment) {
    return { state: "partial", missingKeys };
  }

  return {
    state: "ready",
    source: "environment",
    credentials: { clientId, clientSecret, projectId, environment },
  };
}

/**
 * Reads only the four supported keys from a dedicated local file and captures
 * them without ever installing them into `process.env`. Existing environment
 * values take precedence, then every Pipedream key is scrubbed from `env`.
 */
export function capturePipedreamBootstrapEnvFile(
  filePath: string,
  env: NodeJS.ProcessEnv = process.env,
): PipedreamBootstrap {
  let fileValues: Partial<Record<PipedreamEnvKey, string>> = {};
  try {
    fileValues = parsePipedreamEnvFile(readFileSync(filePath, "utf8"));
  } catch {
    // Missing / unreadable is equivalent to an absent file; environment values
    // still work and are scrubbed by the canonical capture path below.
  }
  const isolated: NodeJS.ProcessEnv = {};
  for (const key of PIPEDREAM_ENV_KEYS) isolated[key] = env[key] ?? fileValues[key];
  const captured = capturePipedreamBootstrapEnv(isolated);
  for (const key of PIPEDREAM_ENV_KEYS) delete env[key];
  return captured;
}

function parsePipedreamEnvFile(content: string): Partial<Record<PipedreamEnvKey, string>> {
  const result: Partial<Record<PipedreamEnvKey, string>> = {};
  const supported = new Set<string>(PIPEDREAM_ENV_KEYS);
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!supported.has(key)) continue;
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    result[key as PipedreamEnvKey] = value;
  }
  return result;
}

function normalizeEnvValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeEnvironment(value: string | undefined): PipedreamEnvironment | undefined {
  const normalized = normalizeEnvValue(value)?.toLowerCase();
  return normalized === "development" || normalized === "production" ? normalized : undefined;
}

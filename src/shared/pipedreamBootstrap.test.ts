import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PIPEDREAM_ENV_KEYS,
  capturePipedreamBootstrapEnv,
  capturePipedreamBootstrapEnvFile,
} from "./pipedreamBootstrap";

const COMPLETE_ENV = {
  PIPEDREAM_CLIENT_ID: "client-id-for-tests",
  PIPEDREAM_CLIENT_SECRET: "client-secret-for-tests",
  PIPEDREAM_PROJECT_ID: "proj_Test123",
  PIPEDREAM_ENVIRONMENT: "development",
} satisfies Record<(typeof PIPEDREAM_ENV_KEYS)[number], string>;

function expectPipedreamKeysScrubbed(env: NodeJS.ProcessEnv): void {
  for (const key of PIPEDREAM_ENV_KEYS) {
    expect(Object.prototype.hasOwnProperty.call(env, key)).toBe(false);
  }
}

describe("capturePipedreamBootstrapEnv", () => {
  it("captures a complete credential set and scrubs every source variable", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", ...COMPLETE_ENV };

    expect(capturePipedreamBootstrapEnv(env)).toEqual({
      state: "ready",
      source: "environment",
      credentials: {
        clientId: COMPLETE_ENV.PIPEDREAM_CLIENT_ID,
        clientSecret: COMPLETE_ENV.PIPEDREAM_CLIENT_SECRET,
        projectId: COMPLETE_ENV.PIPEDREAM_PROJECT_ID,
        environment: "development",
      },
    });

    expectPipedreamKeysScrubbed(env);
    expect(env.PATH).toBe("/usr/bin");
  });

  it("reports an absent configuration without inventing credentials", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    const result = capturePipedreamBootstrapEnv(env);

    expect(result).toEqual({ state: "absent" });
    expect("credentials" in result).toBe(false);
    expectPipedreamKeysScrubbed(env);
  });

  it("rejects a partial set atomically and still scrubs supplied values", () => {
    const env: NodeJS.ProcessEnv = {
      PIPEDREAM_CLIENT_ID: COMPLETE_ENV.PIPEDREAM_CLIENT_ID,
      PIPEDREAM_CLIENT_SECRET: "   ",
      PIPEDREAM_PROJECT_ID: COMPLETE_ENV.PIPEDREAM_PROJECT_ID,
    };

    const result = capturePipedreamBootstrapEnv(env);

    expect(result).toEqual({
      state: "partial",
      missingKeys: ["PIPEDREAM_CLIENT_SECRET", "PIPEDREAM_ENVIRONMENT"],
    });
    expect("credentials" in result).toBe(false);
    expectPipedreamKeysScrubbed(env);
  });

  it("loads the dedicated local env file without copying secrets into process env", () => {
    const root = mkdtempSync(join(tmpdir(), "y-space-pipedream-env-"));
    const filePath = join(root, ".env.pipedream");
    writeFileSync(
      filePath,
      [
        `PIPEDREAM_CLIENT_ID=${COMPLETE_ENV.PIPEDREAM_CLIENT_ID}`,
        `PIPEDREAM_CLIENT_SECRET='${COMPLETE_ENV.PIPEDREAM_CLIENT_SECRET}'`,
        `PIPEDREAM_PROJECT_ID=${COMPLETE_ENV.PIPEDREAM_PROJECT_ID}`,
        `PIPEDREAM_ENVIRONMENT=${COMPLETE_ENV.PIPEDREAM_ENVIRONMENT}`,
      ].join("\n"),
    );
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    try {
      expect(capturePipedreamBootstrapEnvFile(filePath, env)).toMatchObject({ state: "ready" });
      expectPipedreamKeysScrubbed(env);
      expect(JSON.stringify(env)).not.toContain(COMPLETE_ENV.PIPEDREAM_CLIENT_SECRET);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

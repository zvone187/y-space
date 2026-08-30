import { describe, expect, it } from "vitest";
import {
  PIPEDREAM_ENV_KEYS,
  capturePipedreamBootstrapEnv,
  scrubDeprecatedPipedreamExecEnvironment,
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

  it("never captures credentials directly from process.env", () => {
    const keys = [...PIPEDREAM_ENV_KEYS, "PIPEDREAM_ENV_FILE"] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    Object.assign(process.env, COMPLETE_ENV, { PIPEDREAM_ENV_FILE: "/private/setup.env" });
    try {
      expect(capturePipedreamBootstrapEnv(process.env)).toEqual({ state: "absent" });
      expectPipedreamKeysScrubbed(process.env);
      expect(process.env.PIPEDREAM_ENV_FILE).toBeUndefined();
    } finally {
      for (const key of keys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("detects deprecated exec inputs without returning their values", () => {
    const env: NodeJS.ProcessEnv = { ...COMPLETE_ENV, PIPEDREAM_ENV_FILE: "/setup.env" };
    expect(scrubDeprecatedPipedreamExecEnvironment(env)).toBe(true);
    expectPipedreamKeysScrubbed(env);
    expect(env.PIPEDREAM_ENV_FILE).toBeUndefined();
    expect(scrubDeprecatedPipedreamExecEnvironment(env)).toBe(false);
  });
});

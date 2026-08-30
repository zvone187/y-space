import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  posixPrivilegedEnvironmentUnsetPrefix,
  sanitizePrivilegedChildEnvironment,
} from "./privilegedChildEnvironment";

describe("privileged child environment scrub", () => {
  it("removes a reintroduced master key case-insensitively from direct child environments", () => {
    expect(
      sanitizePrivilegedChildEnvironment({
        SAFE_VALUE: "kept",
        poracode_secret_storage_key: "master-key",
      }),
    ).toEqual({ SAFE_VALUE: "kept" });
  });
});

describe.skipIf(process.platform === "win32")("privileged POSIX login-shell scrub", () => {
  it("removes mixed-case Pipedream and built-in MCP secrets reintroduced by a profile", () => {
    const output = execFileSync(
      "/bin/sh",
      ["-c", `${posixPrivilegedEnvironmentUnsetPrefix()}/usr/bin/env`],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          SAFE_VALUE: "kept",
          PiPeDrEaM_ClIeNt_SeCrEt: "developer-secret",
          poracode_browser_mcp_token: "browser-root",
          poracode_secret_storage_key: "master-key",
        },
      },
    );

    expect(output).toContain("SAFE_VALUE=kept");
    expect(output).not.toContain("developer-secret");
    expect(output).not.toContain("browser-root");
    expect(output).not.toContain("master-key");
  });
});

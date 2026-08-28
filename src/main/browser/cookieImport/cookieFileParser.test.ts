import { describe, expect, it } from "vitest";
import { parseCookieImportFile } from "./cookieFileParser";

describe("parseCookieImportFile", () => {
  it("parses Cookie-Editor JSON without exposing values in preview metadata", () => {
    const secret = "json-cookie-secret";
    const parsed = parseCookieImportFile(
      JSON.stringify([
        {
          name: "session",
          value: secret,
          domain: ".example.com",
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "lax",
          session: true,
        },
      ]),
      "cookies.json",
    );

    expect(parsed.format).toBe("cookie-editor-json");
    expect(parsed.cookies).toHaveLength(1);
    expect(parsed.cookies[0]?.value).toBe(secret);
    expect(JSON.stringify(parsed.domains)).not.toContain(secret);
  });

  it("parses Netscape HttpOnly and session cookie fields", () => {
    const parsed = parseCookieImportFile(
      [
        "# Netscape HTTP Cookie File",
        "#HttpOnly_.example.com\tTRUE\t/\tTRUE\t0\tsession\tnetscape-secret",
      ].join("\n"),
      "cookies.txt",
    );

    expect(parsed.format).toBe("netscape");
    expect(parsed.cookies[0]).toMatchObject({
      name: "session",
      value: "netscape-secret",
      domain: ".example.com",
      hostOnly: false,
      httpOnly: true,
      secure: true,
      session: true,
    });
  });

  it("bounds entry counts and records malformed rows without retaining them", () => {
    const rows = ["# Netscape HTTP Cookie File", "invalid"];
    for (let index = 0; index < 751; index += 1) {
      rows.push(`example.com\tFALSE\t/\tFALSE\t0\tc${index}\tv${index}`);
    }
    expect(() => parseCookieImportFile(rows.join("\n"), "cookies.txt")).toThrow(/750|many/i);

    const malformed = parseCookieImportFile(
      "# Netscape HTTP Cookie File\nnot-a-cookie-row",
      "cookies.txt",
    );
    expect(malformed.invalidCount).toBe(1);
    expect(malformed.cookies).toEqual([]);
  });
});

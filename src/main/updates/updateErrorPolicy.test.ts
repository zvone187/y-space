import { describe, expect, it } from "vitest";
import { classifyUpdateFailure } from "./updateErrorPolicy";

describe("classifyUpdateFailure", () => {
  it("quietly accepts only the exact unpublished GitHub feed message during checks", () => {
    expect(
      classifyUpdateFailure(new Error("  No   published versions on GitHub  "), "check", "stable"),
    ).toEqual({ kind: "optional-manifest-missing", retryable: false });
    expect(
      classifyUpdateFailure(new Error("No published versions on GitHub"), "download", "stable"),
    ).toEqual({ kind: "unexpected", retryable: false });
  });

  it("keeps composite integrity failures observable", () => {
    expect(
      classifyUpdateFailure(
        new Error("No published versions on GitHub: checksum mismatch"),
        "check",
        "stable",
      ),
    ).toEqual({ kind: "artifact-integrity", retryable: false });
  });

  it("gives filesystem error codes precedence over the unpublished-feed message", () => {
    const failure = Object.assign(new Error("No published versions on GitHub"), {
      code: "ENOSPC",
    });

    expect(classifyUpdateFailure(failure, "check", "stable")).toEqual({
      kind: "disk",
      retryable: false,
    });
  });
});

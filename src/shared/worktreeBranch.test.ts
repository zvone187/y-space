import { describe, expect, it } from "vitest";
import { generateWorktreeBranch } from "./worktreeBranch";

describe("generateWorktreeBranch", () => {
  it("uses the Y Space branch namespace", () => {
    expect(generateWorktreeBranch()).toMatch(/^y-space\/[a-z]+-[a-z]+-[0-9a-f]{8}$/u);
  });
});

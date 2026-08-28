import { describe, expect, it } from "vitest";
import { resolveAbsolutePath } from "./resolveAbsolutePath";

describe("resolveAbsolutePath", () => {
  it("preserves POSIX and WSL traversal for filesystem resolution", () => {
    expect(
      resolveAbsolutePath({ kind: "posix", path: "/repo/worktree" }, "../shared/report.pdf"),
    ).toBe("/repo/worktree/../shared/report.pdf");
    expect(
      resolveAbsolutePath(
        {
          kind: "wsl",
          distro: "Ubuntu",
          linuxPath: "/home/me/repo/worktree",
          uncPath: "\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\worktree",
        },
        "../shared/report.xlsx",
      ),
    ).toBe("/home/me/repo/worktree/../shared/report.xlsx");
  });

  it("normalizes Windows separators while preserving traversal for filesystem resolution", () => {
    expect(
      resolveAbsolutePath({ kind: "windows", path: "C:\\repo\\worktree" }, "..\\shared/a.xls"),
    ).toBe("C:\\repo\\worktree\\..\\shared\\a.xls");
  });
});

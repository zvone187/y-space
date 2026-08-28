import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectLocation } from "@/shared/contracts";
import {
  PROJECT_FILE_PREVIEW_HARD_MAX_BYTES,
  ProjectFilePreviewError,
  readProjectFilePreview,
} from "./readProjectFilePreview";

describe("readProjectFilePreview", () => {
  let projectRoot: string;
  let location: ProjectLocation;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "y-space-project-preview-"));
    location =
      process.platform === "win32"
        ? { kind: "windows", path: projectRoot }
        : { kind: "posix", path: projectRoot };
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("returns structured-cloneable bytes and bounded file metadata", async () => {
    const expected = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
    writeFileSync(join(projectRoot, "document.pdf"), expected);

    const result = await readProjectFilePreview({
      projectLocation: location,
      path: "document.pdf",
      maxBytes: 64,
    });

    expect(result.path).toBe("document.pdf");
    expect(result.bytes).toBeInstanceOf(Uint8Array);
    expect(result.bytes).toEqual(expected);
    expect(result.sizeBytes).toBe(expected.byteLength);
    expect(Number.isFinite(result.modifiedAtMs)).toBe(true);
  });

  it("rejects traversal and absolute paths with finite sanitized errors", async () => {
    expect.hasAssertions();
    const outsideName = `outside-secret-${Date.now()}.pdf`;
    const cases = ["../secret.pdf", `nested/../../${outsideName}`, "/etc/passwd", "C:\\secret.pdf"];

    for (const path of cases) {
      await expectPreviewError(
        readProjectFilePreview({ projectLocation: location, path, maxBytes: 64 }),
        "invalid_path",
        projectRoot,
        outsideName,
      );
    }
  });

  it("rejects unrelated project files at the privileged byte boundary", async () => {
    expect.hasAssertions();
    writeFileSync(join(projectRoot, "private.env"), "SECRET=do-not-export");

    await expectPreviewError(
      readProjectFilePreview({
        projectLocation: location,
        path: "private.env",
        maxBytes: 64,
      }),
      "unsupported",
      projectRoot,
      "private.env",
      "do-not-export",
    );
  });

  it("rejects symlinks that resolve outside the supplied project root", async () => {
    if (process.platform === "win32") return;
    expect.hasAssertions();
    const externalRoot = mkdtempSync(join(tmpdir(), "y-space-preview-secret-"));
    const secretPath = join(externalRoot, "secret.pdf");
    writeFileSync(secretPath, "secret bytes");
    symlinkSync(secretPath, join(projectRoot, "linked.pdf"));

    try {
      await expectPreviewError(
        readProjectFilePreview({
          projectLocation: location,
          path: "linked.pdf",
          maxBytes: 64,
        }),
        "outside_root",
        projectRoot,
        externalRoot,
        secretPath,
      );
    } finally {
      rmSync(externalRoot, { recursive: true, force: true });
    }
  });

  it("rejects directories, missing files, and unavailable roots without leaking paths", async () => {
    expect.hasAssertions();
    mkdirSync(join(projectRoot, "folder.pdf"));

    await expectPreviewError(
      readProjectFilePreview({ projectLocation: location, path: "folder.pdf", maxBytes: 64 }),
      "not_file",
      projectRoot,
    );
    await expectPreviewError(
      readProjectFilePreview({ projectLocation: location, path: "missing.pdf", maxBytes: 64 }),
      "missing",
      projectRoot,
    );

    const unavailableRoot = join(projectRoot, "not-present-root");
    const unavailableLocation: ProjectLocation =
      process.platform === "win32"
        ? { kind: "windows", path: unavailableRoot }
        : { kind: "posix", path: unavailableRoot };
    await expectPreviewError(
      readProjectFilePreview({
        projectLocation: unavailableLocation,
        path: "document.pdf",
        maxBytes: 64,
      }),
      "unsupported",
      projectRoot,
      unavailableRoot,
    );
  });

  it("enforces both the requested limit and the immutable server ceiling", async () => {
    expect.hasAssertions();
    writeFileSync(join(projectRoot, "large.xlsx"), Buffer.alloc(65, 0x41));

    await expectPreviewError(
      readProjectFilePreview({
        projectLocation: location,
        path: "large.xlsx",
        maxBytes: 64,
      }),
      "too_large",
      projectRoot,
    );
    await expectPreviewError(
      readProjectFilePreview({
        projectLocation: location,
        path: "large.xlsx",
        maxBytes: PROJECT_FILE_PREVIEW_HARD_MAX_BYTES + 1,
      }),
      "invalid_limit",
      projectRoot,
    );
  });

  it("fails closed for projected remote and unavailable WSL roots", async () => {
    expect.hasAssertions();
    const remoteLocation = { ...location, remoteServerId: "remote-desktop" } as ProjectLocation;
    await expectPreviewError(
      readProjectFilePreview({
        projectLocation: remoteLocation,
        path: "document.pdf",
        maxBytes: 64,
      }),
      "unsupported",
      projectRoot,
      "remote-desktop",
    );

    await expectPreviewError(
      readProjectFilePreview({
        projectLocation: {
          kind: "wsl",
          distro: "Ubuntu",
          linuxPath: "/home/demo/project",
          uncPath: "\\\\wsl.localhost\\Ubuntu\\home\\demo\\project",
        },
        path: "document.pdf",
        maxBytes: 64,
      }),
      "unsupported",
      "Ubuntu",
      "/home/demo/project",
    );
  });
});

async function expectPreviewError(
  promise: Promise<unknown>,
  code: ProjectFilePreviewError["code"],
  ...privateFragments: string[]
): Promise<void> {
  const error = await promise.catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(ProjectFilePreviewError);
  expect(error).toMatchObject({ code });
  expect((error as Error).message.length).toBeLessThan(160);
  for (const fragment of privateFragments) {
    expect((error as Error).message).not.toContain(fragment);
  }
}

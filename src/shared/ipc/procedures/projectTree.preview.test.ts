import { describe, expect, it } from "vitest";
import {
  PROJECT_FILE_PREVIEW_DEFAULT_MAX_BYTES,
  PROJECT_FILE_PREVIEW_HARD_MAX_BYTES,
  readProjectFilePreviewPayloadSchema,
} from "@/shared/contracts";
import { projectTreeProcedures } from "./projectTree";

describe("project file preview IPC contract", () => {
  const location = { kind: "posix" as const, path: "/project" };

  it("is a narrow main-local bridge procedure with a bounded server default", () => {
    expect(projectTreeProcedures.readProjectFilePreview.transport).toBe("main-local");
    expect(PROJECT_FILE_PREVIEW_DEFAULT_MAX_BYTES).toBeLessThan(
      PROJECT_FILE_PREVIEW_HARD_MAX_BYTES,
    );
    expect(
      projectTreeProcedures.readProjectFilePreview.parseArgs({
        projectLocation: location,
        path: "report.pdf",
      }),
    ).toEqual({
      projectLocation: location,
      path: "report.pdf",
    });
  });

  it("rejects caller limits above the hard ceiling before dispatch", () => {
    expect(() =>
      readProjectFilePreviewPayloadSchema.parse({
        projectLocation: location,
        path: "report.xlsx",
        maxBytes: PROJECT_FILE_PREVIEW_HARD_MAX_BYTES + 1,
      }),
    ).toThrow(/16777216/u);
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  createProcessRuntimeShutdown,
  type ProcessRuntimeShutdownPhase,
} from "./processRuntimeShutdown";

describe("createProcessRuntimeShutdown", () => {
  it("runs supervisor, job-object, and database cleanup once in order", () => {
    const order: string[] = [];
    const reportError = vi.fn<(error: unknown, phase: ProcessRuntimeShutdownPhase) => void>();
    const shutdown = createProcessRuntimeShutdown({
      disposeSupervisor: () => order.push("supervisor"),
      disposeJobObject: () => order.push("job-object"),
      closeDatabase: () => order.push("database"),
      reportError,
    });

    shutdown();
    shutdown();

    expect(order).toEqual(["supervisor", "job-object", "database"]);
  });

  it("continues every cleanup phase when earlier phases and reporting throw", () => {
    const order: string[] = [];
    const reportError = vi.fn<(error: unknown, phase: ProcessRuntimeShutdownPhase) => void>(() => {
      throw new Error("reporting failed");
    });
    const shutdown = createProcessRuntimeShutdown({
      disposeSupervisor: () => {
        order.push("supervisor");
        throw new Error("supervisor failed");
      },
      disposeJobObject: () => {
        order.push("job-object");
        throw new Error("job object failed");
      },
      closeDatabase: () => {
        order.push("database");
        throw new Error("database failed");
      },
      reportError,
    });

    expect(() => shutdown()).not.toThrow();

    expect(order).toEqual(["supervisor", "job-object", "database"]);
    expect(reportError.mock.calls.map(([, phase]) => phase)).toEqual([
      "supervisor",
      "job-object",
      "database",
    ]);
  });
});

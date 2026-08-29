import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ipcProcedureMap,
  RENDERER_IPC_PROCEDURE_NAMES,
  SUPERVISOR_INTERNAL_PROCEDURE_NAMES,
} from "@/shared/ipc";

const ipcMainHandle = vi.hoisted(() =>
  vi.fn<(channel: string, handler: (...args: unknown[]) => unknown) => void>(),
);

vi.mock("electron", () => ({ ipcMain: { handle: ipcMainHandle } }));

import { registerIpcHandlers } from "./registerHandlers";

describe("registerIpcHandlers", () => {
  beforeEach(() => {
    ipcMainHandle.mockClear();
  });

  it("never registers private supervisor procedures on renderer IPC", () => {
    registerIpcHandlers({
      localHandlers: {} as never,
      callSupervisor: vi.fn<() => Promise<void>>(async () => undefined) as never,
    });

    const registeredChannels = new Set(ipcMainHandle.mock.calls.map(([channel]) => channel));
    expect(ipcMainHandle).toHaveBeenCalledTimes(RENDERER_IPC_PROCEDURE_NAMES.length);
    for (const name of SUPERVISOR_INTERNAL_PROCEDURE_NAMES) {
      expect(registeredChannels.has(ipcProcedureMap[name].channel)).toBe(false);
    }
  });
});

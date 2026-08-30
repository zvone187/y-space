import { ipcMain } from "electron";
import {
  ipcProcedureMap,
  parseIpcProcedureArgs,
  RENDERER_IPC_PROCEDURE_NAMES,
  type IpcProcedurePayload,
  type IpcProcedureResult,
  type MainLocalIpcHandlerMap,
  type SupervisorProcedureName,
} from "@/shared/ipc";

interface RegisterIpcHandlersOptions {
  localHandlers: MainLocalIpcHandlerMap;
  callSupervisor<Name extends SupervisorProcedureName>(
    name: Name,
    payload: IpcProcedurePayload<Name>,
  ): Promise<IpcProcedureResult<Name>>;
}

export function registerIpcHandlers(options: RegisterIpcHandlersOptions): void {
  for (const name of RENDERER_IPC_PROCEDURE_NAMES) {
    const procedure = ipcProcedureMap[name];
    ipcMain.handle(procedure.channel, async (event, ...args: unknown[]) => {
      const payload = parseIpcProcedureArgs(name, args);
      if (procedure.transport === "main-local") {
        const handler = options.localHandlers[name as keyof MainLocalIpcHandlerMap] as (
          payload: unknown,
          context: {
            senderWebContentsId: number;
            senderFrame: { processId: number; routingId: number } | null;
          },
        ) => unknown;
        return handler(payload, {
          senderWebContentsId: event.sender.id,
          // Keep only Chromium's stable frame identity. Electron may surface a
          // different WebFrameMain wrapper for the same underlying frame.
          senderFrame: event.senderFrame
            ? {
                processId: event.senderFrame.processId,
                routingId: event.senderFrame.routingId,
              }
            : null,
        });
      }
      return options.callSupervisor(name as SupervisorProcedureName, payload as never);
    });
  }
}

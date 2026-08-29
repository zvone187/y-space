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
    ipcMain.handle(procedure.channel, async (_event, ...args: unknown[]) => {
      const payload = parseIpcProcedureArgs(name, args);
      if (procedure.transport === "main-local") {
        const handler = options.localHandlers[name as keyof MainLocalIpcHandlerMap] as (
          payload: unknown,
        ) => unknown;
        return handler(payload);
      }
      return options.callSupervisor(name as SupervisorProcedureName, payload as never);
    });
  }
}

import { BUILT_IN_MCP_SERVER_NAMES } from "@/shared/contracts";

/** Single source for the app-controls MCP server identity (advertised + reported). */
export const APP_CONTROLS_MCP_SERVER_INFO = {
  name: BUILT_IN_MCP_SERVER_NAMES["app-controls"],
  version: "1.0.0",
} as const;

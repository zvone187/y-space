import type {
  PipedreamBeginConnectPayload,
  PipedreamBeginConnectResult,
  PipedreamChooseEnvFilePayload,
  PipedreamConnectFlowPayload,
  PipedreamConnectFlowStatus,
  PipedreamDisconnectAccountPayload,
  PipedreamEnvFileImportResult,
  PipedreamListAppsPayload,
  PipedreamListAppsResult,
  PipedreamPersonalMcpOauthBeginResult,
  PipedreamPersonalMcpOauthFlowPayload,
  PipedreamPersonalMcpOauthFlowStatus,
  PipedreamSetAccountAgentAccessPayload,
  PipedreamSnapshot,
  McpOauthBeginResult,
  McpOauthWaitResult,
} from "../../contracts";
import {
  pipedreamBeginConnectPayloadSchema,
  pipedreamChooseEnvFilePayloadSchema,
  pipedreamConnectFlowPayloadSchema,
  pipedreamDisconnectAccountPayloadSchema,
  pipedreamListAppsPayloadSchema,
  pipedreamPersonalMcpOauthFlowPayloadSchema,
  pipedreamSetAccountAgentAccessPayloadSchema,
} from "../../contracts";
import { defineNoArgProcedure, definePayloadProcedure } from "../core";

export const pipedreamProcedures = {
  pipedreamGetSnapshot: defineNoArgProcedure<PipedreamSnapshot, "supervisor">(
    "pipedreamGetSnapshot",
    "supervisor",
  ),
  pipedreamListApps: definePayloadProcedure<
    PipedreamListAppsPayload,
    PipedreamListAppsResult,
    "supervisor"
  >("pipedreamListApps", "supervisor", pipedreamListAppsPayloadSchema),
  pipedreamRefreshAccounts: defineNoArgProcedure<PipedreamSnapshot, "supervisor">(
    "pipedreamRefreshAccounts",
    "supervisor",
  ),
  pipedreamBeginConnect: definePayloadProcedure<
    PipedreamBeginConnectPayload,
    PipedreamBeginConnectResult,
    "main-local"
  >("pipedreamBeginConnect", "main-local", pipedreamBeginConnectPayloadSchema),
  pipedreamBeginPersonalMcpOauth: defineNoArgProcedure<
    PipedreamPersonalMcpOauthBeginResult,
    "main-local"
  >("pipedreamBeginPersonalMcpOauth", "main-local"),
  pipedreamGetPersonalMcpOauthFlowStatus: definePayloadProcedure<
    PipedreamPersonalMcpOauthFlowPayload,
    PipedreamPersonalMcpOauthFlowStatus,
    "main-local"
  >(
    "pipedreamGetPersonalMcpOauthFlowStatus",
    "main-local",
    pipedreamPersonalMcpOauthFlowPayloadSchema,
  ),
  pipedreamCancelPersonalMcpOauth: definePayloadProcedure<
    PipedreamPersonalMcpOauthFlowPayload,
    void,
    "main-local"
  >("pipedreamCancelPersonalMcpOauth", "main-local", pipedreamPersonalMcpOauthFlowPayloadSchema),
  pipedreamClearPersonalMcpOauth: defineNoArgProcedure<void, "main-local">(
    "pipedreamClearPersonalMcpOauth",
    "main-local",
  ),
  pipedreamGetConnectFlowStatus: definePayloadProcedure<
    PipedreamConnectFlowPayload,
    PipedreamConnectFlowStatus,
    "main-local"
  >("pipedreamGetConnectFlowStatus", "main-local", pipedreamConnectFlowPayloadSchema),
  pipedreamFinishConnect: definePayloadProcedure<PipedreamConnectFlowPayload, void, "main-local">(
    "pipedreamFinishConnect",
    "main-local",
    pipedreamConnectFlowPayloadSchema,
  ),
  pipedreamCancelConnect: definePayloadProcedure<PipedreamConnectFlowPayload, void, "main-local">(
    "pipedreamCancelConnect",
    "main-local",
    pipedreamConnectFlowPayloadSchema,
  ),
  pipedreamChooseEnvFile: definePayloadProcedure<
    PipedreamChooseEnvFilePayload,
    PipedreamEnvFileImportResult | null,
    "main-local"
  >("pipedreamChooseEnvFile", "main-local", pipedreamChooseEnvFilePayloadSchema),
  pipedreamClearEnvFile: defineNoArgProcedure<PipedreamSnapshot, "main-local">(
    "pipedreamClearEnvFile",
    "main-local",
  ),
  pipedreamDisconnectAccount: definePayloadProcedure<
    PipedreamDisconnectAccountPayload,
    PipedreamSnapshot,
    "supervisor"
  >("pipedreamDisconnectAccount", "supervisor", pipedreamDisconnectAccountPayloadSchema),
  pipedreamSetAccountAgentAccess: definePayloadProcedure<
    PipedreamSetAccountAgentAccessPayload,
    PipedreamSnapshot,
    "supervisor"
  >("pipedreamSetAccountAgentAccess", "supervisor", pipedreamSetAccountAgentAccessPayloadSchema),
  /** Trusted main ↔ supervisor only. The redirect result intentionally contains the raw URL. */
  pipedreamInternalBeginPersonalMcpOauth: defineNoArgProcedure<McpOauthBeginResult, "supervisor">(
    "pipedreamInternalBeginPersonalMcpOauth",
    "supervisor",
  ),
  pipedreamInternalWaitPersonalMcpOauth: definePayloadProcedure<
    PipedreamPersonalMcpOauthFlowPayload,
    McpOauthWaitResult,
    "supervisor"
  >(
    "pipedreamInternalWaitPersonalMcpOauth",
    "supervisor",
    pipedreamPersonalMcpOauthFlowPayloadSchema,
  ),
  pipedreamInternalCancelPersonalMcpOauth: definePayloadProcedure<
    PipedreamPersonalMcpOauthFlowPayload,
    void,
    "supervisor"
  >(
    "pipedreamInternalCancelPersonalMcpOauth",
    "supervisor",
    pipedreamPersonalMcpOauthFlowPayloadSchema,
  ),
  pipedreamInternalClearPersonalMcpOauth: defineNoArgProcedure<void, "supervisor">(
    "pipedreamInternalClearPersonalMcpOauth",
    "supervisor",
  ),
} as const;

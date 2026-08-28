import type {
  PipedreamBeginConnectPayload,
  PipedreamBeginConnectResult,
  PipedreamChooseEnvFilePayload,
  PipedreamDisconnectAccountPayload,
  PipedreamEnvFileImportResult,
  PipedreamListAppsPayload,
  PipedreamListAppsResult,
  PipedreamSetAccountAgentAccessPayload,
  PipedreamSnapshot,
} from "../../contracts";
import {
  pipedreamBeginConnectPayloadSchema,
  pipedreamChooseEnvFilePayloadSchema,
  pipedreamDisconnectAccountPayloadSchema,
  pipedreamListAppsPayloadSchema,
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
} as const;

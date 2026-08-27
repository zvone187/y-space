import type {
  PipedreamBeginConnectPayload,
  PipedreamBeginConnectResult,
  PipedreamDisconnectAccountPayload,
  PipedreamListAppsPayload,
  PipedreamListAppsResult,
  PipedreamSetAccountAgentAccessPayload,
  PipedreamSnapshot,
} from "../../contracts";
import {
  pipedreamBeginConnectPayloadSchema,
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

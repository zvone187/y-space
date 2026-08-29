import { codexContextWindowOverrides } from "@/shared/agents/codexContextWindows";
import type { ProjectLocation, ResolvedMcpServer, ThreadConfig } from "@/shared/contracts";
import { getProjectPosixPath } from "@/shared/wsl";
import { buildCodexMcp } from "../userMcp";
import { buildCodexBrowserExclusiveConfig } from "./browserPolicy";
import { buildCodexBrowserConflictConfig } from "./mcpSkillConflicts";
import type { CodexClientRequestMap } from "./protocol";

type ThreadForkParams = CodexClientRequestMap["thread/fork"]["params"];
type ThreadConfigOverrides = Pick<
  ThreadForkParams,
  "model" | "cwd" | "approvalPolicy" | "approvalsReviewer" | "sandbox" | "config"
>;

export function buildCodexThreadOverrides(
  config: ThreadConfig,
  options?: {
    projectLocation?: ProjectLocation;
    mcpServers?: readonly ResolvedMcpServer[];
  },
): ThreadConfigOverrides {
  const mcpServers = options?.mcpServers ?? [];
  const mcpConfig = options?.mcpServers ? buildCodexMcp(options.mcpServers).config : {};
  const browserPolicyConfig = buildCodexBrowserExclusiveConfig(mcpServers);
  const browserConflictConfig = options?.projectLocation
    ? buildCodexBrowserConflictConfig(options.projectLocation, mcpServers)
    : {};
  return {
    model: config.model,
    ...(options?.projectLocation ? { cwd: getProjectPosixPath(options.projectLocation) } : {}),
    ...(config.approvalPolicy
      ? {
          approvalPolicy: config.approvalPolicy as NonNullable<ThreadForkParams["approvalPolicy"]>,
        }
      : {}),
    ...(config.approvalsReviewer
      ? {
          approvalsReviewer: config.approvalsReviewer as NonNullable<
            ThreadForkParams["approvalsReviewer"]
          >,
        }
      : {}),
    ...(config.sandboxMode
      ? { sandbox: config.sandboxMode as NonNullable<ThreadForkParams["sandbox"]> }
      : {}),
    config: {
      ...(config.effort ? { model_reasoning_effort: config.effort } : {}),
      model_reasoning_summary: "auto",
      ...codexContextWindowOverrides(config.contextSize),
      ...browserPolicyConfig,
      ...browserConflictConfig,
      ...mcpConfig,
    },
  };
}

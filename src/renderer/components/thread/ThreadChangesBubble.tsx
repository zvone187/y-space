import { useShallow } from "zustand/shallow";
import { Tooltip } from "@heroui/react";
import { FileDiff, GitFork, GitPullRequest } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { getBasename } from "@/shared/pathUtils";
import { closeGitPanel, showGitReviewPanel } from "@/renderer/actions/panelActions";
import {
  floatingGlassActiveClass,
  floatingGlassSurfaceClass,
} from "@/renderer/components/layout/floatingGlass";
import { useGitStore } from "@/renderer/state/gitStore";
import { resolvePrKey } from "@/renderer/state/gitSelectors";
import { usePanelStore } from "@/renderer/state/panelStore";
import { useRightWorkspaceTabsStore } from "@/renderer/state/rightWorkspaceTabsStore";
import { rightWorkspaceToolTabId } from "@/renderer/state/rightWorkspaceTabs";
import {
  aggregatePrChecksStatus,
  combineChecksStatus,
  getPrStatusTone,
  PR_TONE_TEXT_CLASS,
} from "@/renderer/utils/prStatus";

/**
 * Translucent Git/worktree identity that floats over the top-right corner of
 * the composer. Worktrees remain visible when clean as an icon-only control;
 * root project scopes render only when they have changes. Clicking toggles the
 * docked Git review panel for the same scope.
 */
export function ThreadChangesBubble(props: {
  projectId: string;
  worktreePath?: string | undefined;
  worktreeName?: string | undefined;
}) {
  const { t } = useLingui();
  const {
    hasChanges,
    prNumber,
    prState,
    checksStatus,
    reviewDecision,
    mergeable,
    mergeStateStatus,
  } = useGitStore(
    useShallow((s) => {
      const status = props.worktreePath
        ? s.worktreeStatuses[props.worktreePath]
        : s.statuses[props.projectId];
      const pr = s.prData[resolvePrKey(props.projectId, props.worktreePath)];
      const details = pr?.number ? s.prDetails[`${props.projectId}#${pr.number}`] : undefined;
      return {
        hasChanges: (status?.totalInsertions ?? 0) > 0 || (status?.totalDeletions ?? 0) > 0,
        prNumber: pr?.number,
        prState: pr?.state,
        reviewDecision: pr?.reviewDecision,
        mergeable: pr?.mergeable,
        mergeStateStatus: pr?.mergeStateStatus,
        checksStatus: combineChecksStatus(
          aggregatePrChecksStatus(details?.checks),
          pr?.checksStatus,
        ),
      };
    }),
  );
  // Active only when the docked Git panel is showing *this* thread's scope.
  const isScoped = usePanelStore(
    (s) =>
      s.gitReviewAsPanel &&
      s.gitReviewContext?.projectId === props.projectId &&
      s.gitReviewContext?.worktreePath === props.worktreePath,
  );
  const gitWorkspaceActive = useRightWorkspaceTabsStore(
    (state) => state.activeTabId === rightWorkspaceToolTabId("git"),
  );
  const isOpen = isScoped && gitWorkspaceActive;

  const hasVisiblePr =
    prNumber !== undefined &&
    prState !== "closed" &&
    (prState !== "merged" || props.worktreePath !== undefined);
  const worktreeName =
    props.worktreeName ?? (props.worktreePath ? getBasename(props.worktreePath) : undefined);

  if (!hasChanges && !props.worktreePath && !hasVisiblePr) return null;

  const bubble = (
    <button
      type="button"
      {...(!worktreeName ? { title: isOpen ? t`Close changes` : t`Review changes` } : {})}
      aria-label={isOpen ? t`Close changes` : t`Review changes`}
      aria-pressed={isOpen}
      /* Sized to the same 28px icon-only circle as the nearby floating actions. */
      className={`${floatingGlassSurfaceClass} flex h-7 w-7 items-center justify-center rounded-full px-0 text-xs font-medium transition-colors ${
        isOpen ? floatingGlassActiveClass : "hover:border-border/30"
      }`}
      onClick={() => {
        if (isOpen) {
          closeGitPanel();
          return;
        }
        showGitReviewPanel(props.projectId, props.worktreePath);
      }}
    >
      {hasVisiblePr ? (
        <GitPullRequest
          className={`size-3.5 shrink-0 ${PR_TONE_TEXT_CLASS[getPrStatusTone(prState, checksStatus, { reviewDecision, mergeable, mergeStateStatus })]}`}
        />
      ) : props.worktreePath ? (
        <GitFork className="size-3.5 shrink-0 text-muted" />
      ) : (
        <FileDiff className="size-3.5 shrink-0 text-muted" />
      )}
    </button>
  );

  return (
    // Position an out-of-flow wrapper, not the tooltip trigger. HeroUI's trigger
    // then measures the real button without adding a line box above the composer.
    <div className="absolute right-3 bottom-full z-10 mb-1.5">
      {worktreeName ? (
        <Tooltip delay={0}>
          <Tooltip.Trigger>{bubble}</Tooltip.Trigger>
          <Tooltip.Content placement="top">
            {hasVisiblePr ? t`Review PR #${prNumber} for ${worktreeName}` : worktreeName}
          </Tooltip.Content>
        </Tooltip>
      ) : (
        bubble
      )}
    </div>
  );
}

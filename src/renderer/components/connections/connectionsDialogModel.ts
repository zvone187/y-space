import type { PipedreamAppSummary, PipedreamListAppsResult } from "@/shared/contracts";

export const CATALOG_PAGE_SIZE = 50;
export const CONNECT_POLL_INTERVAL_MS = 2_000;
export const CONNECT_MAX_DURATION_MS = 5 * 60_000;

export interface ConnectAttempt {
  app: PipedreamAppSummary;
  deadline: number;
  flowId: string;
  source: "composer" | "settings";
  startedAt: number;
  status: "waiting" | "timed-out" | "cancelled" | "failed";
}

export interface CatalogState extends PipedreamListAppsResult {
  error: boolean;
  loading: boolean;
}

export const EMPTY_CATALOG: CatalogState = {
  apps: [],
  totalCount: 0,
  error: false,
  loading: false,
};

export function mergeApps(
  current: readonly PipedreamAppSummary[],
  incoming: readonly PipedreamAppSummary[],
): PipedreamAppSummary[] {
  const byId = new Map(current.map((app) => [app.id, app]));
  for (const app of incoming) {
    if (!byId.has(app.id)) byId.set(app.id, app);
  }
  return [...byId.values()];
}

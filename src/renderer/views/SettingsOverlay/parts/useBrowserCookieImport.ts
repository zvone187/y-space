import { useCallback, useEffect, useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { readBridge } from "@/renderer/bridge";
import { useBrowserPanelStore } from "@/renderer/state/browserPanelStore";
import type {
  BrowserCookieImportCompletion,
  BrowserCookieImportPairingChallenge,
  BrowserCookieImportState,
} from "@/shared/ipc/procedures/browserCookieImport";

const MAX_TARGET_ORIGINS = 12;
const BACKGROUND_REFRESH_MS = 2_000;

type ActiveRequest = NonNullable<BrowserCookieImportState["activeRequest"]>;

export type CookieImportOperation =
  | "loading"
  | "opening-extension"
  | "choosing-file"
  | "pairing"
  | "cancelling-pairing"
  | "forgetting-source"
  | "previewing"
  | "committing"
  | "cancelling-import"
  | null;

export interface BrowserCookieImportModel {
  readonly state: BrowserCookieImportState;
  readonly pairing: BrowserCookieImportPairingChallenge | null;
  readonly pairingRemainingMs: number;
  readonly selectedSourceId: string;
  readonly selectedLocalSourceId: string;
  readonly targetInput: string;
  readonly selectedDomains: ReadonlySet<string>;
  readonly completion: BrowserCookieImportCompletion | null;
  readonly operation: CookieImportOperation;
  readonly error: string | null;
  readonly activeOrigin: string | null;
  openExtensionFolder(): Promise<void>;
  chooseFile(): Promise<void>;
  setSelectedSourceId(sourceId: string): void;
  setSelectedLocalSourceId(sourceId: string): void;
  setTargetInput(value: string): void;
  useActiveOrigin(): void;
  toggleDomain(domain: string): void;
  beginPairing(): Promise<void>;
  cancelPairing(): Promise<void>;
  forgetSource(sourceId: string): Promise<void>;
  preview(): Promise<void>;
  previewLocal(): Promise<void>;
  commit(): Promise<void>;
  cancelImport(): Promise<void>;
}

interface ParsedOrigins {
  readonly targetUrls: string[];
  readonly error: "missing" | "too-many" | "invalid" | null;
}

export function safeHttpOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function parseTargetOrigins(input: string): ParsedOrigins {
  const candidates = input
    .split(/[\n,]+/u)
    .map((candidate) => candidate.trim())
    .filter(Boolean);

  if (candidates.length === 0) {
    return { targetUrls: [], error: "missing" };
  }
  if (candidates.length > MAX_TARGET_ORIGINS) {
    return { targetUrls: [], error: "too-many" };
  }

  const origins = new Set<string>();
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      const hasPrivateUrlParts =
        Boolean(url.username || url.password || url.search || url.hash) ||
        (url.pathname !== "" && url.pathname !== "/");
      if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        hasPrivateUrlParts ||
        url.origin === "null"
      ) {
        return {
          targetUrls: [],
          error: "invalid",
        };
      }
      origins.add(url.origin);
    } catch {
      return {
        targetUrls: [],
        error: "invalid",
      };
    }
  }

  return { targetUrls: [...origins], error: null };
}

function initialState(): BrowserCookieImportState {
  return { sources: [], localProfiles: [], activeRequest: null };
}

export function useBrowserCookieImport(): BrowserCookieImportModel {
  const { t } = useLingui();
  const activeTabUrl = useBrowserPanelStore((browserState) => {
    const activeTab = browserState.tabs.find((tab) => tab.tabId === browserState.activeTabId);
    return activeTab?.url;
  });
  const activeOrigin = safeHttpOrigin(activeTabUrl);
  const [targetOverride, setTargetOverride] = useState<string | null>(null);
  const targetInput = targetOverride ?? activeOrigin ?? "";

  const [state, setState] = useState<BrowserCookieImportState>(initialState);
  const [pairing, setPairing] = useState<BrowserCookieImportPairingChallenge | null>(null);
  const [pairingNow, setPairingNow] = useState(Date.now);
  const [selectedSourceId, setSelectedSourceId] = useState("");
  const [selectedLocalSourceId, setSelectedLocalSourceId] = useState("");
  const [selectedDomains, setSelectedDomains] = useState<Set<string>>(() => new Set());
  const [completion, setCompletion] = useState<BrowserCookieImportCompletion | null>(null);
  const [operation, setOperation] = useState<CookieImportOperation>("loading");
  const [error, setError] = useState<string | null>(null);
  const pairingBaselineRef = useRef<Set<string> | null>(null);
  const activeRequestRef = useRef<Pick<ActiveRequest, "requestId" | "status"> | null>(null);
  const operationGenerationRef = useRef(0);
  const mountedRef = useRef(true);

  const originErrorText = useCallback(
    (originErrorCode: Exclude<ParsedOrigins["error"], null>): string => {
      switch (originErrorCode) {
        case "missing":
          return t`Enter at least one HTTP(S) origin.`;
        case "too-many":
          return t`Choose at most ${MAX_TARGET_ORIGINS} origins.`;
        case "invalid":
          return t`Use HTTP(S) origins without usernames, passwords, paths, or private URL details.`;
      }
    },
    [t],
  );

  const genericFailure = useCallback(
    (nextOperation: Exclude<CookieImportOperation, "loading" | null>): string => {
      switch (nextOperation) {
        case "opening-extension":
          return t`Could not open the extension folder. Try again.`;
        case "choosing-file":
          return t`Could not preview that cookie file. Use Cookie-Editor JSON or Netscape cookies.txt.`;
        case "pairing":
          return t`Could not start browser pairing. Try again.`;
        case "cancelling-pairing":
          return t`Could not cancel browser pairing. Try again.`;
        case "forgetting-source":
          return t`Could not forget that browser profile. Try again.`;
        case "previewing":
          return t`Could not create a cookie preview. Check that the extension is connected.`;
        case "committing":
          return t`Could not import the selected cookies. No cookie values were kept in this screen.`;
        case "cancelling-import":
          return t`Could not cancel the cookie import. Try again.`;
      }
    },
    [t],
  );

  const applyActiveRequest = useCallback((request: ActiveRequest | null) => {
    const previousRequest = activeRequestRef.current;
    const requestChanged = request?.requestId !== previousRequest?.requestId;
    const becameReady = request?.status === "ready" && previousRequest?.status !== "ready";
    activeRequestRef.current = request
      ? { requestId: request.requestId, status: request.status }
      : null;
    if (requestChanged || becameReady) {
      setSelectedDomains(
        new Set(
          request?.status === "ready"
            ? request.domains
                .filter((domain) => domain.cookieCount > 0)
                .map((domain) => domain.domain)
            : [],
        ),
      );
    }
  }, []);

  const applyState = useCallback(
    (nextState: BrowserCookieImportState) => {
      setState(nextState);
      setSelectedSourceId((currentSourceId) => {
        if (nextState.sources.some((source) => source.sourceId === currentSourceId)) {
          return currentSourceId;
        }
        return (
          nextState.sources.find((source) => source.connected)?.sourceId ??
          nextState.sources[0]?.sourceId ??
          ""
        );
      });
      const localProfiles = nextState.localProfiles ?? [];
      setSelectedLocalSourceId((currentSourceId) =>
        localProfiles.some((profile) => profile.sourceId === currentSourceId)
          ? currentSourceId
          : (localProfiles[0]?.sourceId ?? ""),
      );
      applyActiveRequest(nextState.activeRequest);

      const pairingBaseline = pairingBaselineRef.current;
      if (
        pairingBaseline &&
        nextState.sources.some((source) => !pairingBaseline.has(source.sourceId))
      ) {
        pairingBaselineRef.current = null;
        setPairing(null);
      }
    },
    [applyActiveRequest],
  );

  const refreshState = useCallback(
    async (quiet = false) => {
      try {
        const nextState = await readBridge().browserCookieImportGetState();
        if (mountedRef.current) applyState(nextState);
      } catch {
        if (!quiet && mountedRef.current) {
          setError(t`Could not load browser cookie-import settings.`);
        }
      } finally {
        if (mountedRef.current) {
          setOperation((current) => (current === "loading" ? null : current));
        }
      }
    },
    [applyState, t],
  );

  useEffect(() => {
    mountedRef.current = true;
    void refreshState();
    return () => {
      mountedRef.current = false;
    };
  }, [refreshState]);

  useEffect(() => {
    const intervalId = window.setInterval(() => void refreshState(true), BACKGROUND_REFRESH_MS);
    return () => window.clearInterval(intervalId);
  }, [refreshState]);

  useEffect(() => {
    if (!pairing) return;
    setPairingNow(Date.now());
    const intervalId = window.setInterval(() => {
      const now = Date.now();
      setPairingNow(now);
      if (now >= pairing.expiresAt) {
        pairingBaselineRef.current = null;
        setPairing(null);
      }
    }, 1_000);
    return () => window.clearInterval(intervalId);
  }, [pairing]);

  const run = useCallback(
    async (
      nextOperation: Exclude<CookieImportOperation, "loading" | null>,
      work: (isCurrent: () => boolean) => Promise<void>,
    ) => {
      const operationGeneration = operationGenerationRef.current + 1;
      operationGenerationRef.current = operationGeneration;
      const isCurrent = () =>
        mountedRef.current && operationGenerationRef.current === operationGeneration;
      setOperation(nextOperation);
      setError(null);
      try {
        await work(isCurrent);
      } catch {
        if (isCurrent()) setError(genericFailure(nextOperation));
      } finally {
        if (isCurrent()) setOperation(null);
      }
    },
    [genericFailure],
  );

  const beginPairing = useCallback(
    () =>
      run("pairing", async () => {
        pairingBaselineRef.current = new Set(state.sources.map((source) => source.sourceId));
        const challenge = await readBridge().browserCookieImportBeginPairing();
        if (!mountedRef.current) return;
        setPairingNow(Date.now());
        setPairing(challenge);
      }),
    [run, state.sources],
  );

  const openExtensionFolder = useCallback(
    () =>
      run("opening-extension", async () => {
        await readBridge().browserCookieImportOpenExtensionFolder();
      }),
    [run],
  );

  const chooseFile = useCallback(async () => {
    const parsed = parseTargetOrigins(targetInput);
    if (parsed.error) {
      setError(originErrorText(parsed.error));
      return;
    }
    await run("choosing-file", async () => {
      const request = await readBridge().browserCookieImportChooseFile({
        targetUrls: parsed.targetUrls,
        dialogTitle: t`Choose a cookie export`,
        cookieExportsFilterName: t`Cookie exports`,
        allFilesFilterName: t`All files`,
      });
      if (!request || !mountedRef.current) return;
      setCompletion(null);
      applyActiveRequest(request);
      setState((currentState) => ({ ...currentState, activeRequest: request }));
    });
  }, [applyActiveRequest, originErrorText, run, t, targetInput]);

  const cancelPairing = useCallback(
    () =>
      run("cancelling-pairing", async () => {
        if (!pairing) return;
        await readBridge().browserCookieImportCancelPairing({ pairingId: pairing.pairingId });
        if (!mountedRef.current) return;
        pairingBaselineRef.current = null;
        setPairing(null);
      }),
    [pairing, run],
  );

  const forgetSource = useCallback(
    (sourceId: string) =>
      run("forgetting-source", async () => {
        await readBridge().browserCookieImportForgetSource({ sourceId });
        if (!mountedRef.current) return;
        setState((currentState) => ({
          sources: currentState.sources.filter((source) => source.sourceId !== sourceId),
          activeRequest:
            currentState.activeRequest?.sourceId === sourceId ? null : currentState.activeRequest,
        }));
        setSelectedSourceId((currentSourceId) =>
          currentSourceId === sourceId ? "" : currentSourceId,
        );
      }),
    [run],
  );

  const preview = useCallback(async () => {
    const parsed = parseTargetOrigins(targetInput);
    if (parsed.error) {
      setError(originErrorText(parsed.error));
      return;
    }
    const source = state.sources.find((candidate) => candidate.sourceId === selectedSourceId);
    if (!source?.connected) {
      setError(t`Choose a connected browser profile before previewing cookies.`);
      return;
    }

    await run("previewing", async (isCurrent) => {
      const request = await readBridge().browserCookieImportPreview({
        sourceId: source.sourceId,
        targetUrls: parsed.targetUrls,
      });
      if (!isCurrent()) return;
      setCompletion(null);
      applyActiveRequest(request);
      setState((currentState) => ({ ...currentState, activeRequest: request }));
    });
  }, [applyActiveRequest, originErrorText, run, selectedSourceId, state.sources, t, targetInput]);

  const previewLocal = useCallback(async () => {
    const parsed = parseTargetOrigins(targetInput);
    if (parsed.error) {
      setError(originErrorText(parsed.error));
      return;
    }
    const source = (state.localProfiles ?? []).find(
      (candidate) => candidate.sourceId === selectedLocalSourceId,
    );
    if (!source) {
      setError(t`Choose an installed browser profile before previewing cookies.`);
      return;
    }
    await run("previewing", async (isCurrent) => {
      const request = await readBridge().browserCookieImportPreviewLocal({
        sourceId: source.sourceId,
        targetUrls: parsed.targetUrls,
      });
      if (!isCurrent()) return;
      setCompletion(null);
      applyActiveRequest(request);
      setState((currentState) => ({ ...currentState, activeRequest: request }));
    });
  }, [
    applyActiveRequest,
    originErrorText,
    run,
    selectedLocalSourceId,
    state.localProfiles,
    t,
    targetInput,
  ]);

  const commit = useCallback(
    () =>
      run("committing", async () => {
        const request = state.activeRequest;
        if (!request || request.status !== "ready") return;
        const result = await readBridge().browserCookieImportCommit({
          requestId: request.requestId,
          selectedDomains: request.domains
            .map((domain) => domain.domain)
            .filter((domain) => selectedDomains.has(domain)),
        });
        if (!mountedRef.current) return;
        setCompletion(result);
        setState((currentState) => ({
          ...currentState,
          activeRequest: currentState.activeRequest
            ? {
                ...currentState.activeRequest,
                status: "completed",
                importedCount: result.importedCount,
                skippedCount: result.skippedCount,
              }
            : null,
        }));
      }),
    [run, selectedDomains, state.activeRequest],
  );

  const cancelImport = useCallback(
    () =>
      run("cancelling-import", async () => {
        const request = state.activeRequest;
        if (!request) return;
        await readBridge().browserCookieImportCancel({ requestId: request.requestId });
        if (!mountedRef.current) return;
        activeRequestRef.current = null;
        setSelectedDomains(new Set());
        setState((currentState) => ({ ...currentState, activeRequest: null }));
      }),
    [run, state.activeRequest],
  );

  const toggleDomain = useCallback((domain: string) => {
    setSelectedDomains((currentDomains) => {
      const nextDomains = new Set(currentDomains);
      if (nextDomains.has(domain)) nextDomains.delete(domain);
      else nextDomains.add(domain);
      return nextDomains;
    });
  }, []);

  return {
    state,
    pairing,
    pairingRemainingMs: pairing ? Math.max(0, pairing.expiresAt - pairingNow) : 0,
    selectedSourceId,
    selectedLocalSourceId,
    targetInput,
    selectedDomains,
    completion,
    operation,
    error,
    activeOrigin,
    openExtensionFolder,
    chooseFile,
    setSelectedSourceId,
    setSelectedLocalSourceId,
    setTargetInput: setTargetOverride,
    useActiveOrigin: () => {
      if (activeOrigin) setTargetOverride(activeOrigin);
    },
    toggleDomain,
    beginPairing,
    cancelPairing,
    forgetSource,
    preview,
    previewLocal,
    commit,
    cancelImport,
  };
}

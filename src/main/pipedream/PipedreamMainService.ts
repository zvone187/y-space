import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  pipedreamBeginConnectPayloadSchema,
  pipedreamBeginConnectResultSchema,
  pipedreamEnvFileImportResultSchema,
  type PipedreamBeginConnectPayload,
  type PipedreamBeginConnectResult,
  type PipedreamEnvFileImportResult,
  type PipedreamSnapshot,
} from "@/shared/contracts";
import {
  capturePipedreamBootstrapEnvText,
  PIPEDREAM_ENV_FILE_MAX_BYTES,
  type PipedreamBootstrap,
} from "@/shared/pipedreamBootstrap";
import type { PipedreamPrivilegedConnectLinkResult } from "@/shared/pipedreamPrivilegedIpc";

export interface PipedreamMainServiceOptions {
  readonly createConnectLink: (appSlug: string) => Promise<PipedreamPrivilegedConnectLinkResult>;
  readonly openConnectUrl: (url: string) => Promise<void>;
  readonly persistEnvFilePath: (filePath: string) => void;
  readonly clearEnvFilePath: () => void;
  readonly fallbackBootstrap: () => PipedreamBootstrap;
  readonly configureBootstrap: (bootstrap: PipedreamBootstrap) => Promise<PipedreamSnapshot>;
}

/** Main-only Connect-link coordinator; renderer receives only a safe acknowledgement. */
export class PipedreamMainService {
  readonly #options: PipedreamMainServiceOptions;

  constructor(options: PipedreamMainServiceOptions) {
    this.#options = options;
  }

  async beginConnect(payload: PipedreamBeginConnectPayload): Promise<PipedreamBeginConnectResult> {
    const { appSlug } = pipedreamBeginConnectPayloadSchema.parse(payload);
    const result = await this.#options.createConnectLink(appSlug);
    const url = requireTrustedPipedreamConnectUrl(result.connectLinkUrl);
    await this.#options.openConnectUrl(url);
    return pipedreamBeginConnectResultSchema.parse({ opened: true, expiresAt: result.expiresAt });
  }

  async importEnvironmentFile(filePath: string): Promise<PipedreamEnvFileImportResult> {
    if (!isAbsolute(filePath) || filePath.length > 4_096) {
      return { status: "invalid", reason: "unreadable" };
    }

    let serialized: string;
    try {
      const metadata = statSync(filePath);
      if (!metadata.isFile()) return { status: "invalid", reason: "unreadable" };
      if (metadata.size > PIPEDREAM_ENV_FILE_MAX_BYTES) {
        return { status: "invalid", reason: "too-large" };
      }
      serialized = readFileSync(filePath, "utf8");
      if (Buffer.byteLength(serialized, "utf8") > PIPEDREAM_ENV_FILE_MAX_BYTES) {
        return { status: "invalid", reason: "too-large" };
      }
    } catch {
      return { status: "invalid", reason: "unreadable" };
    }

    const bootstrap = capturePipedreamBootstrapEnvText(serialized, {});
    if (bootstrap.state === "absent") {
      return { status: "invalid", reason: "no-supported-values" };
    }

    const snapshot = await this.#options.configureBootstrap(bootstrap);
    this.#options.persistEnvFilePath(filePath);
    return pipedreamEnvFileImportResultSchema.parse({ status: "configured", snapshot });
  }

  async clearEnvironmentFile(): Promise<PipedreamSnapshot> {
    const snapshot = await this.#options.configureBootstrap(this.#options.fallbackBootstrap());
    this.#options.clearEnvFilePath();
    return snapshot;
  }
}

function requireTrustedPipedreamConnectUrl(value: string): string {
  try {
    const url = new URL(value);
    const trustedHost = url.hostname === "pipedream.com" || url.hostname.endsWith(".pipedream.com");
    if (url.protocol !== "https:" || !trustedHost || !url.searchParams.has("app"))
      throw new Error();
    return url.toString();
  } catch {
    throw new Error("Pipedream returned an invalid Connect Link.");
  }
}

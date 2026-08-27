import {
  pipedreamBeginConnectPayloadSchema,
  pipedreamBeginConnectResultSchema,
  type PipedreamBeginConnectPayload,
  type PipedreamBeginConnectResult,
} from "@/shared/contracts";
import type { PipedreamPrivilegedConnectLinkResult } from "@/shared/pipedreamPrivilegedIpc";

export interface PipedreamMainServiceOptions {
  readonly createConnectLink: (appSlug: string) => Promise<PipedreamPrivilegedConnectLinkResult>;
  readonly openConnectUrl: (url: string) => Promise<void>;
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

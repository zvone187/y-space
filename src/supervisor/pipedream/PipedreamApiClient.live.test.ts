import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { capturePipedreamBootstrapEnvText } from "@/shared/pipedreamBootstrap";
import { PipedreamApiClient } from "./PipedreamApiClient";
import { PipedreamTokenBroker } from "./PipedreamTokenBroker";

describe("PipedreamApiClient live read-only smoke", () => {
  it.skipIf(process.env.RUN_PIPEDREAM_LIVE_TESTS !== "1")(
    "authenticates and discovers both the first catalog item and Gmail",
    async () => {
      const envText = await readFile(resolve(process.cwd(), ".env.pipedream"), "utf8");
      const bootstrap = capturePipedreamBootstrapEnvText(envText);
      if (bootstrap.state !== "ready")
        throw new Error("Live Pipedream credentials are incomplete.");

      const broker = new PipedreamTokenBroker({
        clientId: bootstrap.credentials.clientId,
        clientSecret: bootstrap.credentials.clientSecret,
      });
      const client = new PipedreamApiClient({
        projectId: bootstrap.credentials.projectId,
        environment: bootstrap.credentials.environment,
        externalUserId: "y-space-live-read-only-smoke",
        getAccessToken: () => broker.getAccessToken(),
        invalidateAccessToken: () => broker.invalidate(),
      });

      await expect(client.getProject()).resolves.toMatchObject({ name: expect.any(String) });
      await expect(client.listApps({ limit: 1 })).resolves.toMatchObject({
        apps: [expect.objectContaining({ id: expect.any(String), slug: expect.any(String) })],
      });
      await expect(client.listApps({ query: "gmail", limit: 10 })).resolves.toMatchObject({
        apps: expect.arrayContaining([expect.objectContaining({ slug: "gmail" })]),
      });
    },
    60_000,
  );
});

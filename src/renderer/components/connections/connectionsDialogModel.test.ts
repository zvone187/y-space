import { describe, expect, it } from "vitest";
import type { PipedreamAppSummary } from "@/shared/contracts";
import { mergeApps } from "./connectionsDialogModel";

const GMAIL_APP: PipedreamAppSummary = {
  id: "app_Gmail123",
  slug: "gmail",
  name: "Gmail",
};

const SLACK_APP: PipedreamAppSummary = {
  id: "app_Slack123",
  slug: "slack",
  name: "Slack",
};

describe("connectionsDialogModel", () => {
  it("merges catalog pages without duplicating an existing app", () => {
    expect(mergeApps([GMAIL_APP], [GMAIL_APP, SLACK_APP])).toEqual([GMAIL_APP, SLACK_APP]);
  });
});

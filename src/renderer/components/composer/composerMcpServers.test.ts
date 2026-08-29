import { describe, expect, it } from "vitest";
import { composerMcpServers } from "./composerMcpServers";

describe("composerMcpServers", () => {
  it("does not expose mandatory Y Space Browser as a per-thread toggle", () => {
    expect(composerMcpServers.map((server) => server.id)).toEqual(["crossagents"]);
  });
});

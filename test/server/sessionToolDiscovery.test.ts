import { describe, expect, test } from "bun:test";
import { SessionToolBinding } from "../../src/server/SessionToolBinding";

describe("session-scoped tool discovery", () => {
  test("does not leak a bound session to another MCP server with the same transport session ID", async () => {
    const serverA = new SessionToolBinding();
    const serverB = new SessionToolBinding();

    expect(serverA.bind("reused-transport-id", "device-session-a")).toBe(true);
    expect(serverA.effectiveSessionUuid("reused-transport-id")).toBe("device-session-a");
    expect(serverB.effectiveSessionUuid("reused-transport-id")).toBeUndefined();
  });

  test("only reports a refresh when a session binding changes", () => {
    const binding = new SessionToolBinding();

    expect(binding.bind("transport", "device-session-a")).toBe(true);
    expect(binding.bind("transport", "device-session-a")).toBe(false);
    expect(binding.bind("transport", "device-session-b")).toBe(true);
  });
});

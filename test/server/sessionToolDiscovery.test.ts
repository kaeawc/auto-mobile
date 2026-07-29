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

  test("seeds only a recreated transport's initial session binding", () => {
    const binding = new SessionToolBinding("device-session-a");

    expect(binding.effectiveSessionUuid("recreated-transport")).toBe("device-session-a");
    expect(binding.bind("recreated-transport", "device-session-a")).toBe(true);
    expect(binding.bind("recreated-transport", "device-session-a")).toBe(false);
    expect(binding.bind("recreated-transport", "device-session-b")).toBe(true);
    expect(binding.effectiveSessionUuid("recreated-transport")).toBe("device-session-b");
  });

  test.each(["", "   "])("uses the bound session when an explicit session UUID is %p", sessionUuid => {
    const binding = new SessionToolBinding();
    binding.bind("transport", "disabled-session");

    expect(binding.effectiveSessionUuid("transport", { sessionUuid })).toBe("disabled-session");
    expect(binding.bind("transport", sessionUuid)).toBe(false);
  });
});

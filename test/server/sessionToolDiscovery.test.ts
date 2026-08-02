import { describe, expect, test } from "bun:test";
import { SessionToolBinding } from "../../src/server/SessionToolBinding";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";

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

  test("retains a generated profile for an unbound stdio transport", () => {
    const binding = new SessionToolBinding(undefined, undefined, new FakeIdGenerator(["capability-profile-1"]));
    const sessionUuid = binding.createAndBindCapabilityProfile(undefined);

    expect(sessionUuid).toBe("capability-profile-1");
    expect(binding.effectiveSessionUuid(undefined)).toBeUndefined();
    expect(binding.effectiveCapabilityProfileUuid(undefined)).toBe(sessionUuid);
    // A capability profile is connection state, not a releasable device session.
    expect(binding.unbindSession(sessionUuid)).toBe(false);
    expect(binding.effectiveCapabilityProfileUuid(undefined)).toBe(sessionUuid);
  });

  test("binds a resumed profile to an unbound stdio transport without selecting device routing", () => {
    const binding = new SessionToolBinding();

    expect(binding.bindCapabilityProfile(undefined, "capability-profile-1")).toBe(true);
    expect(binding.effectiveSessionUuid(undefined)).toBeUndefined();
    expect(binding.effectiveCapabilityProfileUuid(undefined)).toBe("capability-profile-1");
  });

  test("seeds only a recreated transport's initial session binding", () => {
    const binding = new SessionToolBinding("device-session-a");

    expect(binding.effectiveSessionUuid("recreated-transport")).toBe("device-session-a");
    expect(binding.bind("recreated-transport", "device-session-a")).toBe(true);
    expect(binding.bind("recreated-transport", "device-session-a")).toBe(false);
    expect(binding.bind("recreated-transport", "device-session-b")).toBe(false);
    expect(() => binding.effectiveSessionUuid(
      "recreated-transport",
      { sessionUuid: "device-session-b" },
    )).toThrow("MCP connection is bound");
    expect(binding.effectiveSessionUuid("recreated-transport")).toBe("device-session-a");
  });

  test.each(["", "   "])("uses the bound session when an explicit session UUID is %p", sessionUuid => {
    const binding = new SessionToolBinding();
    binding.bind("transport", "disabled-session");

    expect(binding.effectiveSessionUuid("transport", { sessionUuid })).toBe("disabled-session");
    expect(binding.bind("transport", sessionUuid)).toBe(false);
  });

  test("unbindSession drops every transport binding whose effective session was released (issue #4611 Gap D)", () => {
    const binding = new SessionToolBinding();
    binding.bind("transport-a", "session-1");
    binding.bind("transport-b", "session-1");
    binding.bind("transport-c", "session-2");

    // A real release of session-1 removes both bindings pointed at it and leaves
    // the unrelated session-2 binding intact.
    expect(binding.unbindSession("session-1")).toBe(true);
    expect(binding.effectiveSessionUuid("transport-a")).toBeUndefined();
    expect(binding.effectiveSessionUuid("transport-b")).toBeUndefined();
    expect(binding.effectiveSessionUuid("transport-c")).toBe("session-2");
  });

  test("unbindSession reports no change when nothing matches the released session", () => {
    const binding = new SessionToolBinding();
    binding.bind("transport", "session-1");

    expect(binding.unbindSession("session-2")).toBe(false);
    expect(binding.unbindSession("")).toBe(false);
    expect(binding.effectiveSessionUuid("transport")).toBe("session-1");
  });

  test("unbindSession also clears a seeded initial binding for the released session", () => {
    const binding = new SessionToolBinding("seeded-session");

    expect(binding.effectiveSessionUuid("recreated-transport")).toBe("seeded-session");
    expect(binding.unbindSession("seeded-session")).toBe(true);
    // The seed fallback is gone, so a later sessionless call no longer enforces it.
    expect(binding.effectiveSessionUuid("recreated-transport")).toBeUndefined();
  });
});

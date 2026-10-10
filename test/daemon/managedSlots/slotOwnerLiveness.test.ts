import { afterEach, describe, expect, test } from "bun:test";
import { FakeSlotRegistry } from "../../fakes/FakeSlotRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";
import { assignManagedSlotDevice } from "./managedSlotFixtures";
import {
  createSlotExecOwnerLiveness,
  currentSlotOwnerProcess,
  type SlotOwnerProcessProbe,
  withLiveExecutionSessions,
} from "../../../src/daemon/managedSlots/slotOwnerLiveness";
import type { SlotExecOwner } from "../../../src/daemon/managedSlots/slotRegistry";

class FakeProbe implements SlotOwnerProcessProbe {
  readonly running = new Set<number>();
  readonly tokens = new Map<number, string>();
  isRunning(pid: number): boolean {
    return this.running.has(pid);
  }
  readGenerationToken(pid: number): string | undefined {
    return this.tokens.get(pid);
  }
}

function owner(pid: number, processGenerationToken?: string | null): SlotExecOwner {
  return { daemonId: "d", pid, sessionUuid: "s", processGenerationToken };
}

describe("slot execution owner liveness", () => {
  test("a PID that is not running is dead", () => {
    const probe = new FakeProbe();
    expect(createSlotExecOwnerLiveness(probe)(owner(10, "linux:boot:100"))).toBe(false);
  });

  test("a running PID with the recorded start identity is live", () => {
    const probe = new FakeProbe();
    probe.running.add(10);
    probe.tokens.set(10, "linux:boot:100");
    expect(createSlotExecOwnerLiveness(probe)(owner(10, "linux:boot:100"))).toBe(true);
  });

  test("a reused PID (same scheme, different start identity) is dead", () => {
    const probe = new FakeProbe();
    probe.running.add(10);
    probe.tokens.set(10, "linux:boot:999");
    expect(createSlotExecOwnerLiveness(probe)(owner(10, "linux:boot:100"))).toBe(false);
  });

  test("no recorded token, an unreadable token, or incomparable schemes fall back to the PID", () => {
    const probe = new FakeProbe();
    probe.running.add(10);
    const live = createSlotExecOwnerLiveness(probe);
    expect(live(owner(10))).toBe(true);
    expect(live(owner(10, null))).toBe(true);
    expect(live(owner(10, "linux:boot:100"))).toBe(true);
    probe.tokens.set(10, "darwin-utc:Mon Oct  9 10:00:00 2026");
    expect(live(owner(10, "linux:boot:100"))).toBe(true);
  });

  test("the current process records its PID and generation token", () => {
    expect(currentSlotOwnerProcess(() => "linux:boot:1", 77)).toEqual({
      pid: 77,
      processGenerationToken: "linux:boot:1",
    });
    expect(currentSlotOwnerProcess(() => undefined, 77)).toEqual({
      pid: 77,
      processGenerationToken: null,
    });
  });
});

describe("owner liveness that counts this daemon's live executions (#11275)", () => {
  const liveSessions = new Set(["live-session"]);
  const sessions = { isLiveManagedExecutionSession: (id: string) => liveSessions.has(id) };
  const deadProcess = () => false;

  test("an owner whose process died with a restart is live while its session is", () => {
    const liveness = withLiveExecutionSessions(deadProcess, sessions);
    expect(liveness({ daemonId: "before", pid: 10, sessionUuid: "live-session" })).toBe(true);
    expect(liveness({ daemonId: "before", pid: 10, sessionUuid: "ended-session" })).toBe(false);
  });

  test("a live process is live whatever its session; a settler is judged by its process alone", () => {
    expect(withLiveExecutionSessions(() => true, sessions)(owner(10))).toBe(true);
    expect(withLiveExecutionSessions(deadProcess, sessions)({ daemonId: "d", pid: 10 })).toBe(
      false,
    );
  });
});

describe("a record this daemon wrote is judged by session, never by PID (#11339)", () => {
  const SELF_PID = 4242;
  const held = new Set<string>();
  const live = new Set<string>();
  const reservations = new Set<string>();
  const sessions = {
    isLiveManagedExecutionSession: (id: string) => live.has(id),
    hasSession: (id: string) => held.has(id),
  };
  // This process is running, as it always is while it judges.
  const liveness = withLiveExecutionSessions(() => true, sessions, {
    thisProcess: { pid: SELF_PID },
    reservations: { has: (id) => reservations.has(id) },
  });
  const mine = (sessionUuid: string): SlotExecOwner => ({
    daemonId: "pid-4242",
    pid: SELF_PID,
    sessionUuid,
  });

  afterEach(() => {
    held.clear();
    live.clear();
    reservations.clear();
  });

  test("a gone session's record is dead although this process is running", () => {
    expect(liveness(mine("S1"))).toBe(false);
  });

  test("a held or live session's record is live", () => {
    live.add("live");
    held.add("held");
    expect(liveness(mine("live"))).toBe(true);
    expect(liveness(mine("held"))).toBe(true);
  });

  test("an in-flight reservation is live until it is gone", () => {
    reservations.add("reserve-1");
    expect(liveness(mine("reserve-1"))).toBe(true);
    reservations.delete("reserve-1");
    expect(liveness(mine("reserve-1"))).toBe(false);
  });

  test("a record naming another process is still judged by that process", () => {
    const other: SlotExecOwner = { daemonId: "other", pid: 99, sessionUuid: "S9" };
    expect(liveness(other)).toBe(true);
    const otherDead = withLiveExecutionSessions(() => false, sessions, {
      thisProcess: { pid: SELF_PID },
    });
    expect(otherDead(other)).toBe(false);
  });

  test("a settler of this process (no session) is judged by its process", () => {
    expect(liveness({ daemonId: "pid-4242", pid: SELF_PID })).toBe(true);
  });

  test("P2: a record left by a failed clear frees once S1's session is gone", async () => {
    const registry = new FakeSlotRegistry(new FakeTimer(), liveness);
    const key = await assignManagedSlotDevice(registry, "android", "AVD");
    const binding = { generation: 1, stableDeviceId: "AVD" };
    held.add("S1");
    expect((await registry.claimExecution(key, binding, mine("S1"))).kind).toBe("claimed");
    // The clear of S1's record failed with SQLITE_BUSY, so S1 still owns the slot while it lives.
    expect((await registry.claimExecution(key, binding, mine("S2"))).kind).toBe("slot_in_use");

    held.delete("S1");

    expect((await registry.claimExecution(key, binding, mine("S2"))).kind).toBe("claimed");
  });
});

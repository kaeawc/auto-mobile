import { describe, expect, test } from "bun:test";
import {
  createSlotExecOwnerLiveness,
  currentSlotOwnerProcess,
  type SlotOwnerProcessProbe,
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

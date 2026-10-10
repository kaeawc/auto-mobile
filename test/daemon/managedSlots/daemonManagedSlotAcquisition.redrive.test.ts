import { describe, expect, test } from "bun:test";
import { createDaemonManagedSlotAcquisition } from "../../../src/daemon/managedSlots/daemonManagedSlotAcquisition";
import type { ManagedSlotAcquisitionSessions } from "../../../src/daemon/managedSlots/managedSlotAcquisition";
import { SlotJournalInFlight } from "../../../src/daemon/managedSlots/slotJournal";
import { FakeSlotRegistry } from "../../fakes/FakeSlotRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";

// #11338: the redrive loop is started when the daemon first opens the registry, which on a fresh
// host happens at the first acquisition. Every open site asks; only the first may start a loop.

class NoSessions implements ManagedSlotAcquisitionSessions {
  async claimLivenessOwnership(): Promise<"claimed"> {
    return "claimed";
  }
  async adoptManagedExecutionLivenessPolicy(): Promise<void> {}
  async releaseSession(): Promise<void> {}
}

function handleOver(timer: FakeTimer) {
  return createDaemonManagedSlotAcquisition({
    registry: async () => new FakeSlotRegistry(timer),
    sessions: new NoSessions(),
    pool: { getAllDevices: () => [], assertNotClaimedByForeignDaemon: async () => {} },
    owner: () => ({ daemonId: "daemon-1", pid: 1 }),
    timer,
    journal: {
      owner: { daemonId: "daemon-1", pid: 1, processGeneration: "gen-1" },
      inFlight: new SlotJournalInFlight(),
    },
    invokeTool: async () => ({}) as never,
    tooling: {
      deviceManager: { listDeviceImages: async () => [] },
      androidConfigReader: { readConfig: async () => ({}) as never },
      androidImageCatalog: { listInstalledPackages: async () => [] },
      iosRuntimeCatalog: {
        getRuntimesChecked: async () => [],
        getDeviceTypesChecked: async () => [],
      },
    },
  });
}

describe("startJournalRedrive", () => {
  test("a second start over the same registry returns the running loop", async () => {
    const timer = new FakeTimer();
    const registry = new FakeSlotRegistry(timer);
    const handle = handleOver(timer);
    const first = handle.startJournalRedrive(registry);
    const second = handle.startJournalRedrive(registry);
    expect(second).toBe(first);
    const stopped = first.stop();
    timer.advanceTime(5_000);
    await stopped;
  });

  test("a different registry gets its own loop", async () => {
    const timer = new FakeTimer();
    const handle = handleOver(timer);
    const a = handle.startJournalRedrive(new FakeSlotRegistry(timer));
    const b = handle.startJournalRedrive(new FakeSlotRegistry(timer));
    expect(b).not.toBe(a);
    const stops = [a.stop(), b.stop()];
    timer.advanceTime(5_000);
    await Promise.all(stops);
  });
});

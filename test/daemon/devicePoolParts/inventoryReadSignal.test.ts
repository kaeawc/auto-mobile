import { describe, expect, test } from "bun:test";
import {
  DevicePoolAssignment,
  type AssignmentCallbacks,
} from "../../../src/daemon/devicePoolParts/assignment";
import { DevicePoolState } from "../../../src/daemon/devicePoolParts/state";
import type { PooledDevice } from "../../../src/daemon/devicePoolTypes";
import type { BootedDevice, Platform } from "../../../src/models";
import { runWithAbortSignal } from "../../../src/utils/AbortContext";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainMicrotasks, drainUntil } from "../../helpers/fakeTimerStepping";

// #15671: the live-inventory read takes its caller's cancellation signal explicitly and passes it
// to every listing, including the empty-inventory check's read of an unpooled platform. Only
// getRefreshedInventory, the entry point, reads the ambient signal. The direct calls below run
// OUTSIDE any runWithAbortSignal scope, so only the threaded signal can stop them.

const pooled: PooledDevice = {
  id: "emulator-5554",
  name: "Pixel",
  platform: "android",
  avdName: "Pixel",
  sessionId: null,
  status: "idle",
  lastUsedAt: 0,
  assignmentCount: 0,
  errorCount: 0,
  incarnation: 1,
};

const unexpected = (name: string) => (): never => {
  throw new Error(`unexpected ${name}`);
};

/** An Android-only pool whose device adb no longer lists, so the iOS source is read as well. */
function inventory(): { assignment: DevicePoolAssignment; manager: FakeDeviceUtils } {
  const manager = new FakeDeviceUtils();
  manager.setBootedDevices("android", []);
  manager.setBootedDevices("ios", []);
  const state = new DevicePoolState();
  state.timer = new FakeTimer();
  state.deviceManager = manager;
  const callbacks: AssignmentCallbacks = {
    getRefreshedInventory: unexpected("getRefreshedInventory"),
    refreshInventoryOwnership: async () => {},
    getStats: () => ({ total: 1, idle: 0, assigned: 0, error: 0, avgAssignments: 0 }),
    getDevicesByPlatform: (platform: Platform) => (platform === "android" ? [pooled] : []),
    mapAndroidDiscovery: (devices: readonly BootedDevice[]) => [...devices],
    getAssignedDevices: () => [],
    getAllDevices: () => [pooled],
  };
  return { assignment: new DevicePoolAssignment(state, callbacks), manager };
}

const iosReads = (manager: FakeDeviceUtils) =>
  manager.getBootedDevicesDetailedCalls().filter((call) => call.platform === "ios");

describe("live inventory read signal", () => {
  test("a cancel while the empty-inventory check reads iOS rejects with the abort reason", async () => {
    const { assignment, manager } = inventory();
    manager.setBootedDevicesDetailedHangs("ios", true);
    const controller = new AbortController();
    let outcome: PromiseSettledResult<Set<string>> | undefined;
    void assignment.readLiveInventoryDeviceIds(controller.signal).then(
      (value) => (outcome = { status: "fulfilled", value }),
      (reason: unknown) => (outcome = { status: "rejected", reason }),
    );
    await drainUntil(() => iosReads(manager).length > 0, {
      description: "the empty-inventory check reading iOS",
    });

    const reason = new Error("client cancelled");
    controller.abort(reason);
    await drainMicrotasks(20);

    expect(outcome).toEqual({ status: "rejected", reason });
    expect(iosReads(manager)[0]?.options.signal).toBe(controller.signal);
  });

  test("with no signal the read still answers an empty, known inventory", async () => {
    const { assignment, manager } = inventory();

    expect(await assignment.readLiveInventoryDeviceIds(undefined)).toEqual(new Set());
    expect(
      manager.getBootedDevicesDetailedCalls().map((call) => [call.platform, call.options.signal]),
    ).toEqual([
      ["android", undefined],
      ["ios", undefined],
    ]);
  });

  test("getRefreshedInventory passes the ambient signal down as the entry point", async () => {
    const { assignment, manager } = inventory();
    const controller = new AbortController();

    await runWithAbortSignal(controller.signal, () => assignment.getRefreshedInventory());

    expect(manager.getBootedDevicesDetailedCalls().map((call) => call.options.signal)).toEqual([
      controller.signal,
      controller.signal,
    ]);
  });
});

import { afterEach, expect, spyOn, test } from "bun:test";
import { defaultDaemonContext } from "../../../../src/daemon/daemonContext";
import { SessionManager } from "../../../../src/daemon/sessionManager";
import { UNPOOLED_SHUTDOWN_FENCE_LIFETIME_MS } from "../../../../src/daemon/unpooledShutdownFences";
import {
  clearColdBootShutdownMarker,
  stopUnownedColdBoot,
} from "../../../../src/features/deviceLifecycle/boot/bootSettlement";
import {
  setDeviceToolsDependencies,
  resetDeviceToolsDependencies,
} from "../../../../src/features/deviceLifecycle/core/dependencies";
import type { BootedDevice } from "../../../../src/models";
import { FakeChildProcess } from "../../../fakes/FakeChildProcess";
import { FakeDeviceUtils } from "../../../fakes/FakeDeviceUtils";
import { FakeDeviceSessionPersistence } from "../../../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { makePool } from "../../../helpers/makePool";
import { patchDeviceBinding } from "../../../helpers/patchDeviceBinding";

const device: BootedDevice = { deviceId: "emulator-5554", name: "Handset", platform: "android" };
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
  resetDeviceToolsDependencies();
});

function harness() {
  const timer = new FakeTimer();
  const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  const manager = new FakeDeviceUtils();
  manager.setBootedDevices("android", [device]);
  const pool = makePool(sessions, "boot-fence-test", { timer, deviceManager: manager });
  const reads = spyOn(defaultDaemonContext, "devicePool").mockReturnValue(pool);
  const writes = spyOn(defaultDaemonContext, "devicePoolWrites").mockReturnValue(pool);
  setDeviceToolsDependencies({ timer });
  cleanups.push(() => {
    reads.mockRestore();
    writes.mockRestore();
    sessions.stopCleanupTimer();
    timer.reset();
  });
  const child = new FakeChildProcess(timer);
  const fenced = () =>
    pool.testHooks.shutdownReservationCoordinator.isUnpooledShutdownFenced(device.deviceId);
  const fencesAtKill: boolean[] = [];
  const kill = spyOn(child, "kill").mockImplementation(() => {
    fencesAtKill.push(fenced());
    return true;
  });
  cleanups.push(() => kill.mockRestore());
  const boot = { device, source: "cold-boot" as const, provisioned: false, processHandle: child };
  return { pool, timer, child, fenced, kill, boot, fencesAtKill };
}

test("cancelled unpooled boot is fenced before kill, while exiting, and through discovery grace", async () => {
  const { pool, timer, child, fenced, boot, fencesAtKill } = harness();
  const confirmation = Promise.withResolvers<boolean>();
  child.once("exit", () => confirmation.resolve(true));
  const processHandle = Object.assign(child, { terminationConfirmed: confirmation.promise });
  const settlement = stopUnownedColdBoot({ ...boot, processHandle });
  expect(fencesAtKill).toEqual([true]);
  expect(fenced()).toBe(true);
  await expect(pool.pickUpRunningDevice(device)).rejects.toThrow("being shut down");
  timer.advanceTime(31_000);
  expect(fenced()).toBe(true);
  child.exitCode = 0;
  child.emit("exit", 0, null);
  await settlement;
  await expect(pool.pickUpRunningDevice(device)).rejects.toThrow("being shut down");
  timer.advanceTime(UNPOOLED_SHUTDOWN_FENCE_LIFETIME_MS);
  await pool.pickUpRunningDevice(device);
  expect(pool.getDevice(device.deviceId)?.id).toBe(device.deviceId);
});

test.each(["false", "reject"] as const)(
  "unpooled boot settles its fence when confirmation is %s",
  async (outcome) => {
    const { timer, fenced, boot } = harness();
    const confirmed = Promise.withResolvers<boolean>();
    const processHandle = Object.assign(boot.processHandle, {
      terminationConfirmed: confirmed.promise,
    });
    const settlement = stopUnownedColdBoot({ ...boot, processHandle });
    expect(fenced()).toBe(true);
    const failure = new Error("cleanup failed");
    const result = Promise.resolve(settlement).then(
      () => undefined,
      (error: unknown) => error,
    );
    if (outcome === "reject") {
      confirmed.reject(failure);
    } else {
      confirmed.resolve(false);
    }
    expect(await result).toBe(outcome === "reject" ? failure : undefined);
    expect(fenced()).toBe(true);
    timer.advanceTime(UNPOOLED_SHUTDOWN_FENCE_LIFETIME_MS);
    expect(fenced()).toBe(false);
  },
);

test.each(["pooled", "tracked", "holder", "previously-running"] as const)(
  "cold boot cleanup preserves %s behavior",
  async (path) => {
    const { pool, child, fenced, kill, boot } = harness();
    if (path !== "previously-running") {
      await pool.addDevice(device);
    }
    if (path === "tracked" || path === "holder") {
      await pool.trackStartedDeviceProcess(device, child);
    }
    if (path === "holder") {
      patchDeviceBinding(pool.getDevice(device.deviceId)!, { sessionId: "holder", status: "busy" });
    }
    child.exitCode = 0;
    await stopUnownedColdBoot({
      ...boot,
      ...(path === "previously-running" ? { runningBeforeCall: true as const } : {}),
    });
    expect(fenced()).toBe(false);
    expect(kill).toHaveBeenCalledTimes(path === "holder" || path === "previously-running" ? 0 : 1);
    expect(pool.testHooks.intentionalShutdowns.has(device.deviceId)).toBe(path === "tracked");
  },
);

test("a retried cold boot lifts the cancelled boot's fence the way startDevice clears its marker", async () => {
  const { pool, boot, child } = harness();
  child.exitCode = 0;
  await stopUnownedColdBoot(boot);
  expect(
    pool.testHooks.shutdownReservationCoordinator.isUnpooledShutdownFenced(device.deviceId),
  ).toBe(true);
  await expect(pool.pickUpRunningDevice(device)).rejects.toThrow("being shut down");
  clearColdBootShutdownMarker("cold-boot", device.deviceId);
  await pool.pickUpRunningDevice(device);
  expect(pool.getDevice(device.deviceId)?.id).toBe(device.deviceId);
});

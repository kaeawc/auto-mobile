/**
 * An Android emulator whose adb transport is `offline` vanishes from the
 * online-only booted-device discovery while its process keeps running. The
 * shutdown wait must therefore not read "absent from discovery" as "gone" until
 * adb also stops listing the serial in that state (#10074).
 */
import { expect, test } from "bun:test";
import {
  DEVICE_SHUTDOWN_POLL_INTERVAL_MS,
  waitForDeviceShutdown,
} from "../../src/server/deviceToolsShutdown";
import type { PlatformDeviceManager } from "../../src/devices/deviceUtils";
import type { BootedDevice } from "../../src/models";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";

const device: BootedDevice = { name: "Pixel_8", platform: "android", deviceId: "emulator-5554" };
const DEADLINE_MS = 10_000;

class OfflineProbeManager extends FakeDeviceUtils {
  readonly probedCandidates: string[][] = [];

  constructor(private readonly answers: Array<Set<string> | Error>) {
    super();
  }

  async getAndroidOfflineDeviceIds(candidateIds: Iterable<string>): Promise<Set<string>> {
    this.probedCandidates.push([...candidateIds]);
    const answer =
      this.answers[Math.min(this.probedCandidates.length - 1, this.answers.length - 1)];
    if (answer instanceof Error) {
      throw answer;
    }
    return answer;
  }
}

function waitFor(deviceManager: PlatformDeviceManager, timer: FakeTimer) {
  return waitForDeviceShutdown({
    deviceManager,
    device,
    timer,
    deadlineMs: timer.now() + DEADLINE_MS,
    requestAbortSignal: undefined,
    timeoutMs: DEADLINE_MS,
  });
}

test("keeps waiting while adb still lists the serial offline, then confirms it gone", async () => {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const manager = new OfflineProbeManager([
    new Set([device.deviceId]),
    new Set([device.deviceId]),
    new Set(),
  ]);
  manager.setBootedDevices("android", []);

  await expect(waitFor(manager, timer)).resolves.toBeUndefined();

  expect(manager.probedCandidates).toEqual([
    [device.deviceId],
    [device.deviceId],
    [device.deviceId],
  ]);
  expect(timer.getSleepHistory()).toEqual([
    DEVICE_SHUTDOWN_POLL_INTERVAL_MS,
    DEVICE_SHUTDOWN_POLL_INTERVAL_MS,
  ]);
});

test("a serial that stays offline until the deadline is a timeout, never a confirmed stop", async () => {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const manager = new OfflineProbeManager([new Set([device.deviceId])]);
  manager.setBootedDevices("android", []);

  await expect(waitFor(manager, timer)).rejects.toThrow(/adb still lists the device as offline/);
});

test("an unreadable adb state list is unconfirmed rather than a confirmed stop", async () => {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const manager = new OfflineProbeManager([new Error("adb server unreachable")]);
  manager.setBootedDevices("android", []);

  await expect(waitFor(manager, timer)).rejects.toThrow(/could not be read/);
});

test("a manager without the probe keeps the online-only confirmation", async () => {
  const timer = new FakeTimer();
  const manager = new FakeDeviceUtils();
  manager.setBootedDevices("android", []);

  await expect(waitFor(manager, timer)).resolves.toBeUndefined();
});

test("the offline probe is not consulted while the device is still booted", async () => {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const manager = new OfflineProbeManager([new Set()]);
  manager.setBootedDevices("android", [device]);

  await expect(waitFor(manager, timer)).rejects.toThrow(/still reported as booted/);
  expect(manager.probedCandidates).toEqual([]);
});

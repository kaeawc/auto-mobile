import { afterEach, describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { createExecResult } from "../../src/utils/execResult";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { settleWithFakeTime } from "../helpers/fakeTimerStepping";
import { AdbClient } from "../../src/utils/android-cmdline-tools/AdbClient";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";

const usb = "R5CT1234ABC";
const wireless = "adb-R5CT1234ABC-AbCdEf._adb-tls-connect._tcp";
const booted = (deviceId: string, name = deviceId): BootedDevice => ({
  deviceId,
  name,
  platform: "android",
});
const timers: FakeTimer[] = [];
afterEach(() => timers.splice(0).forEach((timer) => timer.reset()));

function harness(devices: BootedDevice[], serial = usb, avd?: string) {
  const timer = new FakeTimer();
  timers.push(timer);
  const manager = new FakeDeviceUtils();
  manager.setBootedDevices("android", devices);
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse("getprop ro.serialno", createExecResult(serial, ""));
  adb.setCommandResponse("getprop ro.kernel.qemu", createExecResult(avd ? "1" : "0", ""));
  if (avd) {
    adb.setCommandResponse("getprop ro.boot.qemu.avd_name", createExecResult(avd, ""));
  }
  const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  const pool = new DevicePool(
    createDevicePoolDependencies(sessions, "alias-daemon", {
      timer,
      deviceManager: manager,
      installedAppsRepository: new FakeInstalledAppsRepository(),
      androidAdbFactory: new FakeAdbClientFactory(adb),
    }),
  );
  return { pool, timer, manager, adb };
}

describe("Android transport aliases (#10201)", () => {
  test.each([
    [usb, wireless, undefined],
    ["emulator-5554", "localhost:5555", "Pixel"],
  ])("pools %s and %s once and refuses a second owner", async (canonical, alias, avd) => {
    const h = harness([booted(alias), booted(canonical, avd ?? canonical)], canonical, avd);
    await h.pool.refreshDevices();
    expect(h.pool.getAllDevices().map((device) => device.id)).toEqual([canonical]);
    expect(await h.pool.assignDeviceToSession("owner-a", "android")).toBe(canonical);
    const second = h.pool.assignDeviceToSession("owner-b", "android");
    await expect(
      settleWithFakeTime(h.timer, second, {
        stepMs: 1000,
        maxSteps: 70,
        description: "second owner refusal",
      }),
    ).rejects.toThrow("Timed out");
    expect(h.pool.getDevice(canonical)?.sessionId).toBe("owner-a");
  });

  test("a held wireless canonical is not re-keyed when USB appears", async () => {
    const h = harness([booted(wireless)]);
    await h.pool.refreshDevices();
    expect(await h.pool.assignDeviceToSession("owner", "android")).toBe(wireless);
    const incarnation = h.pool.getDevice(wireless)?.incarnation;
    h.manager.setBootedDevices("android", [booted(usb), booted(wireless)]);
    await h.pool.refreshDevices();
    expect(h.pool.getAllDevices().map((device) => device.id)).toEqual([wireless]);
    expect(h.pool.getDevice(wireless)?.incarnation).toBe(incarnation);
    expect(h.pool.getDevice(wireless)?.sessionId).toBe("owner");
  });

  test.each([
    [usb, wireless, undefined],
    ["emulator-5554", "localhost:5555", "Pixel"],
  ])("keeps held %s reachable when only %s remains", async (canonical, alias, avd) => {
    const h = harness([booted(canonical, avd ?? canonical), booted(alias)], canonical, avd);
    await h.pool.refreshDevices();
    await h.pool.assignDeviceToSession("owner", "android");
    const calls: string[][] = [];
    const client = new AdbClient(
      booted(canonical, avd ?? canonical),
      async (_file: string, args: string[], _maxBuffer?: number) => {
        calls.push(args);
        return createExecResult("", "");
      },
      null,
      new DefaultRetryExecutor(h.timer),
      h.timer,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      h.pool.getAndroidTransportRouting(),
    );
    await client.execute(["shell", "input", "tap", "1", "2"]);
    h.manager.setBootedDevices("android", [booted(alias)]);
    for (let refresh = 0; refresh < 4; refresh++) {
      await h.pool.refreshDevices();
    }
    expect(h.pool.getAllDevices().map((device) => device.id)).toEqual([canonical]);
    expect(h.pool.getDevice(canonical)?.sessionId).toBe("owner");
    await client.execute(["forward", "tcp:1234", "tcp:7001"]);
    expect(calls).toEqual([
      ["-s", canonical, "shell", "input", "tap", "1", "2"],
      ["-s", alias, "forward", "tcp:1234", "tcp:7001"],
    ]);
    expect(h.adb.getExecutedCommands()).toEqual([
      "shell getprop ro.serialno",
      "shell getprop ro.kernel.qemu",
      ...(avd ? ["shell getprop ro.boot.qemu.avd_name"] : []),
    ]);
    expect(h.timer.getSleepHistory()).toEqual([]);
  });

  test("an idle canonical is assignable through the surviving alias", async () => {
    const h = harness([booted(usb), booted(wireless)]);
    await h.pool.refreshDevices();
    h.manager.setBootedDevices("android", [booted(wireless)]);
    expect(await h.pool.assignDeviceToSession("owner", "android")).toBe(usb);
    expect(h.pool.getAndroidTransportRouting().resolveTransport(usb)).toBe(wireless);
  });

  test("first pooled wins even while idle", async () => {
    const h = harness([booted(wireless)]);
    await h.pool.refreshDevices();
    h.manager.setBootedDevices("android", [booted(usb), booted(wireless)]);
    await h.pool.refreshDevices();
    expect(h.pool.getAllDevices().map((device) => device.id)).toEqual([wireless]);
  });

  test("a wireless-first emulator stays one canonical entry after the console transport appears", async () => {
    const h = harness([booted("localhost:5555")], "EMULATOR-SERIAL", "Pixel");
    await h.pool.refreshDevices();
    expect(await h.pool.assignDeviceToSession("owner", "android")).toBe("localhost:5555");
    h.manager.setBootedDevices("android", [
      booted("emulator-5554", "Pixel"),
      booted("localhost:5555"),
    ]);
    await h.pool.refreshDevices();
    expect(h.pool.getAllDevices().map((device) => device.id)).toEqual(["localhost:5555"]);
    expect(h.pool.getDevice("localhost:5555")?.sessionId).toBe("owner");
    expect(h.pool.getAndroidTransportAvdName("localhost:5555")).toBe("Pixel");
  });

  test("retiring a pool incarnation retires its transport identity cache", async () => {
    const h = harness([booted(usb), booted(wireless)]);
    await h.pool.refreshDevices();
    await h.pool.removeDevice(usb);
    h.adb.setCommandResponse("getprop ro.serialno", createExecResult("OTHER-USB", ""));
    h.manager.setBootedDevices("android", [booted("OTHER-USB"), booted(wireless)]);
    await h.pool.refreshDevices();
    expect(h.pool.getAllDevices().map((device) => device.id)).toEqual(["OTHER-USB"]);
    expect(
      h.adb.getExecutedCommands().filter((command) => command.includes("ro.serialno")),
    ).toHaveLength(2);
  });

  test("distinct durable serials remain distinct without extra getprop reads", async () => {
    const h = harness([booted(usb), booted("OTHER-USB"), booted("emulator-5554", "Pixel")]);
    await h.pool.refreshDevices();
    expect(h.pool.getAllDevices()).toHaveLength(3);
    expect(h.adb.getExecutedCommands()).toEqual([]);
  });

  test("an unreadable transport identity is inconclusive rather than an independently assignable device", async () => {
    const h = harness([booted(usb), booted(wireless)], "");
    const result = await h.pool.refreshDevicesWithOutcome();
    expect(result.failure).toContain("Could not identify Android transport");
    expect(h.pool.getAllDevices()).toHaveLength(0);
    h.adb.setCommandResponse("getprop ro.serialno", createExecResult(usb, ""));
    await h.pool.refreshDevices();
    expect(h.pool.getAllDevices().map((device) => device.id)).toEqual([usb]);
  });
});

import { withAndroidTransportId } from "../../src/utils/androidSerial";
import { MissingDeviceLiveness } from "../../src/daemon/missingDeviceLiveness";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
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
const booted = (deviceId: string, name = deviceId, transportId = deviceId): BootedDevice =>
  withAndroidTransportId(
    {
      deviceId,
      name,
      platform: "android",
    },
    transportId,
  );
const timers: FakeTimer[] = [];
afterEach(() => timers.splice(0).forEach((timer) => timer.reset()));

function harness(devices: BootedDevice[], serial = usb, avd?: string) {
  const timer = new FakeTimer();
  timers.push(timer);
  const manager = new FakeDeviceUtils();
  manager.setBootedDevices("android", devices);
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse("getprop ro.serialno", createExecResult(serial, ""));
  adb.setCommandResponse("boot_id", createExecResult("phone-boot", ""));
  adb.setCommandResponse("getprop ro.kernel.qemu", createExecResult(avd ? "1" : "0", ""));
  if (avd) {
    adb.setCommandResponse("getprop ro.boot.qemu.avd_name", createExecResult(avd, ""));
  }
  const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  const adbFactory = new FakeAdbClientFactory(adb);
  let liveness: MissingDeviceLiveness | undefined;
  const pool = new DevicePool(
    createDevicePoolDependencies(sessions, "alias-daemon", {
      timer,
      deviceManager: manager,
      installedAppsRepository: new FakeInstalledAppsRepository(),
      androidAdbFactory: adbFactory,
      missingDeviceLivenessFactory: (port) => {
        liveness = new MissingDeviceLiveness(port);
        return liveness;
      },
    }),
  );
  return { pool, timer, manager, adb, adbFactory, liveness };
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

  test("a failed boot_id read on held wireless keeps ownership and route and refuses owner-b", async () => {
    const h = harness([booted(usb), booted(wireless)]);
    await h.pool.refreshDevices();
    expect(await h.pool.assignDeviceToSession("owner-a", "android")).toBe(usb);
    h.manager.setBootedDevices("android", [booted(wireless)]);
    await h.pool.refreshDevices();
    h.adb.setCommandError("boot_id", new Error("timeout"));
    expect(
      (await h.pool.normalizeAndroidDiscovery([booted(wireless)])).map((row) => row.deviceId),
    ).toEqual([usb]);
    await h.pool.refreshDevices();
    expect(h.pool.getAllDevices().map((device) => device.id)).toEqual([usb]);
    expect(h.pool.getAndroidTransportRouting().resolveTransport(usb)).toBe(wireless);
    await expect(
      settleWithFakeTime(h.timer, h.pool.assignDeviceToSession("owner-b", "android"), {
        stepMs: 1000,
        maxSteps: 70,
        description: "transient probe second owner refusal",
      }),
    ).rejects.toThrow("Timed out");
    expect(h.pool.getDevice(usb)?.sessionId).toBe("owner-a");
  });

  test("unchanged transports perform zero identity probes per refresh", async () => {
    const h = harness([booted(usb), booted(wireless)]);
    await h.pool.refreshDevices();
    const calls = h.adb.getExecutedCommands().length;
    expect(calls).toBe(6);
    for (let refresh = 0; refresh < 3; refresh++) {
      await h.pool.refreshDevices();
      expect(h.adb.getExecutedCommands()).toHaveLength(calls);
    }
    expect(h.timer.getSleepHistory()).toEqual([]);
  });

  test("a failed USB boot_id read beside proven wireless cannot create a second owner", async () => {
    const h = harness([booted(usb), booted(wireless)]);
    const failedUsb = new FakeAdbExecutor();
    failedUsb.setCommandResponse("ro.serialno", createExecResult(usb, ""));
    failedUsb.setCommandResponse("ro.kernel.qemu", createExecResult("0", ""));
    failedUsb.setCommandError("boot_id", new Error("USB boot_id timeout"));
    let usbRecovered = false;
    const factory = spyOn(h.adbFactory, "create").mockImplementation((target) =>
      target?.deviceId === usb && !usbRecovered ? failedUsb : h.adb,
    );
    try {
      expect((await h.pool.refreshDevicesWithOutcome()).failure).toBeUndefined();
      expect(h.pool.getAllDevices().map((device) => device.id)).toEqual([wireless]);
      expect(await h.pool.assignDeviceToSession("owner-a", "android")).toBe(wireless);
      expect(h.timer.getSleepHistory()).toEqual([]);
      await expect(
        settleWithFakeTime(h.timer, h.pool.assignDeviceToSession("owner-b", "android"), {
          stepMs: 1000,
          maxSteps: 70,
          description: "mixed USB failure second owner refusal",
        }),
      ).rejects.toThrow("Timed out");
      usbRecovered = true;
      await h.pool.refreshDevices();
      expect(h.pool.getAllDevices().map((device) => device.id)).toEqual([wireless]);
      expect(h.pool.getDevice(wireless)?.sessionId).toBe("owner-a");
      expect(h.pool.getAndroidTransportAliases(wireless)).toEqual([usb]);
    } finally {
      factory.mockRestore();
    }
  });

  test.each([true, false])(
    "late wireless proof reserves an already pooled unproven USB (held=%s)",
    async (held) => {
      const h = harness([booted(usb), booted(wireless)]);
      const failedUsb = new FakeAdbExecutor();
      failedUsb.setCommandResponse("ro.serialno", createExecResult(usb, ""));
      failedUsb.setCommandResponse("ro.kernel.qemu", createExecResult("0", ""));
      failedUsb.setCommandError("boot_id", new Error("USB timeout"));
      let wirelessProven = false;
      let usbProven = false;
      const factory = spyOn(h.adbFactory, "create").mockImplementation((target) =>
        (target?.deviceId === usb ? usbProven : wirelessProven) ? h.adb : failedUsb,
      );
      try {
        await h.pool.refreshDevices();
        expect(h.pool.getAllDevices().map((device) => device.id)).toEqual([usb]);
        if (held) {
          expect(await h.pool.assignDeviceToSession("owner-a", "android")).toBe(usb);
        }
        const incarnation = h.pool.getDevice(usb)?.incarnation;
        wirelessProven = true;
        await h.pool.refreshDevices();
        expect(h.pool.getAllDevices().map((device) => device.id)).toEqual([usb]);
        expect(h.pool.getIdleDevices()).toEqual([]);
        expect(h.pool.getAvailableDeviceCount()).toBe(0);
        expect(h.pool.getAndroidTransportAliases(usb)).toEqual([]);
        await expect(
          settleWithFakeTime(h.timer, h.pool.assignDeviceToSession("owner-b", "android"), {
            stepMs: 1000,
            maxSteps: 70,
            description: "late proof second owner refusal",
          }),
        ).rejects.toThrow();
        usbProven = true;
        await h.pool.refreshDevices();
        expect(h.pool.getAllDevices().map((device) => device.id)).toEqual([usb]);
        expect(h.pool.getDevice(usb)?.incarnation).toBe(incarnation);
        expect(h.pool.getDevice(usb)?.sessionId).toBe(held ? "owner-a" : null);
        expect(h.pool.getAndroidTransportAliases(usb)).toEqual([wireless]);
        if (!held) {
          expect(await h.pool.assignDeviceToSession("owner-b", "android")).toBe(usb);
        }
      } finally {
        factory.mockRestore();
      }
    },
  );

  test.each([true, false])(
    "failed first probes retry and pool after boot_id recovers (USB present=%s)",
    async (usbPresent) => {
      const h = harness(usbPresent ? [booted(usb), booted(wireless)] : [booted(wireless)]);
      const canonical = usbPresent ? usb : wireless;
      const callsPerRefresh = usbPresent ? 6 : 3;
      let probeFails = true;
      const executeCommand = h.adb.executeCommand.bind(h.adb);
      const probe = spyOn(h.adb, "executeCommand").mockImplementation(async (...args) => {
        const result = await executeCommand(...args);
        if (probeFails && args[0].includes("boot_id")) {
          throw new Error("boot_id timeout");
        }
        return result;
      });
      try {
        await h.pool.refreshDevices();
        expect(h.adb.getExecutedCommands()).toHaveLength(callsPerRefresh);
        await h.pool.refreshDevices();
        expect(h.adb.getExecutedCommands()).toHaveLength(callsPerRefresh * 2);
        expect(h.pool.getAllDevices().map((device) => device.id)).toEqual(usbPresent ? [usb] : []);
        expect(h.pool.getAndroidTransportAliases(usb)).toEqual([]);
        if (usbPresent) {
          expect(await h.pool.assignDeviceToSession("owner", "android")).toBe(usb);
        }
        probeFails = false;
        await h.pool.refreshDevices();
        expect(h.adb.getExecutedCommands()).toHaveLength(callsPerRefresh * 3);
        expect(h.pool.getAllDevices().map((device) => device.id)).toEqual([canonical]);
        if (!usbPresent) {
          expect(await h.pool.assignDeviceToSession("owner", "android")).toBe(canonical);
        }
        expect(h.pool.getDevice(canonical)?.sessionId).toBe("owner");
        expect(h.pool.getAndroidTransportAliases(canonical)).toEqual(usbPresent ? [wireless] : []);
        await h.pool.refreshDevices();
        expect(h.adb.getExecutedCommands()).toHaveLength(callsPerRefresh * 3);
        expect(
          h.adb.getCommandCalls().every((call) => call.noRetry && call.timeoutMs === 2000),
        ).toBe(true);
        expect(h.timer.getSleepHistory()).toEqual([]);
      } finally {
        probe.mockRestore();
      }
    },
  );

  test("a generic-serial USB-only phone remains assignable beside an unrelated wireless phone", async () => {
    const generic = "0123456789ABCDEF";
    const h = harness([booted(generic), booted(wireless)], generic);
    const unrelated = new FakeAdbExecutor();
    unrelated.setCommandResponse("ro.serialno", createExecResult(usb, ""));
    unrelated.setCommandResponse("ro.kernel.qemu", createExecResult("0", ""));
    unrelated.setCommandResponse("boot_id", createExecResult("unrelated-boot", ""));
    const factory = spyOn(h.adbFactory, "create").mockImplementation((target) =>
      target?.deviceId === wireless ? unrelated : h.adb,
    );
    try {
      for (let refresh = 0; refresh < 2; refresh++) {
        await h.pool.refreshDevices();
        expect(h.pool.getAllDevices().map((device) => device.id)).toEqual([generic, wireless]);
        expect(h.pool.getAndroidTransportAliases(generic)).toEqual([]);
        expect(h.pool.getAndroidTransportRouting().resolveTransport(generic)).toBe(generic);
      }
      expect(await h.pool.assignDeviceToSession("owner", "android")).toBe(generic);
      expect(h.adb.getExecutedCommands()).toHaveLength(4);
      expect(unrelated.getExecutedCommands()).toHaveLength(3);
      expect(h.timer.getSleepHistory()).toEqual([]);
    } finally {
      factory.mockRestore();
    }
  });

  test("a failed first probe stays unassignable", async () => {
    const h = harness([booted(wireless)]);
    h.adb.setCommandError("boot_id", new Error("timeout"));
    expect((await h.pool.refreshDevicesWithOutcome()).failure).toBeUndefined();
    expect(h.pool.getAllDevices()).toEqual([]);
    await expect(
      settleWithFakeTime(h.timer, h.pool.assignDeviceToSession("owner", "android"), {
        stepMs: 1000,
        maxSteps: 70,
        description: "unidentified transport refusal",
      }),
    ).rejects.toThrow("No devices in pool");
  });

  test("a superseded discovery returns the newer applied snapshot including iOS", async () => {
    const h = harness([]);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<ReturnType<typeof createExecResult>>();
    const execute = h.adb.execute.bind(h.adb);
    const probe = spyOn(h.adb, "execute").mockImplementationOnce(async () => {
      entered.resolve();
      return release.promise;
    });
    const old = h.pool.normalizeAndroidDiscovery([booted(wireless)]);
    await entered.promise;
    probe.mockImplementation(execute);
    const ios: BootedDevice = { deviceId: "ios", name: "iPhone", platform: "ios" };
    const newer = await h.pool.normalizeAndroidDiscovery([
      booted(usb),
      booted("host-new:5555"),
      ios,
    ]);
    release.resolve(createExecResult(usb, ""));
    await expect(old).resolves.toEqual(newer);
    probe.mockRestore();
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
    expect(h.adb.getExecutedCommands()).toContain("shell getprop ro.serialno");
    expect(h.adb.getExecutedCommands()).toContain(
      avd ? "shell getprop ro.boot.qemu.avd_name" : "shell cat /proc/sys/kernel/random/boot_id",
    );
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

  test("retiring a pool incarnation drops its canonical alias group", async () => {
    const h = harness([booted(usb), booted(wireless)]);
    await h.pool.refreshDevices();
    await h.pool.removeDevice(usb);
    h.adb.setCommandResponse("getprop ro.serialno", createExecResult("OTHER-USB", ""));
    h.manager.setBootedDevices("android", [booted("OTHER-USB"), booted(wireless)]);
    await h.pool.refreshDevices();
    expect(h.pool.getAllDevices().map((device) => device.id)).toEqual(["OTHER-USB"]);
    expect(
      h.adb.getExecutedCommands().filter((command) => command.includes("ro.serialno")),
    ).toHaveLength(4);
  });

  test("distinct durable serials remain distinct without extra getprop reads", async () => {
    const h = harness([booted(usb), booted("OTHER-USB"), booted("emulator-5554", "Pixel")]);
    await h.pool.refreshDevices();
    expect(h.pool.getAllDevices()).toHaveLength(3);
    expect(h.adb.getExecutedCommands()).toEqual([]);
  });

  test.each(["empty serial", "read failure", "remote emulator"])(
    "%s leaves its transport unaliased without failing other platforms",
    async (failure) => {
      const ios: BootedDevice = { deviceId: "ios-device", name: "iPhone", platform: "ios" };
      const h = harness([booted(usb), booted(wireless)], "");
      h.manager.setBootedDevices("ios", [ios]);
      if (failure === "read failure") {
        h.adb.setCommandError("ro.serialno", new Error("identity unavailable"));
      }
      if (failure === "remote emulator") {
        h.adb.setCommandResponse("getprop ro.kernel.qemu", createExecResult("1", ""));
        h.adb.setCommandResponse("getprop ro.boot.qemu.avd_name", createExecResult("Pixel", ""));
      }
      const result = await h.pool.refreshDevicesWithOutcome();
      expect(result.failure).toBeUndefined();
      expect(
        h.pool
          .getAllDevices()
          .map((device) => device.id)
          .sort(),
      ).toEqual([usb, ios.deviceId].sort());
      expect(h.pool.getAndroidTransportAliases(usb)).toEqual([]);
      expect(await h.pool.assignDeviceToSession("owner", "android")).toBe(usb);
      expect(
        (await h.liveness!.takeFreshPresenceDiscovery("android")).devices
          .map((device) => device.deviceId)
          .sort(),
      ).toEqual([usb, wireless].sort());
      expect(h.timer.getSleepHistory()).toEqual([]);
    },
  );

  test("iOS presence discovery preserves Android routing, and a full empty snapshot prunes aliases", async () => {
    const h = harness([booted(usb), booted(wireless)]);
    await h.pool.refreshDevices();
    h.manager.setBootedDevices("android", [booted(wireless)]);
    await h.pool.refreshDevices();
    expect(h.pool.getAndroidTransportRouting().resolveTransport(usb)).toBe(wireless);
    await h.liveness!.takeFreshPresenceDiscovery("ios");
    expect(h.pool.getAndroidTransportRouting().resolveTransport(usb)).toBe(wireless);
    await h.pool.normalizeAndroidDiscovery([]);
    expect(h.pool.getAndroidTransportAliases(usb)).toEqual([]);
    expect(h.pool.getAndroidTransportRouting().resolveTransport(usb)).toBe(usb);
    expect(h.timer.getSleepHistory()).toEqual([]);
  });

  test("failed Android discovery preserves routes and connection evidence", async () => {
    const h = harness([booted(usb), booted(wireless)]);
    await h.pool.refreshDevices();
    h.manager.setBootedDevices("android", [booted(wireless)]);
    await h.pool.refreshDevices();
    const calls = h.adb.getExecutedCommands().length;
    h.manager.setAndroidDiscoveryIncomplete();
    expect((await h.pool.refreshDevicesWithOutcome()).failure).toBeUndefined();
    expect(h.pool.getAndroidTransportRouting().resolveTransport(usb)).toBe(wireless);
    h.manager.failedPlatforms.delete("android");
    await h.pool.refreshDevices();
    expect(h.adb.getExecutedCommands()).toHaveLength(calls);
    expect(h.pool.getAllDevices().map((device) => device.id)).toEqual([usb]);
  });

  test("removing iOS does not supersede Android identity preparation", async () => {
    const h = harness([]);
    const ios: BootedDevice = { deviceId: "ios-device", name: "iPhone", platform: "ios" };
    await h.pool.initializeWithDevices([ios]);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<ReturnType<typeof createExecResult>>();
    const execute = h.adb.execute.bind(h.adb);
    const probe = spyOn(h.adb, "execute").mockImplementationOnce(async () => {
      entered.resolve();
      return release.promise;
    });
    const normalization = h.pool.normalizeAndroidDiscovery([booted(wireless)]);
    await entered.promise;
    await h.pool.removeDevice(ios.deviceId);
    release.resolve(createExecResult(usb, ""));
    probe.mockImplementation(execute);
    await expect(normalization).resolves.toEqual([booted(wireless)]);
    probe.mockRestore();
    expect(h.timer.getSleepHistory()).toEqual([]);
  });
});

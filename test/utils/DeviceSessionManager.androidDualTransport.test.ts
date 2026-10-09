import { afterEach, describe, expect, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DeviceSessionManager } from "../../src/devices/DeviceSessionManager";
import type { BootedDevice } from "../../src/models";
import {
  AdbClient,
  resetAdbDeviceListCache,
} from "../../src/utils/android-cmdline-tools/AdbClient";
import { createExecResult } from "../../src/utils/execResult";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDeviceClientProvider } from "../fakes/FakeDeviceClientProvider";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeWindow } from "../fakes/FakeWindow";

// A phone reachable over USB and wireless adb at once (#11133).
const USB = "R58N12ABCDE";
const WIFI = "192.168.1.42:41234";
const USB_ROW = `${USB}            device usb:1-1 product:a54xeea model:SM_A546B device:a54x transport_id:3`;
const WIFI_ROW = `${WIFI}     device product:a54xeea model:SM_A546B device:a54x transport_id:4`;
const listing = (...rows: string[]) => ["List of devices attached", ...rows, ""].join("\n");

const timers: FakeTimer[] = [];
afterEach(() => {
  timers.splice(0).forEach((timer) => timer.reset());
  resetAdbDeviceListCache();
});

function harness() {
  const timer = new FakeTimer();
  timers.push(timer);
  let devicesOutput = listing(USB_ROW, WIFI_ROW);
  const dispatched: string[][] = [];
  const pool = { current: undefined as DevicePool | undefined };
  const client = (device: BootedDevice | null) =>
    new AdbClient(
      device,
      async (_file: string, args: string[], _maxBuffer?: number) => {
        if (args.includes("devices")) {
          return createExecResult(devicesOutput, "");
        }
        dispatched.push(args);
        return createExecResult("", "");
      },
      null,
      new DefaultRetryExecutor(timer),
      timer,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      pool.current?.getAndroidTransportRouting(),
    );
  const probe = new FakeAdbExecutor();
  probe.setCommandResponse("getprop ro.serialno", createExecResult(USB, ""));
  probe.setCommandResponse("getprop ro.kernel.qemu", createExecResult("0", ""));
  probe.setCommandResponse("boot_id", createExecResult("phone-boot", ""));
  const discovery = new FakeDeviceUtils();
  pool.current = new DevicePool(
    createDevicePoolDependencies(
      new SessionManager(timer, new FakeDeviceSessionPersistence()),
      "dual-transport",
      {
        timer,
        deviceManager: discovery,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        androidAdbFactory: new FakeAdbClientFactory(probe),
      },
    ),
  );
  const scan = async () => {
    resetAdbDeviceListCache();
    return await client(null).getBootedAndroidDevices({ bypassCache: true });
  };
  return {
    timer,
    pool: pool.current,
    client,
    dispatched,
    discovery,
    scan,
    unplugUsb: () => {
      devicesOutput = listing(WIFI_ROW);
      resetAdbDeviceListCache();
    },
  };
}

describe("Android dual-transport readiness (#11133)", () => {
  test("a held USB+Wi-Fi session stays ready after USB unplug and dispatches over Wi-Fi", async () => {
    const h = harness();
    h.discovery.setBootedDevices("android", await h.scan());
    await h.pool.refreshDevices();
    expect(h.pool.getAndroidTransportAliases(USB)).toEqual([WIFI]);
    expect(await h.pool.assignDeviceToSession("owner", "android")).toBe(USB);

    h.unplugUsb();
    const window = new FakeWindow();
    window.configureActiveWindow({ appId: "com.example", activityName: "Main", layoutSeqSum: 0 });
    const adb = h.client(null);
    const manager = DeviceSessionManager.createInstance(
      new FakeDeviceClientProvider(adb, new FakeDeviceUtils(), undefined, { window }),
      { create: (device) => h.client(device ?? null) },
      {
        admissionGate: h.pool,
        executionBinding: { bindDeviceExecution: () => {} },
        appearanceOnConnectDependencies: { isSyncEnabled: () => false },
        runnerReadinessTimer: h.timer,
      },
    );

    const scan = await manager.detectConnectedPlatformsWithStatus(undefined, {
      platform: "android",
    });
    expect(scan.devices.map((device) => device.deviceId)).toEqual([USB]);
    const ready = await manager.ensureDeviceReady("android", USB, { readiness: "booted" });
    expect(ready.deviceId).toBe(USB);
    expect(window.getCallCount("getActive")).toBe(1);

    await h
      .client({ deviceId: USB, name: USB, platform: "android" })
      .execute(["shell", "input", "tap", "1", "2"]);
    expect(h.dispatched.at(-1)).toEqual(["-s", WIFI, "shell", "input", "tap", "1", "2"]);
    expect(h.timer.getSleepHistory()).toEqual([]);
  });
});

describe("Android dual-transport readiness by alias id (#11133)", () => {
  test.each([
    ["both transports attached", false, USB],
    ["USB unplugged", true, WIFI],
  ])(
    "%s: a caller naming the Wi-Fi alias resolves to the canonical USB id",
    async (_label, unplug, liveTransport) => {
      const h = harness();
      h.discovery.setBootedDevices("android", await h.scan());
      await h.pool.refreshDevices();
      expect(await h.pool.assignDeviceToSession("owner", "android")).toBe(USB);
      if (unplug) {
        h.unplugUsb();
      }
      const window = new FakeWindow();
      window.configureActiveWindow({ appId: "com.example", activityName: "Main", layoutSeqSum: 0 });
      const manager = DeviceSessionManager.createInstance(
        new FakeDeviceClientProvider(h.client(null), new FakeDeviceUtils(), undefined, { window }),
        { create: (device) => h.client(device ?? null) },
        {
          admissionGate: h.pool,
          executionBinding: { bindDeviceExecution: () => {} },
          appearanceOnConnectDependencies: { isSyncEnabled: () => false },
          runnerReadinessTimer: h.timer,
        },
      );

      const ready = await manager.ensureDeviceReady("android", WIFI, { readiness: "booted" });
      expect(ready.deviceId).toBe(USB);
      await h.client(ready).execute(["shell", "input", "tap", "1", "2"]);
      expect(h.dispatched.at(-1)).toEqual(["-s", liveTransport, "shell", "input", "tap", "1", "2"]);
      expect(h.timer.getSleepHistory()).toEqual([]);
    },
  );
});

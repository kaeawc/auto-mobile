import { DeviceIdentityQuarantinedError } from "../../src/models/DeviceIdentityQuarantinedError";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  defaultAdbClientFactory,
  unadmittedAdbClientFactory,
} from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android/AndroidCtrlProxyClient";
import { ListInstalledApps } from "../../src/features/observe/ListInstalledApps";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DaemonState } from "../../src/daemon/daemonState";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import {
  DefaultDeviceClientProvider,
  DeviceSessionManager,
} from "../../src/devices/DeviceSessionManager";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeDeviceClientProvider } from "../fakes/FakeDeviceClientProvider";
import { FakeWindow } from "../fakes/FakeWindow";
import { FakeDeviceExecutionBinding } from "../fakes/FakeDeviceExecutionBinding";
import { permissiveDeviceAdmissionGate } from "../../src/daemon/deviceAdmissionGate";
import type { BootedDevice } from "../../src/models";
import { AdbClient } from "../../src/utils/android-cmdline-tools/AdbClient";
import { createExecResult } from "../../src/utils/execResult";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";

/**
 * FUNNEL 2 at the seam, rather than at each entry point.
 *
 * Binding a serial to a device client is the single act every Android
 * device-addressed operation performs — an MCP tool call with a session and one
 * without, with autolock on or off; a resource read; a stream, recording or
 * storage subscription; each target an all-device fan-out expands to. Four
 * review rounds of gating entry points one at a time each found another route
 * that reached a device without crossing the one just gated, so the gate moved
 * to the seam they all cross
 * ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
 */
describe("device-client admission seam", () => {
  const SERIAL = "emulator-5554";
  const DEVICE: BootedDevice = { deviceId: SERIAL, name: "Pixel_8_API_35", platform: "android" };

  afterEach(() => {
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
    AndroidCtrlProxyClient.resetInstances();
  });

  async function quarantinedPool(): Promise<DevicePool> {
    const timer = new FakeTimer();
    const manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const utils = new FakeDeviceUtils();
    utils.setBootedDevices("android", [DEVICE]);
    const pool = new DevicePool(
      createDevicePoolDependencies(manager, "daemon-test", { timer: timer, deviceManager: utils }),
    );
    await pool.initializeWithDevices([DEVICE]);
    DaemonState.getInstance().initialize(manager, pool);
    await pool.reconcileDiscoveryObservation(
      [{ deviceId: SERIAL, name: `Unknown (${SERIAL})`, platform: "android" }],
      "test",
    );
    expect(pool.isPooledIdentityUnresolved(SERIAL)).toBe(true);
    return pool;
  }

  test.each(["raw", "equal"] as const)(
    "refuses %s-identity readiness before a cached Window executes",
    async (identity) => {
      const adb = new FakeAdbExecutor();
      adb.setDevices([{ ...DEVICE, name: SERIAL }]);
      const provider = new DefaultDeviceClientProvider(new FakeAdbClientFactory(adb));
      const cached = provider.getWindow(DEVICE);
      const active = spyOn(cached, "getActive").mockResolvedValue({
        appId: "com.example.app",
        activityName: "MainActivity",
        layoutSeqSum: 0,
      });
      try {
        const manager = DeviceSessionManager.createInstance(provider);
        await manager.verifyAndroidDevice(SERIAL, { readiness: "booted" }, DEVICE);
        expect(active).toHaveBeenCalledTimes(1);
        await quarantinedPool();
        await expect(
          manager.verifyAndroidDevice(
            SERIAL,
            { readiness: "booted" },
            identity === "equal" ? DEVICE : undefined,
          ),
        ).rejects.toThrow(/Refusing to verify Android device readiness on device 'emulator-5554'/);
        expect(active).toHaveBeenCalledTimes(1);
      } finally {
        active.mockRestore();
      }
    },
  );

  test.each(["provided", "current", "existing"] as const)(
    "refuses the %s-device readiness route before using the retained Window",
    async (route) => {
      const adb = new FakeAdbExecutor();
      adb.setDevices([DEVICE]);
      const utils = new FakeDeviceUtils();
      utils.setBootedDevices("android", [DEVICE]);
      const window = new FakeWindow();
      window.configureActiveWindow({ appId: "com.example", activityName: "Main", layoutSeqSum: 0 });
      const provider = new FakeDeviceClientProvider(adb, utils, undefined, { window });
      const manager = DeviceSessionManager.createInstance(provider, new FakeAdbClientFactory(adb));
      await manager.verifyAndroidDevice(SERIAL, { readiness: "booted" });
      if (route === "current") {
        manager.setCurrentDevice(DEVICE, "android");
      }
      await quarantinedPool();
      const ready =
        route === "existing"
          ? manager.findOrStartAndroidDevice({ readiness: "booted" })
          : manager.ensureDeviceReady("android", route === "provided" ? SERIAL : undefined, {
              readiness: "booted",
            });
      await expect(ready).rejects.toThrow("Refusing to verify Android device readiness");
      expect(window.getCallCount("getActive")).toBe(1);
    },
  );

  test("current quarantine refusal preserves selection and never discovers a replacement", async () => {
    const refusal = new DeviceIdentityQuarantinedError("identity unresolved");
    const manager = DeviceSessionManager.createInstance(
      new FakeDeviceClientProvider(),
      new FakeAdbClientFactory(),
      {
        admissionGate: {
          assertDeviceActionable: () => {
            throw refusal;
          },
        },
      },
    );
    manager.setCurrentDevice(DEVICE, "android");
    const discovery = spyOn(manager, "findOrStartDevice").mockResolvedValue({
      ...DEVICE,
      deviceId: "emulator-5556",
    });
    try {
      await expect(
        manager.ensureDeviceReady("android", undefined, { readiness: "booted" }),
      ).rejects.toBe(refusal);
      expect(discovery).not.toHaveBeenCalled();
      expect(manager.getCurrentDevice()).toBe(DEVICE);
      expect(manager.getCurrentPlatform()).toBe("android");
    } finally {
      discovery.mockRestore();
    }
  });

  test("readiness binds the ambient execution even when its Window is already cached", async () => {
    const adb = new FakeAdbExecutor();
    adb.setDevices([DEVICE]);
    const window = new FakeWindow();
    window.configureActiveWindow({ appId: "com.example", activityName: "Main", layoutSeqSum: 0 });
    const binding = new FakeDeviceExecutionBinding();
    const manager = DeviceSessionManager.createInstance(
      new FakeDeviceClientProvider(adb, new FakeDeviceUtils(), undefined, { window }),
      new FakeAdbClientFactory(adb),
      { admissionGate: permissiveDeviceAdmissionGate, executionBinding: binding },
    );
    await manager.verifyAndroidDevice(SERIAL, { readiness: "booted" });
    expect(binding.deviceIds).toEqual([SERIAL]);
  });

  test("refuses to bind an adb client to a quarantined serial", async () => {
    await quarantinedPool();

    expect(() => defaultAdbClientFactory.create(DEVICE)).toThrow(
      /Refusing to run an adb command on device 'emulator-5554'/,
    );
  });

  test("refuses to bind a CtrlProxy client to a quarantined serial", async () => {
    await quarantinedPool();

    expect(() => AndroidCtrlProxyClient.getInstance(DEVICE)).toThrow(
      /Refusing to drive the device through CtrlProxy on device 'emulator-5554'/,
    );
  });

  // The pool's own identity, lifecycle and teardown machinery is BELOW the gate:
  // reading the AVD name on a quarantined serial is the only event that can lift
  // the quarantine, and `emu kill` is how the pool settles a serial it can no
  // longer identify.
  test("still binds the unadmitted client the quarantine's own machinery uses", async () => {
    await quarantinedPool();

    expect(() => unadmittedAdbClientFactory.create(DEVICE)).not.toThrow();
  });

  // The shape a SESSIONLESS MCP tool call has once its device is resolved:
  // `toolRegistry`'s legacy branch (no sessionUuid, or autolock disabled) hands
  // the tool a plain `BootedDevice` and neither the session-keyed gate nor the
  // autolock check runs. The feature's own construction crosses the seam, so the
  // refusal happens before any command reaches the device.
  test("refuses a device-addressed feature built for a quarantined serial", async () => {
    await quarantinedPool();

    expect(() => new ListInstalledApps(DEVICE)).toThrow(
      /Refusing to run an adb command on device 'emulator-5554'/,
    );
  });

  test("admits a serial whose pooled identity is resolved", async () => {
    const pool = await quarantinedPool();
    await pool.reconcileDiscoveryObservation([DEVICE], "test:lift");
    expect(pool.isPooledIdentityUnresolved(SERIAL)).toBe(false);

    expect(() => defaultAdbClientFactory.create(DEVICE)).not.toThrow();
  });

  test("admits a device-independent client, which names no serial", async () => {
    await quarantinedPool();

    expect(() => defaultAdbClientFactory.create()).not.toThrow();
    expect(() => defaultAdbClientFactory.create(null)).not.toThrow();
  });

  // Direct mode (--no-proxy) has no daemon and therefore no pool, so nothing
  // holds the cross-call identity state a quarantine is a statement about.
  test("admits everything in direct mode", () => {
    expect(DaemonState.getInstance().isInitialized()).toBe(false);

    expect(() => defaultAdbClientFactory.create(DEVICE)).not.toThrow();
  });

  test("default factory clients follow the published pool's live alias and reset to direct routing", async () => {
    const timer = new FakeTimer();
    const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const device: BootedDevice = { deviceId: "USB-SERIAL", name: "Phone", platform: "android" };
    const alias = { ...device, deviceId: "192.168.1.20:5555" };
    const utils = new FakeDeviceUtils();
    utils.setBootedDevices("android", [device, alias]);
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("ro.serialno", createExecResult(device.deviceId, ""));
    adb.setCommandResponse("ro.kernel.qemu", createExecResult("0", ""));
    const pool = new DevicePool(
      createDevicePoolDependencies(sessions, "alias-daemon", {
        timer,
        deviceManager: utils,
        androidAdbFactory: new FakeAdbClientFactory(adb),
        installedAppsRepository: new FakeInstalledAppsRepository(),
      }),
    );
    await pool.refreshDevices();
    DaemonState.getInstance().initialize(sessions, pool);
    const previousTestMode = process.env.AUTOMOBILE_TEST_MODE;
    process.env.AUTOMOBILE_TEST_MODE = "true";
    const client = (() => {
      try {
        return defaultAdbClientFactory.create(device);
      } finally {
        if (previousTestMode === undefined) {
          delete process.env.AUTOMOBILE_TEST_MODE;
        } else {
          process.env.AUTOMOBILE_TEST_MODE = previousTestMode;
        }
      }
    })();
    if (!(client instanceof AdbClient)) {
      throw new Error("Expected the default AdbClient");
    }
    const calls: string[][] = [];
    const exec = spyOn(client, "execAsync").mockImplementation(async (_file, args) => {
      calls.push(args);
      return createExecResult("", "");
    });
    try {
      await client.execute(["shell", "echo", "before"], { noRetry: true });
      utils.setBootedDevices("android", [alias]);
      await pool.refreshDevices();
      await client.execute(["forward", "tcp:1234", "tcp:7001"], { noRetry: true });
      DaemonState.getInstance().reset();
      await client.execute(["shell", "echo", "direct"], { noRetry: true });
      expect(calls).toEqual([
        ["-s", device.deviceId, "shell", "echo", "before"],
        ["-s", alias.deviceId, "forward", "tcp:1234", "tcp:7001"],
        ["-s", device.deviceId, "shell", "echo", "direct"],
      ]);
    } finally {
      exec.mockRestore();
      timer.reset();
    }
  });
});

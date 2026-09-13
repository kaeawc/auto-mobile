import { afterEach, describe, expect, test } from "bun:test";
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
import type { BootedDevice } from "../../src/models";

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
    const pool = new DevicePool(manager, "daemon-test", timer, undefined, utils);
    await pool.initializeWithDevices([DEVICE]);
    DaemonState.getInstance().initialize(manager, pool);
    await pool.reconcileDiscoveryObservation(
      [{ deviceId: SERIAL, name: `Unknown (${SERIAL})`, platform: "android" }],
      "test",
    );
    expect(pool.isPooledIdentityUnresolved(SERIAL)).toBe(true);
    return pool;
  }

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
});

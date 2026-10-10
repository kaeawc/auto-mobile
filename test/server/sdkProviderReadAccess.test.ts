import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DevicePool } from "../../src/daemon/devicePool";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { BootedDevice } from "../../src/models";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import { buildDeviceLabelMap } from "../../src/server/deviceLabelMapping";
import { isNonOwnerReaderOfHeldDevice } from "../../src/server/sdkProviderReadAccess";

describe("isNonOwnerReaderOfHeldDevice (#11350)", () => {
  const device: BootedDevice = { name: "Pixel A", deviceId: "emulator-5554", platform: "android" };
  let sessionManager: SessionManager;

  beforeEach(async () => {
    const timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const deviceUtils = new FakeDeviceUtils();
    deviceUtils.setBootedDevices("android", [device]);
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "daemon-session", {
        timer,
        deviceManager: deviceUtils,
      }),
    );
    await pool.initializeWithDevices([device]);
    DaemonState.getInstance().initialize(sessionManager, pool);
  });

  afterEach(() => {
    DaemonState.getInstance().reset();
    sessionManager.stopCleanupTimer();
  });

  const readAs = (routingSessionUuid: string) =>
    runWithToolSelectionContext({ routingSessionUuid }, async () =>
      isNonOwnerReaderOfHeldDevice(device.deviceId),
    );

  test("a free device has no non-owner reader", () => {
    expect(isNonOwnerReaderOfHeldDevice(device.deviceId)).toBe(false);
  });

  test("a sessionless reader of a held device is a non-owner", async () => {
    await sessionManager.createSession("holder", device.deviceId, "android");
    expect(isNonOwnerReaderOfHeldDevice(device.deviceId)).toBe(true);
  });

  test("another session reading a held device is a non-owner", async () => {
    await sessionManager.createSession("holder", device.deviceId, "android");
    expect(await readAs("watcher")).toBe(true);
  });

  test("the holder and its derived label session are owners", async () => {
    await sessionManager.createSession("holder", device.deviceId, "android");
    expect(await readAs("holder")).toBe(false);
  });

  test("a derived label session of the holder is an owner", async () => {
    await sessionManager.createSession("holder", device.deviceId, "android");
    sessionManager.setDeviceLabels("holder", buildDeviceLabelMap(["A", "B"], "holder"));
    expect(await readAs("holder:B")).toBe(false);
  });

  test("a managed slot's execution session, which holds its device, is an owner", async () => {
    const slotExecution = "slot-exec-0123abcd";
    await sessionManager.createSession(slotExecution, device.deviceId, "android");
    expect(await readAs(slotExecution)).toBe(false);
    expect(await readAs("someone-else")).toBe(true);
  });

  test("a resource read is recognised by its connection's bound session", async () => {
    await sessionManager.createSession("holder", device.deviceId, "android");
    expect(isNonOwnerReaderOfHeldDevice(device.deviceId, { sessionUuid: "holder" })).toBe(false);
    expect(isNonOwnerReaderOfHeldDevice(device.deviceId, { sessionUuid: "watcher" })).toBe(true);
  });

  test("a resource read is recognised by connection ownership of the holder session", async () => {
    await sessionManager.createSession("holder", device.deviceId, "android");
    const owns = (uuid: string) => uuid === "holder";
    expect(isNonOwnerReaderOfHeldDevice(device.deviceId, { ownsSession: owns })).toBe(false);
    expect(isNonOwnerReaderOfHeldDevice(device.deviceId, { ownsSession: () => false })).toBe(true);
  });

  test("an uninitialized daemon keeps today's behaviour", () => {
    DaemonState.getInstance().reset();
    expect(isNonOwnerReaderOfHeldDevice(device.deviceId)).toBe(false);
  });
});

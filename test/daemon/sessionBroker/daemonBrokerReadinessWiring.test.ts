import { describe, expect, mock, test } from "bun:test";
import { sessionBrokerAndroidResetPorts } from "../../../src/daemon/daemonCore/DaemonBroker";
import type { DeviceReadiness } from "../../../src/daemon/readiness/DeviceReadiness";
import type { BootedDevice } from "../../../src/models/DeviceInfo";

const androidDevice: BootedDevice = {
  name: "Pixel_API_35",
  deviceId: "emulator-5554",
  platform: "android",
};

describe("DaemonBroker Android reset readiness wiring", () => {
  test("delegates inventory and CtrlProxy checks through the lazy readiness accessor", async () => {
    const inventory = mock(async () => [androidDevice]);
    const ctrlProxyReady = mock(async () => true);
    const readiness = {
      listBootedAndroidDevices: inventory,
      verifyAndroidCtrlProxyServiceReady: ctrlProxyReady,
      readAndroidCtrlProxySnapshotIdentity: mock(async () => "ctrlproxy-sha256"),
      verifyDevice: mock(async () => {}),
    } satisfies Pick<
      DeviceReadiness,
      | "listBootedAndroidDevices"
      | "verifyAndroidCtrlProxyServiceReady"
      | "readAndroidCtrlProxySnapshotIdentity"
      | "verifyDevice"
    >;
    const getReadiness = mock(() => readiness);
    const ports = sessionBrokerAndroidResetPorts(getReadiness);
    const signal = new AbortController().signal;

    await expect(ports.inventory({ signal, timeoutMs: 847 })).resolves.toEqual([androidDevice]);
    await expect(
      ports.ctrlProxyReady(androidDevice, { signal, timeoutMs: 847, noRetry: true }),
    ).resolves.toBe(true);
    expect(getReadiness).toHaveBeenCalledTimes(2);
    expect(inventory).toHaveBeenCalledWith({ signal, timeoutMs: 847 });
    expect(ctrlProxyReady).toHaveBeenCalledWith(androidDevice, {
      signal,
      timeoutMs: 847,
      noRetry: true,
    });
    await expect(ports.snapshot!.ctrlProxyIdentity(androidDevice, signal)).resolves.toBe(
      "ctrlproxy-sha256",
    );
    const assertOwned = mock(async () => {});
    await ports.snapshot!.ready(androidDevice, { signal, timeoutMs: 847, assertOwned });
    expect(readiness.verifyDevice).toHaveBeenCalledWith(
      androidDevice.deviceId,
      "android",
      { signal, readiness: "automationReady" },
      androidDevice,
    );
    expect(assertOwned).toHaveBeenCalledTimes(2);
  });
});

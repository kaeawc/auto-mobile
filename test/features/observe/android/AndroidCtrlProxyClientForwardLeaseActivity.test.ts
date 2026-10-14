import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android";
import type { BootedDevice } from "../../../../src/models";
import { installFakeCtrlProxyManagers } from "../../../helpers/hermeticDeviceTools";
import type { CtrlProxyForwardLease } from "../../../../src/features/observe/android/CtrlProxyForwardLease";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { PortManager } from "../../../../src/utils/PortManager";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { DeviceForwardLeaseIdleReleaser } from "../../../../src/daemon/deviceForwardLeaseIdleReleaser";
import { readDeviceLeaseActivity } from "../../../../src/daemon/deviceLeaseActivity";
import { FakeWebSocket } from "../../../fakes/FakeWebSocket";

const DEVICE: BootedDevice = { deviceId: "emulator-5600", name: "Pixel", platform: "android" };

class HeldLease implements CtrlProxyForwardLease {
  constructor(private readonly acquiredAt: number) {}
  tryAcquire(): boolean {
    return true;
  }
  release(): void {}
  getLastOwnerPid(): undefined {
    return undefined;
  }
  isHeld(): boolean {
    return true;
  }
  getAcquiredAt(): number {
    return this.acquiredAt;
  }
}

describe("AndroidCtrlProxyClient forwarding-lease activity (#10497 review)", () => {
  let timer: FakeTimer;
  let restoreManagers: () => void;

  beforeEach(() => {
    PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
    timer = new FakeTimer();
    timer.setCurrentTime(1_000);
    restoreManagers = installFakeCtrlProxyManagers();
  });

  afterEach(async () => {
    await AndroidCtrlProxyClient.getExistingInstance(DEVICE.deviceId)?.close();
    restoreManagers();
    AndroidCtrlProxyClient.clearInstanceRegistryForTesting();
    expect(AndroidCtrlProxyClient.getExistingInstance(DEVICE.deviceId)).toBeNull();
    PortManager.reset();
    expect(PortManager.getAllocations().size).toBe(0);
    PortManager.setPortAvailabilityCheckerForTesting(null);
  });

  test("counts every CtrlProxy request, not just tool calls, and floors idleness at lease acquisition", async () => {
    const client = AndroidCtrlProxyClient.createForTesting(
      DEVICE,
      new FakeAdbExecutor(),
      (url) => new FakeWebSocket(url, "none", 0, timer),
      timer,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new HeldLease(1_000),
    );
    AndroidCtrlProxyClient.registerForTesting(client, DEVICE.deviceId);
    expect(AndroidCtrlProxyClient.getForwardLeaseHeldDeviceIds()).toEqual([DEVICE.deviceId]);

    timer.setCurrentTime(6_000);
    expect(AndroidCtrlProxyClient.getForwardLeaseActivity(DEVICE.deviceId, timer)).toEqual({
      inFlightRequests: 0,
      idleForMs: 5_000,
    });

    // e.g. an MCP resource read or initial observation frame: no tool call is bound.
    const requests = client["requestManager"];
    const pending = requests.register("read-1", "storage_read", 30_000, () => null);
    timer.setCurrentTime(7_000);
    expect(AndroidCtrlProxyClient.getForwardLeaseActivity(DEVICE.deviceId, timer)).toEqual({
      inFlightRequests: 1,
      idleForMs: 1_000,
    });

    timer.setCurrentTime(8_000);
    requests.resolve("read-1", { success: true });
    await pending;
    timer.setCurrentTime(10_000);
    expect(AndroidCtrlProxyClient.getForwardLeaseActivity(DEVICE.deviceId, timer)).toEqual({
      inFlightRequests: 0,
      idleForMs: 2_000,
    });
  });

  test("reports no activity for a device this process never used", () => {
    expect(AndroidCtrlProxyClient.getForwardLeaseActivity("emulator-9999", timer)).toEqual({
      inFlightRequests: 0,
      idleForMs: null,
    });
  });

  test("readiness holds keep the idle releaser and lease status busy until idempotent release", async () => {
    const timer = new FakeTimer();
    PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
    const client = AndroidCtrlProxyClient.createForTesting(
      DEVICE,
      new FakeAdbExecutor(),
      (url) => new FakeWebSocket(url, "none", 0, timer),
      timer,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new HeldLease(0),
    );
    AndroidCtrlProxyClient.registerForTesting(client, DEVICE.deviceId);
    try {
      const activity = (deviceId: string) =>
        readDeviceLeaseActivity(
          {
            sessionForDevice: () => null,
            activeExecutionCount: () => 0,
            toolIdleForMs: () => null,
            hasStreamSubscriber: () => false,
            clientActivity: (id) => AndroidCtrlProxyClient.getForwardLeaseActivity(id, timer),
          },
          deviceId,
        );
      const releaser = new DeviceForwardLeaseIdleReleaser(
        {
          heldDeviceIds: () => AndroidCtrlProxyClient.getForwardLeaseHeldDeviceIds(),
          activity,
          release: (id) => AndroidCtrlProxyClient.releaseIdleForwardLease(id),
        },
        60_000,
        timer,
      );
      await releaser.sweep();
      timer.advanceTime(60_000);
      const release = client.beginReadinessHold();
      const releaseSecond = client.beginReadinessHold();
      expect(activity(DEVICE.deviceId).inFlightRequests).toBe(2);
      expect(await releaser.sweep()).toEqual([]);
      release();
      release();
      expect(activity(DEVICE.deviceId).inFlightRequests).toBe(1);
      releaseSecond();
      expect(activity(DEVICE.deviceId).inFlightRequests).toBe(0);
      timer.advanceTime(60_000);
      expect(await releaser.sweep()).toEqual([DEVICE.deviceId]);
    } finally {
      await client.close();
      AndroidCtrlProxyClient.clearInstanceRegistryForTesting();
      expect(AndroidCtrlProxyClient.getExistingInstance(DEVICE.deviceId)).toBeNull();
      PortManager.reset();
      expect(PortManager.getAllocations().size).toBe(0);
      PortManager.setPortAvailabilityCheckerForTesting(null);
    }
  });
});

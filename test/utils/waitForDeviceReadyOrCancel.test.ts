import { describe, it, expect } from "bun:test";
import { ChildProcess } from "child_process";
import { waitForDeviceReadyOrCancel } from "../../src/utils/deviceUtils";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import type { DeviceInfo } from "../../src/models";

/**
 * Unit coverage for the cancel-on-readiness-failure helper (issue #3952).
 *
 * The helper must:
 *  - pass the device through on success without touching the handle,
 *  - kill the handle and re-throw when readiness fails, and
 *  - leave a null (adopted-device) handle alone while still re-throwing.
 */
describe("waitForDeviceReadyOrCancel", () => {
  const iosImage: DeviceInfo = {
    name: "iPhone 15",
    platform: "ios",
    deviceId: "ABCD-1234",
    isRunning: false,
    osVersion: "17.2",
  };

  /** A spy handle recording whether kill() was invoked. */
  function spyHandle(): { handle: ChildProcess; killed: () => boolean } {
    let wasKilled = false;
    const handle = {
      pid: undefined,
      kill: (): boolean => {
        wasKilled = true;
        return true;
      },
      killed: false,
      connected: false,
      exitCode: 0,
      signalCode: null,
    } as unknown as ChildProcess;
    return { handle, killed: () => wasKilled };
  }

  it("returns the ready device and does not kill the handle on success", async () => {
    const deviceManager = new FakeDeviceUtils();
    const { handle, killed } = spyHandle();

    const ready = await waitForDeviceReadyOrCancel(deviceManager, iosImage, handle, 30_000);

    expect(ready.deviceId).toBe("ABCD-1234");
    expect(killed()).toBe(false);
  });

  it("kills the handle and re-throws when readiness fails", async () => {
    const deviceManager = new FakeDeviceUtils();
    const failure = new Error("Simulator with UDID ABCD-1234 failed to become ready");
    deviceManager.setWaitForDeviceReadyError(failure);
    const { handle, killed } = spyHandle();

    await expect(
      waitForDeviceReadyOrCancel(deviceManager, iosImage, handle, 30_000),
    ).rejects.toThrow("failed to become ready");
    expect(killed()).toBe(true);
  });

  it("does not throw on a null (adopted-device) handle but still re-throws the failure", async () => {
    const deviceManager = new FakeDeviceUtils();
    const failure = new Error("readiness timeout");
    deviceManager.setWaitForDeviceReadyError(failure);

    await expect(
      waitForDeviceReadyOrCancel(deviceManager, iosImage, null, 30_000),
    ).rejects.toThrow("readiness timeout");
  });

  it("kills an owned handle when external cancellation preempts non-cooperative readiness", async () => {
    const deviceManager = new FakeDeviceUtils();
    const controller = new AbortController();
    const { handle, killed } = spyHandle();
    let resolveReadiness!: () => void;
    const pendingReadiness = new Promise<void>(resolve => {
      resolveReadiness = resolve;
    });
    deviceManager.waitForDeviceReady = async () => {
      await pendingReadiness;
      return {
        name: iosImage.name,
        platform: "ios",
        deviceId: iosImage.deviceId!,
      };
    };

    const readiness = waitForDeviceReadyOrCancel(
      deviceManager,
      iosImage,
      handle,
      30_000,
      controller.signal,
    );
    controller.abort();

    await expect(readiness).rejects.toThrow();
    expect(killed()).toBe(true);
    resolveReadiness();
  });

  it("does not touch an adopted device when external cancellation preempts readiness", async () => {
    const deviceManager = new FakeDeviceUtils();
    const controller = new AbortController();
    let resolveReadiness!: () => void;
    const pendingReadiness = new Promise<void>(resolve => {
      resolveReadiness = resolve;
    });
    deviceManager.waitForDeviceReady = async () => {
      await pendingReadiness;
      return {
        name: iosImage.name,
        platform: "ios",
        deviceId: iosImage.deviceId!,
      };
    };

    const readiness = waitForDeviceReadyOrCancel(
      deviceManager,
      iosImage,
      null,
      30_000,
      controller.signal,
    );
    controller.abort();

    await expect(readiness).rejects.toThrow();
    resolveReadiness();
  });
});

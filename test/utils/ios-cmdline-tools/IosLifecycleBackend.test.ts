import { describe, expect, test } from "bun:test";
import type { BootedDevice, DeviceInfo } from "../../../src/models";
import { ActionableError } from "../../../src/models";
import {
  PhysicalIosLifecycleBackend,
  SimulatorIosLifecycleBackend,
  resolveIosLifecycleBackend,
  type IosLifecycleBackendDeps,
} from "../../../src/utils/ios-cmdline-tools/IosLifecycleBackend";

const simulatorUdid = "A1B2C3D4-E5F6-7890-ABCD-EF1234567890";
const physicalUdid = "00008030-001C2D3E1234567A";

type LifecycleSimctl = IosLifecycleBackendDeps["simctl"];

class FakeLifecycleSimctl implements LifecycleSimctl {
  readonly kills: Array<{
    device: BootedDevice;
    options?: { timeoutMs?: number; signal?: AbortSignal };
  }> = [];
  readonly waits: Array<{
    udid: string;
    timeoutMs?: number;
    options?: { assumeBooted?: boolean };
  }> = [];

  async killSimulator(
    device: BootedDevice,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<void> {
    this.kills.push({ device, options });
  }

  async waitForSimulatorReady(
    udid: string,
    timeoutMs?: number,
    options?: { assumeBooted?: boolean },
  ): Promise<BootedDevice> {
    this.waits.push({ udid, timeoutMs, options });
    return { name: "Sim", platform: "ios", deviceId: udid };
  }
}

function iosDevice(deviceId: string): DeviceInfo & { deviceId: string } {
  return { name: "iPhone", platform: "ios", deviceId, isRunning: true, source: "local" };
}

describe("resolveIosLifecycleBackend", () => {
  test("selects the physical backend only for a positively physical UDID", () => {
    const deps = { simctl: new FakeLifecycleSimctl() };
    expect(resolveIosLifecycleBackend(physicalUdid, deps).kind).toBe("physical");
    expect(resolveIosLifecycleBackend(simulatorUdid, deps).kind).toBe("simulator");
    // Unrecognized or missing IDs keep the pre-existing simctl behaviour.
    expect(resolveIosLifecycleBackend("not-a-udid", deps).kind).toBe("simulator");
    expect(resolveIosLifecycleBackend(undefined, deps).kind).toBe("simulator");
    expect(resolveIosLifecycleBackend("", deps).kind).toBe("simulator");
  });
});

describe("SimulatorIosLifecycleBackend", () => {
  test("shutdown forwards the device and options to simctl", async () => {
    const simctl = new FakeLifecycleSimctl();
    const controller = new AbortController();
    const device: BootedDevice = { name: "Sim", platform: "ios", deviceId: simulatorUdid };

    await new SimulatorIosLifecycleBackend(simctl).shutdown(device, {
      timeoutMs: 1234,
      signal: controller.signal,
    });

    expect(simctl.kills).toEqual([
      { device, options: { timeoutMs: 1234, signal: controller.signal } },
    ]);
  });

  test("waitForReady forwards udid, timeout and assumeBooted to simctl", async () => {
    const simctl = new FakeLifecycleSimctl();

    const booted = await new SimulatorIosLifecycleBackend(simctl).waitForReady(
      iosDevice(simulatorUdid),
      5000,
      { assumeBooted: true },
    );

    expect(simctl.waits).toEqual([
      { udid: simulatorUdid, timeoutMs: 5000, options: { assumeBooted: true } },
    ]);
    expect(booted.deviceId).toBe(simulatorUdid);
  });
});

describe("PhysicalIosLifecycleBackend", () => {
  test("shutdown refuses with an actionable error", async () => {
    const device: BootedDevice = { name: "iPhone", platform: "ios", deviceId: physicalUdid };
    const shutdown = new PhysicalIosLifecycleBackend().shutdown(device);

    await expect(shutdown).rejects.toBeInstanceOf(ActionableError);
    await expect(shutdown).rejects.toThrow(
      `Cannot shut down physical iOS device ${physicalUdid}: only simulators have a remote shutdown path.`,
    );
  });

  test("waitForReady treats discovery as readiness and keeps optional fields", async () => {
    const booted = await new PhysicalIosLifecycleBackend().waitForReady({
      ...iosDevice(physicalUdid),
      iosVersion: "18.2",
      osVersion: "18.2",
      formFactor: "phone",
    });

    expect(booted).toEqual({
      name: "iPhone",
      platform: "ios",
      deviceId: physicalUdid,
      iosVersion: "18.2",
      osVersion: "18.2",
      formFactor: "phone",
    });
  });

  test("waitForReady omits optional fields the device lacks", async () => {
    const booted = await new PhysicalIosLifecycleBackend().waitForReady(iosDevice(physicalUdid));

    expect(booted).toEqual({ name: "iPhone", platform: "ios", deviceId: physicalUdid });
  });
});

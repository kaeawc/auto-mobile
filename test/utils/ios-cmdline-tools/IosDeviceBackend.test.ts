import { describe, expect, test } from "bun:test";
import type { DeviceAppUninstaller } from "../../../src/features/action/UninstallApp";
import {
  PhysicalIosDeviceBackend,
  resolveIosDeviceBackend,
  SimulatorIosDeviceBackend,
} from "../../../src/utils/ios-cmdline-tools/IosDeviceBackend";

const simulatorUdid = "A1B2C3D4-E5F6-7890-ABCD-EF1234567890";
const physicalUdid = "00008030-001C2D3E1234567A";
const bundleId = "com.example.app";

type Call =
  | { operation: "terminate"; bundleId: string; deviceId: string }
  | { operation: "uninstall"; deviceId: string; bundleId: string; isSimulator?: boolean };

class FakeSimctlTerminator {
  terminateError?: Error;

  constructor(private readonly calls: Call[]) {}

  async terminateApp(bundleId: string, deviceId?: string): Promise<void> {
    this.calls.push({ operation: "terminate", bundleId, deviceId: deviceId ?? "" });
    if (this.terminateError) {
      throw this.terminateError;
    }
  }
}

class FakeDeviceAppUninstaller implements DeviceAppUninstaller {
  constructor(private readonly calls: Call[]) {}

  async uninstallApp(deviceId: string, bundleId: string, isSimulator?: boolean): Promise<void> {
    this.calls.push({ operation: "uninstall", deviceId, bundleId, isSimulator });
  }
}

describe("resolveIosDeviceBackend", () => {
  test("selects simulator backend and terminates before uninstalling", async () => {
    const calls: Call[] = [];
    const backend = resolveIosDeviceBackend(simulatorUdid, {
      simctl: new FakeSimctlTerminator(calls),
      deviceAppUninstaller: new FakeDeviceAppUninstaller(calls),
    });

    expect(backend).toBeInstanceOf(SimulatorIosDeviceBackend);
    await backend.uninstallApp(bundleId);
    expect(calls).toEqual([
      { operation: "terminate", bundleId, deviceId: simulatorUdid },
      { operation: "uninstall", deviceId: simulatorUdid, bundleId, isSimulator: true },
    ]);
  });

  test("selects physical backend and uninstalls without terminating", async () => {
    const calls: Call[] = [];
    const backend = resolveIosDeviceBackend(physicalUdid, {
      simctl: new FakeSimctlTerminator(calls),
      deviceAppUninstaller: new FakeDeviceAppUninstaller(calls),
    });

    expect(backend).toBeInstanceOf(PhysicalIosDeviceBackend);
    await backend.uninstallApp(bundleId);
    expect(calls).toEqual([
      { operation: "uninstall", deviceId: physicalUdid, bundleId, isSimulator: false },
    ]);
  });

  test("still uninstalls a simulator app when termination fails", async () => {
    const calls: Call[] = [];
    const simctl = new FakeSimctlTerminator(calls);
    simctl.terminateError = new Error("app not running");
    const backend = resolveIosDeviceBackend(simulatorUdid, {
      simctl,
      deviceAppUninstaller: new FakeDeviceAppUninstaller(calls),
    });

    await backend.uninstallApp(bundleId);
    expect(calls).toEqual([
      { operation: "terminate", bundleId, deviceId: simulatorUdid },
      { operation: "uninstall", deviceId: simulatorUdid, bundleId, isSimulator: true },
    ]);
  });
});

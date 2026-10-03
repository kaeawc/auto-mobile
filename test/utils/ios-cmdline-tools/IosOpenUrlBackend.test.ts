import { describe, expect, test } from "bun:test";
import {
  PhysicalIosOpenUrlBackend,
  SimulatorIosOpenUrlBackend,
  resolveIosOpenUrlBackend,
  type IosOpenUrlBackendDeps,
} from "../../../src/utils/ios-cmdline-tools/IosDeviceBackend";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";
import { FakeDeviceUrlLauncher } from "../../fakes/FakeDeviceUrlLauncher";

const simulatorUdid = "A1B2C3D4-E5F6-7890-ABCD-EF1234567890";
const physicalUdid = "00008030-001C2D3E1234567A";
const bundleId = "com.example.app";
const url = "myapp://open?q='quoted'&value=$(literal)\\path";

class SignalRecordingUrlLauncher extends FakeDeviceUrlLauncher {
  signal?: AbortSignal;

  override async launchWithPayloadUrl(
    deviceUdid: string,
    targetBundleId: string,
    payloadUrl: string,
    signal?: AbortSignal,
  ): Promise<void> {
    this.signal = signal;
    await super.launchWithPayloadUrl(deviceUdid, targetBundleId, payloadUrl, signal);
  }
}

function fakeDeps() {
  const simctl = new FakeSimCtlClient();
  const launcher = new SignalRecordingUrlLauncher();
  const constructions = { simulator: 0, physical: 0 };
  const deps: IosOpenUrlBackendDeps = {
    createSimctl: () => {
      constructions.simulator++;
      return simctl;
    },
    createDeviceUrlLauncher: () => {
      constructions.physical++;
      return launcher;
    },
  };
  return { simctl, launcher, constructions, deps };
}

describe("IosOpenUrlBackend", () => {
  test("resolver selects simulator lazily and forwards exact openurl argv", async () => {
    const { simctl, launcher, constructions, deps } = fakeDeps();
    const backend = resolveIosOpenUrlBackend(simulatorUdid, deps);
    expect(backend).toBeInstanceOf(SimulatorIosOpenUrlBackend);
    expect(backend.kind).toBe("simulator");
    expect(constructions).toEqual({ simulator: 0, physical: 0 });
    expect(await backend.isUrlLaunchAvailable()).toBe(true);
    expect(constructions).toEqual({ simulator: 0, physical: 0 });

    await backend.openUrl(url, { bundleId, signal: new AbortController().signal });
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([
      { args: ["openurl", simulatorUdid, url], timeoutMs: undefined },
    ]);
    expect(constructions).toEqual({ simulator: 1, physical: 0 });
    expect(launcher.availabilityChecks).toBe(0);
    expect(launcher.launchCalls).toEqual([]);
  });

  test("resolver selects physical lazily and preserves arguments and abort signal", async () => {
    const { simctl, launcher, constructions, deps } = fakeDeps();
    const backend = resolveIosOpenUrlBackend(physicalUdid, deps);
    expect(backend).toBeInstanceOf(PhysicalIosOpenUrlBackend);
    expect(backend.kind).toBe("physical");
    expect(constructions).toEqual({ simulator: 0, physical: 0 });
    expect(await backend.isUrlLaunchAvailable()).toBe(true);
    expect(constructions).toEqual({ simulator: 0, physical: 1 });
    const signal = new AbortController().signal;

    await backend.openUrl(url, { bundleId, signal });
    expect(launcher.launchCalls).toEqual([{ deviceUdid: physicalUdid, bundleId, url }]);
    expect(launcher.signal).toBe(signal);
    expect(launcher.availabilityChecks).toBe(1);
    expect(constructions).toEqual({ simulator: 0, physical: 1 });
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([]);
  });

  test("physical backend exposes unavailable capability without launching", async () => {
    const { launcher, deps } = fakeDeps();
    launcher.setAvailable(false);
    const backend = new PhysicalIosOpenUrlBackend(physicalUdid, deps.createDeviceUrlLauncher);
    expect(await backend.isUrlLaunchAvailable()).toBe(false);
    expect(launcher.launchCalls).toEqual([]);
  });

  test("physical launch can construct its client without a capability probe", async () => {
    const { launcher, constructions, deps } = fakeDeps();
    const backend = new PhysicalIosOpenUrlBackend(physicalUdid, deps.createDeviceUrlLauncher);
    expect(constructions.physical).toBe(0);
    await backend.openUrl(url, { bundleId });
    expect(constructions.physical).toBe(1);
    expect(launcher.signal).toBeUndefined();
    expect(launcher.availabilityChecks).toBe(0);
  });

  test("transport errors propagate unchanged for action-level handling", async () => {
    const { simctl, launcher, deps } = fakeDeps();
    const simulatorError = new Error("simctl rejected URL");
    simctl.setCommandArgsError(["openurl", simulatorUdid, url], simulatorError);
    const physicalError = new Error("devicectl rejected URL");
    launcher.setLaunchError(physicalError);
    await expect(
      new SimulatorIosOpenUrlBackend(simulatorUdid, deps.createSimctl).openUrl(url),
    ).rejects.toBe(simulatorError);
    await expect(
      new PhysicalIosOpenUrlBackend(physicalUdid, deps.createDeviceUrlLauncher).openUrl(url, {
        bundleId,
      }),
    ).rejects.toBe(physicalError);
  });

  test("malformed IDs preserve the physical fallback without constructing clients", () => {
    const { constructions, deps } = fakeDeps();
    expect(resolveIosOpenUrlBackend("unrecognized-device", deps).kind).toBe("physical");
    expect(constructions).toEqual({ simulator: 0, physical: 0 });
  });
});

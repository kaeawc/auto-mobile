import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ActionableError } from "../../../src/models/ActionableError";
import { CoreDeviceCapabilityProbe } from "../../../src/utils/ios-cmdline-tools/CoreDeviceCapabilityProbe";
import { SimCtlBootStateProvider } from "../../../src/utils/ios-cmdline-tools/SimCtlBootStateProvider";
import {
  FakeCoreDeviceGuardVersionProvider,
  FakeDevicectlCommandInvoker,
  FakeDevicectlVersionSource,
} from "../../fakes/FakeCoreDeviceCapabilityDependencies";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";

const deviceId = "sim-1";
const capturedVersion = readFileSync(
  join(process.cwd(), "test/fixtures/ios-devicectl/version.txt"),
  "utf8",
);

function setState(simctl: FakeSimCtlClient, state: string): void {
  simctl.setDeviceInfo(deviceId, {
    udid: deviceId,
    name: "iPhone",
    state,
    isAvailable: true,
  });
}

describe("SimCtlBootStateProvider", () => {
  test.each([
    ["Booted", "booted"],
    ["Shutdown", "shutdown"],
    ["Booting", "unknown"],
    ["Shutting Down", "unknown"],
    ["", "unknown"],
  ])("maps simctl state %s to %s", async (state, expected) => {
    const simctl = new FakeSimCtlClient();
    setState(simctl, state);
    const provider = new SimCtlBootStateProvider(simctl);

    expect(await provider.getBootState(deviceId)).toBe(expected);
    expect(simctl.getMethodCalls("getDeviceInfo")).toEqual([{ udid: deviceId }]);
  });

  test("maps a missing device to unknown", async () => {
    const provider = new SimCtlBootStateProvider(new FakeSimCtlClient());

    expect(await provider.getBootState(deviceId)).toBe("unknown");
  });

  test("propagates a lookup rejection", async () => {
    const simctl = new FakeSimCtlClient();
    const error = new Error("simctl lookup failed");
    simctl.setDeviceInfoError(error);
    const provider = new SimCtlBootStateProvider(simctl);

    await expect(provider.getBootState(deviceId)).rejects.toBe(error);
  });

  test("reads state on each call", async () => {
    const simctl = new FakeSimCtlClient();
    const provider = new SimCtlBootStateProvider(simctl);
    setState(simctl, "Shutdown");
    expect(await provider.getBootState(deviceId)).toBe("shutdown");

    setState(simctl, "Booted");
    expect(await provider.getBootState(deviceId)).toBe("booted");
    expect(simctl.getMethodCalls("getDeviceInfo")).toHaveLength(2);
  });

  test("blocks a shut-down simulator in the capability probe before command invocation", async () => {
    const simctl = new FakeSimCtlClient();
    setState(simctl, "Shutdown");
    const guardVersions = new FakeCoreDeviceGuardVersionProvider();
    guardVersions.versions = {
      installedCoreDevice: [651, 13, 4],
      selectedDeveloperDirCoreDevice: [651, 13, 4],
    };
    const commandInvoker = new FakeDevicectlCommandInvoker();
    const probe = new CoreDeviceCapabilityProbe({
      versionSource: new FakeDevicectlVersionSource(capturedVersion),
      bootState: new SimCtlBootStateProvider(simctl),
      guardVersions,
      commandInvoker,
    });

    const result = await probe.checkSimulatorCommand(deviceId, "copy", [651, 13, 4]);

    expect(result.kind).toBe("notBooted");
    if (result.kind === "notBooted") {
      expect(result.error).toBeInstanceOf(ActionableError);
      expect(result.error.message).toBe(
        "Simulator sim-1 is shut down. Boot it before running copy.",
      );
    }
    expect(commandInvoker.calls).toHaveLength(0);
  });
});

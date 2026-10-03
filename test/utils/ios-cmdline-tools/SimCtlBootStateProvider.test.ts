import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ActionableError } from "../../../src/models/ActionableError";
import { CoreDeviceCapabilityProbe } from "../../../src/utils/ios-cmdline-tools/CoreDeviceCapabilityProbe";
import { SimCtlBootStateProvider } from "../../../src/utils/ios-cmdline-tools/SimCtlBootStateProvider";
import {
  FakeDevicectlCommandInvoker,
  FakeDevicectlVersionSource,
} from "../../fakes/FakeCoreDeviceCapabilityDependencies";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { DeviceInfo } from "../../../src/models";
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
    const commandInvoker = new FakeDevicectlCommandInvoker();
    const probe = new CoreDeviceCapabilityProbe({
      versionSource: new FakeDevicectlVersionSource(capturedVersion),
      bootState: new SimCtlBootStateProvider(simctl),
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
  test("diagnostics use a cheap bounded summary read, while boot checks bypass its cache", async () => {
    const timer = new FakeTimer();
    const calls: Array<{ timeoutMs?: number; bypassCache?: boolean }> = [];
    const devices: DeviceInfo[] = [
      { deviceId: "sim-1", name: "one", platform: "ios", state: "Booted", deviceType: "nonDuo" },
      { deviceId: "sim-2", name: "two", platform: "ios", state: "Shutdown" },
      { deviceId: "sim-3", name: "three", platform: "ios", state: "Booting" },
    ];
    const provider = new SimCtlBootStateProvider(
      {
        getDeviceInfo: async () => {
          throw new Error("unbounded seam must not run");
        },
        listSimulatorImages: async (timeoutMs, options) => {
          calls.push({ timeoutMs, bypassCache: options?.bypassCache });
          return devices;
        },
      },
      { timer, timeoutMs: 5000 },
    );
    expect(await provider.readSummary()).toEqual({
      status: "available",
      booted: 1,
      shutdown: 1,
      unknown: 1,
    });
    await provider.readSummary();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ timeoutMs: 5000, bypassCache: true });
    expect(await provider.getBootState("sim-1")).toBe("booted");
    expect(provider.getCapabilityScope("sim-1")).toBe("nonDuo");
    devices[0].state = "Shutdown";
    expect(await provider.getBootState("sim-1")).toBe("shutdown");
    timer.advanceTime(1000);
    expect(await provider.readSummary()).toMatchObject({ booted: 0, shutdown: 2 });
    expect(calls).toHaveLength(4);
  });

  test("coalesces diagnostic reads and retries rejected reads without stale fallback", async () => {
    const timer = new FakeTimer();
    let calls = 0;
    let fail = true;
    const provider = new SimCtlBootStateProvider(
      {
        getDeviceInfo: async () => null,
        listSimulatorImages: async () => {
          calls += 1;
          if (fail) {
            throw new Error("lookup failed");
          }
          return [];
        },
      },
      { timer, timeoutMs: 5000 },
    );
    await expect(provider.readSummary()).rejects.toThrow("lookup failed");
    fail = false;
    await Promise.all([provider.readSummary(), provider.readSummary()]);
    expect(calls).toBe(2);
  });
});

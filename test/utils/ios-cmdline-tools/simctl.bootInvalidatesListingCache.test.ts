import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Simctl } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import type { ExecResult } from "../../../src/models";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeSimulatorDeviceTypeProfiles } from "../../fakes/FakeSimulatorDeviceTypeProfiles";
import { resetSimCtlSharedStateForTesting } from "../../../src/utils/ios-cmdline-tools/SimCtlSharedState";

// #15295: a mapped listing taken before a fast boot stayed cached (5 s) after the boot, so the
// next cached reader still saw the new simulator Shutdown and refused to pool it.

const UDID = "6B507598-6E55-47FA-A8AA-88996D1BC155";

function harness() {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  let state = "Shutdown";
  const exec = async (file: string, args: string[]): Promise<ExecResult> => {
    const command = `${file} ${args.join(" ")}`;
    if (command === `xcrun simctl bootstatus ${UDID} -b`) {
      state = "Booted";
      return createExecResult("", "");
    }
    if (command === "xcrun simctl list devices --json") {
      return createExecResult(
        JSON.stringify({
          devices: {
            "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [
              { udid: UDID, name: "clone", state, isAvailable: true },
            ],
          },
        }),
        "",
      );
    }
    return createExecResult("", "");
  };
  const simctl = new Simctl(null, exec, {
    timer,
    platform: "darwin",
    bootOptions: { maxAttempts: 1, retryBackoffMs: 0 },
    deviceTypeProfiles: new FakeSimulatorDeviceTypeProfiles(),
  });
  return { simctl, timer };
}

describe("SimCtlClient boot and the cached simulator listing (#15295)", () => {
  beforeEach(() => {
    resetSimCtlSharedStateForTesting();
    Simctl.invalidateDeviceListCache();
  });
  afterEach(() => Simctl.invalidateDeviceListCache());

  test("a cached pre-boot listing is not served after the simulator booted", async () => {
    const { simctl, timer } = harness();
    const before = await simctl.getBootedSimulatorsChecked();
    expect(before.map((device) => device.deviceId)).toEqual([]);

    // A fast boot finishes well inside the 5 s listing cache window.
    timer.advanceTime(1_600);
    await simctl.startSimulator(UDID);

    const after = await simctl.getBootedSimulatorsChecked();
    expect(after.map((device) => device.deviceId)).toEqual([UDID]);
  });
});

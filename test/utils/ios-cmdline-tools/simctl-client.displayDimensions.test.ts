import { describe, expect, test } from "bun:test";
import { SimCtlClient } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import type { SimulatorDeviceTypeProfileSource } from "../../../src/utils/ios-cmdline-tools/SimulatorDeviceTypeProfiles";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeTimer } from "../../fakes/FakeTimer";

const UDID = "11111111-2222-3333-4444-555555555555";

describe("SimCtlClient display dimension enrichment", () => {
  test("does not let a stalled profile lookup block device listing", async () => {
    const timer = new FakeTimer();
    const profileSource: SimulatorDeviceTypeProfileSource = {
      profileFor: () => new Promise<never>(() => {}),
    };
    const simctl = new SimCtlClient(
      null,
      async () =>
        createExecResult(
          JSON.stringify({
            devices: {
              "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
                {
                  udid: UDID,
                  name: "iPhone 17",
                  state: "Booted",
                  isAvailable: true,
                  deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
                },
              ],
            },
          }),
          "",
        ),
      timer,
      "darwin",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      profileSource,
    );

    const listing = simctl.listSimulatorImages(5, { bypassCache: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    timer.advanceTime(5);

    await expect(listing).resolves.toMatchObject([
      {
        deviceId: UDID,
        screenWidth: undefined,
        screenHeight: undefined,
        screenDensity: undefined,
      },
    ]);
  });
});

import { describe, expect, test } from "bun:test";
import { SimCtlClient } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import type { SimulatorDeviceTypeProfileSource } from "../../../src/utils/ios-cmdline-tools/SimulatorDeviceTypeProfiles";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeTimer } from "../../fakes/FakeTimer";
import { loadDuoEnumerate } from "../../fixtures/loadDuoEnumerate";

const UDID = "11111111-2222-3333-4444-555555555555";
const duoEnumerate = loadDuoEnumerate();

describe("SimCtlClient display dimension enrichment", () => {
  test("publishes profile dimensions and both enumerated Duo screens", async () => {
    const typeId = "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo";
    const commands: string[] = [];
    const simctl = new SimCtlClient(
      null,
      async (_file, args) => {
        commands.push(args.join(" "));
        if (args.includes("enumerate")) {
          return createExecResult(duoEnumerate, "");
        }
        return createExecResult(
          JSON.stringify({
            devices: {
              "iOS-27-1": [
                {
                  udid: UDID,
                  name: "iPhone Duo",
                  state: "Booted",
                  isAvailable: true,
                  deviceTypeIdentifier: typeId,
                },
              ],
            },
          }),
          "",
        );
      },
      undefined,
      "darwin",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        profileFor: async () => ({
          deviceTypeId: typeId,
          productFamily: "iPhone",
          modelIdentifier: null,
          pixelWidth: 2007,
          pixelHeight: 2853,
          scale: 3,
          dpi: 460,
        }),
      },
    );
    const [device] = await simctl.listSimulatorImages(100, { bypassCache: true });
    expect(device).toMatchObject({
      screenWidth: 2007,
      screenHeight: 2853,
      screenDensity: 460,
      displays: [
        { id: "1", name: "primary", width: 1398, height: 2034 },
        { id: "3", name: "primary-1", width: 2007, height: 2853 },
      ],
    });
    expect(commands).toContain(`simctl io ${UDID} enumerate`);
  });

  const simulatorList = () =>
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
    );

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

  test("uses one total deadline for profile enrichment and skips expired budgets", async () => {
    const timer = new FakeTimer();
    const timeouts: number[] = [];
    let profileCalls = 0;
    const profileSource: SimulatorDeviceTypeProfileSource = {
      profileFor: (_id, options) => {
        profileCalls++;
        timeouts.push(options?.timeoutMs ?? -1);
        return new Promise<never>(() => {});
      },
    };
    const simctl = new SimCtlClient(
      null,
      async () => {
        timer.advanceTime(8);
        return simulatorList();
      },
      timer,
      "darwin",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      profileSource,
    );

    const listing = simctl.listSimulatorImages(10, { bypassCache: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    timer.advanceTime(2);
    await expect(listing).resolves.toHaveLength(1);
    expect(profileCalls).toBe(1);
    // The remaining budget bounds the outer race only; the shared cache never sees it.
    expect(timeouts).toEqual([-1]);

    const expired = new FakeTimer();
    let expiredCalls = 0;
    const expiredClient = new SimCtlClient(
      null,
      async () => {
        expired.advanceTime(10);
        return simulatorList();
      },
      expired,
      "darwin",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { profileFor: async () => (expiredCalls++, null) },
    );
    await expect(
      expiredClient.listSimulatorImages(10, { bypassCache: true }),
    ).resolves.toHaveLength(1);
    expect(expiredCalls).toBe(0);
  });

  test("propagates caller cancellation during profile enrichment", async () => {
    const timer = new FakeTimer();
    const controller = new AbortController();
    const simctl = new SimCtlClient(
      null,
      async () => simulatorList(),
      timer,
      "darwin",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { profileFor: () => new Promise<never>(() => {}) },
    );
    const listing = simctl.listSimulatorImages(100, {
      bypassCache: true,
      signal: controller.signal,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const reason = new Error("cancelled");
    controller.abort(reason);
    await expect(listing).rejects.toBe(reason);
  });
});

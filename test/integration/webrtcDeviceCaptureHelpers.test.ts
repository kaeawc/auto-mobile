import { describe, expect, test } from "bun:test";
import {
  shouldRetryWebRtcDaemonStart,
  waitForBootedSimulatorUdid,
  type SimulatorAppearanceClient,
} from "./helpers/webrtcDeviceCaptureHelpers";
import { FakeTimer } from "../fakes/FakeTimer";

describe("WHEP device capture helper logic", () => {
  test("retries daemon start when either the command or readiness attempt fails", () => {
    expect(shouldRetryWebRtcDaemonStart({ startError: null, readyError: null })).toBe(false);
    expect(
      shouldRetryWebRtcDaemonStart({ startError: new Error("start failed"), readyError: null }),
    ).toBe(true);
    expect(
      shouldRetryWebRtcDaemonStart({
        startError: null,
        readyError: new Error("socket unavailable"),
      }),
    ).toBe(true);
  });

  test("waits through an empty or transitional simulator listing for a Booted UDID", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    let discoveryCalls = 0;
    const states = ["Shutdown", "Booted"];
    const simctl: SimulatorAppearanceClient = {
      async getBootedSimulators() {
        discoveryCalls++;
        return discoveryCalls === 1 ? [] : [{ deviceId: "ios-simulator-udid" }];
      },
      async getDeviceInfo() {
        return { state: states.shift() ?? "Booted" };
      },
    };

    await expect(
      waitForBootedSimulatorUdid(simctl, { timeoutMs: 1_000, pollIntervalMs: 10, timer }),
    ).resolves.toBe("ios-simulator-udid");
    expect(discoveryCalls).toBe(3);
  });

  test("propagates simulator-discovery failures to the fixture caller", async () => {
    const timer = new FakeTimer();
    const simctl: SimulatorAppearanceClient = {
      async getBootedSimulators() {
        throw new Error("simctl discovery failed");
      },
      async getDeviceInfo() {
        return null;
      },
    };

    await expect(waitForBootedSimulatorUdid(simctl, { timer })).rejects.toThrow(
      "simctl discovery failed",
    );
  });
});

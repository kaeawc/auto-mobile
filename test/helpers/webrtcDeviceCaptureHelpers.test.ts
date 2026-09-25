import { describe, expect, test } from "bun:test";
import {
  configuredIosSimulatorUdid,
  isKeyframeRecoveryTimeout,
  runWithBoundedRetry,
  shouldRetryWebRtcDaemonStart,
  waitForBootedSimulatorUdid,
  type SimulatorAppearanceClient,
} from "./webrtcDeviceCaptureHelpers";
import { FakeTimer } from "../fakes/FakeTimer";

describe("WHEP device capture helper logic", () => {
  test("bounded retry returns an immediate success after one attempt", async () => {
    let calls = 0;
    await expect(
      runWithBoundedRetry(async () => {
        calls++;
        return "first";
      }),
    ).resolves.toBe("first");
    expect(calls).toBe(1);
  });

  test("bounded retry returns the second attempt after a rejection", async () => {
    let calls = 0;
    await expect(
      runWithBoundedRetry(async () => {
        calls++;
        if (calls === 1) {
          throw new Error("first failure");
        }
        return "second";
      }),
    ).resolves.toBe("second");
    expect(calls).toBe(2);
  });

  test("bounded retry throws the last error after exhausting attempts", async () => {
    const errors = [new Error("first failure"), new Error("last failure")];
    let calls = 0;
    await expect(
      runWithBoundedRetry(
        async () => {
          throw errors[calls++];
        },
        { attempts: 2 },
      ),
    ).rejects.toBe(errors[1]);
    expect(calls).toBe(2);
  });

  test("bounded retry defaults to two attempts", async () => {
    let calls = 0;
    await expect(
      runWithBoundedRetry(async () => {
        calls++;
        throw new Error("failure");
      }),
    ).rejects.toThrow("failure");
    expect(calls).toBe(2);
  });

  test("bounded retry supports a single attempt without retrying", async () => {
    let calls = 0;
    await expect(
      runWithBoundedRetry(
        async () => {
          calls++;
          throw new Error("single failure");
        },
        { attempts: 1 },
      ),
    ).rejects.toThrow("single failure");
    expect(calls).toBe(1);
  });

  test("reuses the workflow-selected simulator UDID without rediscovery", () => {
    const udid = "00000000-0000-0000-0000-000000000001";

    expect(configuredIosSimulatorUdid({ AUTOMOBILE_IOS_SIMULATOR_UDID: udid })).toBe(udid);
    expect(configuredIosSimulatorUdid({})).toBeUndefined();
    expect(() =>
      configuredIosSimulatorUdid({ AUTOMOBILE_IOS_SIMULATOR_UDID: "not-a-udid" }),
    ).toThrow("must be a simulator UDID");
  });

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

  test("recognizes bare keyframe recovery timeouts", () => {
    const recoveryMessage = "viewer did not recover to a fresh IDR";

    expect(isKeyframeRecoveryTimeout(new Error(recoveryMessage), recoveryMessage)).toBe(true);
  });

  test("recognizes waitFor-wrapped keyframe recovery timeouts", () => {
    const recoveryMessage = "viewer did not recover to a fresh IDR";

    expect(
      isKeyframeRecoveryTimeout(
        new Error(
          `${recoveryMessage} did not complete within 5000ms total (last poll remainder: x)`,
        ),
        recoveryMessage,
      ),
    ).toBe(true);
  });

  test("does not classify unrelated errors as keyframe recovery timeouts", () => {
    const recoveryMessage = "viewer did not recover to a fresh IDR";

    expect(
      isKeyframeRecoveryTimeout(
        new Error("TypeError: Cannot read properties of undefined (reading 'sessionId')"),
        recoveryMessage,
      ),
    ).toBe(false);
  });

  test("does not classify non-Errors as keyframe recovery timeouts", () => {
    expect(
      isKeyframeRecoveryTimeout(
        "viewer did not recover to a fresh IDR",
        "viewer did not recover to a fresh IDR",
      ),
    ).toBe(false);
  });

  test("waits through an empty or transitional simulator listing for a Booted UDID", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    let discoveryCalls = 0;
    const states = ["Shutdown", "Booted"];
    const simctl: SimulatorAppearanceClient = {
      async getBootedSimulatorsChecked() {
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
      // Match SimCtlClient.getBootedSimulatorsChecked, which propagates discovery failures.
      async getBootedSimulatorsChecked() {
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

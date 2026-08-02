import { describe, expect, test } from "bun:test";
import { SimCtlClient, type SimCtlBootOptions } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeTimer } from "../../fakes/FakeTimer";
import { ActionableError } from "../../../src/models";

const UDID = "11111111-2222-3333-4444-555555555555";

interface Harness {
  simctl: SimCtlClient;
  timer: FakeTimer;
  calls: string[];
  /**
   * States reported by successive `simctl list devices --json` calls. The last
   * entry sticks once the sequence is exhausted.
   */
  setStates(states: string[]): void;
  /** Make the next `bootstatus` invocation reject. */
  failBootStatusWith(message: string | null): void;
}

/**
 * Build a SimCtlClient whose simctl execution is entirely faked. `bootstatus`
 * "succeeds" (exit 0) by default — the wedge under test is exit 0 with a device
 * that never leaves Shutdown.
 */
function createHarness(bootOptions: SimCtlBootOptions): Harness {
  const calls: string[] = [];
  const timer = new FakeTimer();
  let states = ["Shutdown"];
  let bootStatusFailures: Array<string | null> = [];
  const nextState = (): string => (states.length > 1 ? states.shift()! : states[0]);

  const execAsync = async (file: string, args: string[]) => {
    const command = `${file} ${args.join(" ")}`;
    calls.push(command);

    if (command === "xcrun simctl --version") {
      return createExecResult("simctl version 1.0.0", "");
    }
    if (command === `xcrun simctl bootstatus ${UDID} -b`) {
      const bootStatusFailure = bootStatusFailures.shift() ?? null;
      if (bootStatusFailure !== null) {
        throw new Error(bootStatusFailure);
      }
      // Healthy boots on macOS 26 / Xcode 26 also print this line (#4092), so it
      // must never be treated as a wedge sentinel.
      return createExecResult("Device already booted. Status=4294967295", "");
    }
    if (command === "xcrun simctl list devices --json") {
      return createExecResult(JSON.stringify({
        devices: {
          "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
            {
              udid: UDID,
              name: "iPhone 17",
              state: nextState(),
              isAvailable: true,
              deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17"
            }
          ]
        }
      }), "");
    }
    return createExecResult("", "");
  };

  const simctl = new SimCtlClient(
    null,
    execAsync,
    timer,
    "darwin",
    undefined,
    undefined,
    bootOptions
  );

  return {
    simctl,
    timer,
    calls,
    setStates: next => { states = [...next]; },
    failBootStatusWith: message => { bootStatusFailures = [message]; }
  };
}

const bootstatusCalls = (calls: string[]): string[] =>
  calls.filter(call => call.includes("bootstatus"));

const shutdownCalls = (calls: string[]): string[] =>
  calls.filter(call => call === `xcrun simctl shutdown ${UDID}`);

const ALREADY_BOOTED_405 =
  "Device boot failed\n" +
  "An error was encountered processing the command " +
  "(domain=com.apple.CoreSimulator.SimError, code=405): " +
  "Unable to boot device in current state: Booted";

describe("SimCtlClient boot self-verification", () => {
  test("a wedged boot (bootstatus exit 0, device Shutdown) fails with an actionable error", async () => {
    const harness = createHarness({ maxAttempts: 1, retryBackoffMs: 10 });

    const error = await harness.timer.resolvePromise(
      harness.simctl.startSimulator(UDID, 5000).then(
        () => null,
        (err: unknown) => err
      )
    );

    expect(error).toBeInstanceOf(ActionableError);
    expect((error as Error).message).toContain("did not reach the Booted state");
    expect((error as Error).message).toContain("Shutdown");
    expect(bootstatusCalls(harness.calls).length).toBe(1);
  });

  test("does not treat Status=4294967295 as a wedge when the device is Booted", async () => {
    const harness = createHarness({ maxAttempts: 2, retryBackoffMs: 10 });
    harness.setStates(["Booted"]);

    const handle = await harness.timer.resolvePromise(harness.simctl.startSimulator(UDID, 5000));

    expect(handle).toBeDefined();
    expect(bootstatusCalls(harness.calls).length).toBe(1);
    expect(shutdownCalls(harness.calls).length).toBe(0);
    expect(harness.timer.getSleepCallCount()).toBe(0);
  });

  test("accepts a CoreSimulator 405 already-Booted response after verifying the requested simulator", async () => {
    const harness = createHarness({ maxAttempts: 2, retryBackoffMs: 10 });
    harness.setStates(["Booted"]);
    harness.failBootStatusWith(ALREADY_BOOTED_405);

    const handle = await harness.timer.resolvePromise(harness.simctl.startSimulator(UDID, 5000));

    expect(handle).toBeDefined();
    expect(bootstatusCalls(harness.calls).length).toBe(1);
    expect(shutdownCalls(harness.calls).length).toBe(0);
    expect(harness.timer.getSleepCallCount()).toBe(0);
  });

  test("retries a contradictory CoreSimulator 405 response when the simulator is not Booted", async () => {
    const harness = createHarness({ maxAttempts: 2, retryBackoffMs: 10 });
    harness.setStates(["Shutdown", "Booted"]);
    harness.failBootStatusWith(ALREADY_BOOTED_405);

    const handle = await harness.timer.resolvePromise(harness.simctl.startSimulator(UDID, 5000));

    expect(handle).toBeDefined();
    expect(bootstatusCalls(harness.calls).length).toBe(2);
    expect(shutdownCalls(harness.calls).length).toBe(1);
    expect(harness.timer.getSleepHistory()).toEqual([10]);
  });

  test("retries a wedged boot after a shutdown and a backoff, then succeeds", async () => {
    const harness = createHarness({ maxAttempts: 2, retryBackoffMs: 2000 });

    // First verification sees the wedge; the retry sees a real boot.
    harness.setStates(["Shutdown", "Booted"]);

    const handle = await harness.timer.resolvePromise(harness.simctl.startSimulator(UDID, 5000));

    expect(handle).toBeDefined();
    expect(bootstatusCalls(harness.calls).length).toBe(2);
    expect(shutdownCalls(harness.calls).length).toBe(1);
    expect(harness.timer.getSleepHistory()).toEqual([2000]);
  });

  test("stops after the bounded attempt count and reports the observed state", async () => {
    const harness = createHarness({ maxAttempts: 3, retryBackoffMs: 25 });

    const error = await harness.timer.resolvePromise(
      harness.simctl.startSimulator(UDID, 5000).then(
        () => null,
        (err: unknown) => err
      )
    );

    expect((error as Error).message).toContain("after 3 boot attempt(s)");
    expect(bootstatusCalls(harness.calls).length).toBe(3);
    expect(shutdownCalls(harness.calls).length).toBe(2);
    expect(harness.timer.getSleepHistory()).toEqual([25, 25]);
  });

  test("a bootstatus failure propagates immediately without burning a retry", async () => {
    const harness = createHarness({ maxAttempts: 3, retryBackoffMs: 10 });
    harness.failBootStatusWith("Invalid device: nope");

    const error = await harness.timer.resolvePromise(
      harness.simctl.startSimulator(UDID, 5000).then(
        () => null,
        (err: unknown) => err
      )
    );

    expect((error as Error).message).toContain("Invalid device");
    expect(bootstatusCalls(harness.calls).length).toBe(1);
    expect(shutdownCalls(harness.calls).length).toBe(0);
    expect(harness.timer.getSleepCallCount()).toBe(0);
  });

  // The session auto-start path (DeviceSessionManager.findOrStartIosDevice ->
  // SimCtlClient.bootSimulator) is the default when an MCP session begins with no
  // booted simulator. It previously ran a bare `simctl boot` plus a fixed 1s
  // sleep, so it bypassed verification entirely -- the very scenario #4094 is
  // about. These pin it to the same verifier.
  test("bootSimulator rejects a wedged boot instead of returning a device", async () => {
    const harness = createHarness({ maxAttempts: 1, retryBackoffMs: 10 });
    harness.setStates(["Shutdown"]);

    await expect(harness.simctl.bootSimulator(UDID)).rejects.toThrow(/not Booted/);
    // It must go through bootstatus, not a bare `simctl boot`.
    expect(bootstatusCalls(harness.calls).length).toBe(1);
    expect(harness.calls).not.toContain(`xcrun simctl boot ${UDID}`);
  });

  test("bootSimulator retries a wedged boot and returns the device once Booted", async () => {
    const harness = createHarness({ maxAttempts: 2, retryBackoffMs: 10 });
    harness.setStates(["Shutdown", "Booted"]);

    // FakeTimer: the retry backoff must be driven, as in the startSimulator case.
    const device = await harness.timer.resolvePromise(harness.simctl.bootSimulator(UDID));

    expect(device.deviceId).toBe(UDID);
    expect(bootstatusCalls(harness.calls).length).toBe(2);
    expect(shutdownCalls(harness.calls).length).toBe(1);
  });

  test("waitForSimulatorReady rejects a wedged boot instead of returning a device", async () => {
    const harness = createHarness({ maxAttempts: 1, retryBackoffMs: 10 });

    const error = await harness.timer.resolvePromise(
      harness.simctl.waitForSimulatorReady(UDID, 5000).then(
        () => null,
        (err: unknown) => err
      )
    );

    expect(error).toBeInstanceOf(ActionableError);
    expect((error as Error).message).toContain("failed to become ready");
    expect((error as Error).message).toContain("Shutdown");
  });
});

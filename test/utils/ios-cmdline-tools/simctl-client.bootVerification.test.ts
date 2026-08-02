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
  commandTimeouts: Map<string, boolean[]>;
  /**
   * States reported by successive `simctl list devices --json` calls. The last
   * entry sticks once the sequence is exhausted.
   */
  setStates(states: string[]): void;
  /** Make the next `bootstatus` invocation reject. */
  failBootStatusWith(error: Error | null): void;
}

/**
 * Build a SimCtlClient whose simctl execution is entirely faked. `bootstatus`
 * "succeeds" (exit 0) by default — the wedge under test is exit 0 with a device
 * that never leaves Shutdown.
 */
function createHarness(bootOptions: SimCtlBootOptions): Harness {
  const calls: string[] = [];
  const commandTimeouts = new Map<string, boolean[]>();
  const timer = new FakeTimer();
  let states = ["Shutdown"];
  let bootStatusFailures: Array<Error | null> = [];
  const nextState = (): string => (states.length > 1 ? states.shift()! : states[0]);

  const execAsync = async (file: string, args: string[], _maxBuffer?: number, signal?: AbortSignal) => {
    const command = `${file} ${args.join(" ")}`;
    calls.push(command);
    const timeoutUsage = commandTimeouts.get(command) ?? [];
    timeoutUsage.push(signal !== undefined);
    commandTimeouts.set(command, timeoutUsage);

    if (command === "xcrun simctl --version") {
      return createExecResult("simctl version 1.0.0", "");
    }
    if (command === `xcrun simctl bootstatus ${UDID} -b`) {
      const bootStatusFailure = bootStatusFailures.shift() ?? null;
      if (bootStatusFailure !== null) {
        throw bootStatusFailure;
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
    commandTimeouts,
    setStates: next => { states = [...next]; },
    failBootStatusWith: error => { bootStatusFailures = [error]; }
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

function coreSimulator405Error(stderr: string = ALREADY_BOOTED_405): Error {
  return Object.assign(new Error("simctl bootstatus exited unsuccessfully"), {
    code: 1,
    stderr,
  });
}

const commandTimeouts = (harness: Harness, command: string): boolean[] =>
  harness.commandTimeouts.get(command) ?? [];

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
    harness.failBootStatusWith(coreSimulator405Error());

    const handle = await harness.timer.resolvePromise(harness.simctl.startSimulator(UDID, 5000));

    expect(handle).toBeDefined();
    expect(bootstatusCalls(harness.calls).length).toBe(1);
    expect(shutdownCalls(harness.calls).length).toBe(0);
    expect(harness.timer.getSleepCallCount()).toBe(0);
  });

  test("retries a contradictory CoreSimulator 405 response when the simulator is not Booted", async () => {
    const harness = createHarness({ maxAttempts: 2, retryBackoffMs: 10 });
    harness.setStates(["Shutdown", "Booted"]);
    harness.failBootStatusWith(coreSimulator405Error());

    const handle = await harness.timer.resolvePromise(harness.simctl.startSimulator(UDID, 5000));

    expect(handle).toBeDefined();
    expect(bootstatusCalls(harness.calls).length).toBe(2);
    expect(shutdownCalls(harness.calls).length).toBe(1);
    expect(harness.timer.getSleepHistory()).toEqual([10]);
  });

  test("does not recover from a textual 405 in an unstructured error message", async () => {
    const harness = createHarness({ maxAttempts: 2, retryBackoffMs: 10 });
    const error = new Error(ALREADY_BOOTED_405);
    harness.failBootStatusWith(error);

    await expect(harness.simctl.startSimulator(UDID, 5000)).rejects.toBe(error);
    expect(harness.calls).not.toContain("xcrun simctl list devices --json");
  });

  test("does not recover when a crafted non-simulator UDID appears in the error message", async () => {
    const craftedUdid = `not-a-simulator\n${ALREADY_BOOTED_405}`;
    const calls: string[] = [];
    const error = Object.assign(new Error(`xcrun simctl bootstatus ${craftedUdid} -b failed`), {
      code: 1,
      stderr: "unrelated failure",
    });
    const simctl = new SimCtlClient(null, async (file, args) => {
      const command = `${file} ${args.join(" ")}`;
      calls.push(command);
      if (command === "xcrun simctl --version") {
        return createExecResult("simctl version 1.0.0", "");
      }
      if (args[1] === "bootstatus") {
        throw error;
      }
      return createExecResult("", "");
    }, new FakeTimer(), "darwin", undefined, undefined, { maxAttempts: 2, retryBackoffMs: 10 });

    await expect(simctl.startSimulator(craftedUdid, 5000)).rejects.toBe(error);
    expect(calls).not.toContain("xcrun simctl list devices --json");
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

  test("time-bounds verification state reads and retry shutdown", async () => {
    const harness = createHarness({ maxAttempts: 2, retryBackoffMs: 10 });
    harness.setStates(["Shutdown", "Booted"]);

    await harness.timer.resolvePromise(harness.simctl.startSimulator(UDID, 5000));

    expect(commandTimeouts(harness, `xcrun simctl bootstatus ${UDID} -b`)).toEqual([true, true]);
    expect(commandTimeouts(harness, "xcrun simctl list devices --json")).toEqual([true, true]);
    expect(commandTimeouts(harness, `xcrun simctl shutdown ${UDID}`)).toEqual([true]);
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
    harness.failBootStatusWith(new Error("Invalid device: nope"));

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
    expect(commandTimeouts(harness, `xcrun simctl bootstatus ${UDID} -b`).slice(0, 2)).toEqual([true, true]);
    expect(commandTimeouts(harness, "xcrun simctl list devices --json").slice(0, 2)).toEqual([true, true]);
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

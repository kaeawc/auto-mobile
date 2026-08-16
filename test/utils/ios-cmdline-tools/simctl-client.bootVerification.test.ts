import { beforeEach, describe, expect, test } from "bun:test";
import {
  SimCtlClient,
  type SimCtlBootOptions,
} from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeTimer } from "../../fakes/FakeTimer";
import { ActionableError } from "../../../src/models";
import { runWithAbortSignal } from "../../../src/utils/AbortContext";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../../../src/utils/deviceTimeouts";

const UDID = "11111111-2222-3333-4444-555555555555";
const OTHER_UDID = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";

function resetSimctlState(): void {
  const simctlClass = SimCtlClient as unknown as {
    simulatorBoots: Map<string, unknown>;
  };
  simctlClass.simulatorBoots.clear();
  SimCtlClient.invalidateDeviceListCache();
}

interface Harness {
  simctl: SimCtlClient;
  timer: FakeTimer;
  calls: string[];
  commandTimeouts: Map<string, boolean[]>;
  commandSignals: Map<string, Array<AbortSignal | undefined>>;
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
  const commandSignals = new Map<string, Array<AbortSignal | undefined>>();
  const timer = new FakeTimer();
  let states = ["Shutdown"];
  let bootStatusFailures: Array<Error | null> = [];
  const nextState = (): string => (states.length > 1 ? states.shift()! : states[0]);

  const execAsync = async (
    file: string,
    args: string[],
    _maxBuffer?: number,
    signal?: AbortSignal,
  ) => {
    const command = `${file} ${args.join(" ")}`;
    calls.push(command);
    const timeoutUsage = commandTimeouts.get(command) ?? [];
    timeoutUsage.push(signal !== undefined);
    commandTimeouts.set(command, timeoutUsage);
    const signals = commandSignals.get(command) ?? [];
    signals.push(signal);
    commandSignals.set(command, signals);

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
      return createExecResult(
        JSON.stringify({
          devices: {
            "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
              {
                udid: UDID,
                name: "iPhone 17",
                state: nextState(),
                isAvailable: true,
                deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
              },
            ],
          },
        }),
        "",
      );
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
    bootOptions,
  );

  return {
    simctl,
    timer,
    calls,
    commandTimeouts,
    commandSignals,
    setStates: (next) => {
      states = [...next];
    },
    failBootStatusWith: (error) => {
      bootStatusFailures = [error];
    },
  };
}

const bootstatusCalls = (calls: string[]): string[] =>
  calls.filter((call) => call.includes("bootstatus"));

const shutdownCalls = (calls: string[]): string[] =>
  calls.filter((call) => call === `xcrun simctl shutdown ${UDID}`);

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

interface ConcurrentStartHarness {
  timer: FakeTimer;
  lifecycleCalls: string[];
  createClient(): SimCtlClient;
  bootstatusInvocations(): number;
  shutdownInvocations(): number;
}

function rejectWhenAborted(
  signal: AbortSignal | undefined,
  preserveReason = false,
): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    signal?.addEventListener(
      "abort",
      () =>
        reject(
          preserveReason
            ? (signal.reason ?? new Error("aborted"))
            : Object.assign(new Error("aborted"), { name: "AbortError" }),
        ),
      { once: true },
    );
  });
}

function bootedSimulatorListResult() {
  return createExecResult(
    JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
          { udid: UDID, name: "iPhone 17", state: "Booted", isAvailable: true },
        ],
      },
    }),
    "",
  );
}

function createConcurrentStartHarness(
  bootstatus: (
    invocation: number,
    signal: AbortSignal | undefined,
  ) => Promise<ReturnType<typeof createExecResult>>,
  listDevices: (
    invocation: number,
    signal: AbortSignal | undefined,
  ) =>
    | ReturnType<typeof createExecResult>
    | Promise<ReturnType<typeof createExecResult>> = bootedSimulatorListResult,
  options: {
    openSimulatorApp?: (
      signal: AbortSignal | undefined,
    ) => Promise<ReturnType<typeof createExecResult>>;
    shutdown?: (
      invocation: number,
      signal: AbortSignal | undefined,
    ) => Promise<ReturnType<typeof createExecResult>>;
  } = {},
): ConcurrentStartHarness {
  const timer = new FakeTimer();
  const lifecycleCalls: string[] = [];
  let bootstatusCount = 0;
  let shutdownCount = 0;
  let listDevicesCount = 0;
  const execAsync = async (
    file: string,
    args: string[],
    _maxBuffer?: number,
    signal?: AbortSignal,
  ) => {
    const command = `${file} ${args.join(" ")}`;
    if (command === "xcrun simctl --version") {
      return createExecResult("", "");
    }
    if (command === `xcrun simctl bootstatus ${UDID} -b`) {
      bootstatusCount++;
      lifecycleCalls.push(`bootstatus-${bootstatusCount}`);
      return bootstatus(bootstatusCount, signal);
    }
    if (command === `xcrun simctl shutdown ${UDID}`) {
      shutdownCount++;
      lifecycleCalls.push("shutdown");
      return options.shutdown?.(shutdownCount, signal) ?? createExecResult("", "");
    }
    if (command === "xcrun simctl list devices --json") {
      listDevicesCount++;
      return listDevices(listDevicesCount, signal);
    }
    if (options.openSimulatorApp && command === "launchctl managername") {
      return createExecResult("Aqua", "");
    }
    if (options.openSimulatorApp && command === "open -a Simulator") {
      return options.openSimulatorApp(signal);
    }
    return createExecResult("", "");
  };

  return {
    timer,
    lifecycleCalls,
    createClient: () =>
      new SimCtlClient(null, execAsync, timer, "darwin", undefined, undefined, {
        maxAttempts: 1,
        retryBackoffMs: 0,
      }),
    bootstatusInvocations: () => bootstatusCount,
    shutdownInvocations: () => shutdownCount,
  };
}

async function drainMicrotasks(turns = 10): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    await Promise.resolve();
  }
}

async function waitForCondition(
  condition: () => boolean,
  description: string,
  turns = 100,
): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    if (condition()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for ${description}`);
}

describe("SimCtlClient boot self-verification", () => {
  beforeEach(resetSimctlState);

  test("shuts down a simulator when its start request is aborted", async () => {
    const calls: string[] = [];
    const simctl = new SimCtlClient(
      null,
      async (file, args, _maxBuffer, signal) => {
        const command = `${file} ${args.join(" ")}`;
        calls.push(command);
        if (command === "xcrun simctl --version" || command === `xcrun simctl shutdown ${UDID}`) {
          return createExecResult("", "");
        }
        if (command === `xcrun simctl bootstatus ${UDID} -b`) {
          return new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }
        return createExecResult("", "");
      },
      new FakeTimer(),
      "darwin",
    );
    const controller = new AbortController();
    const start = runWithAbortSignal(controller.signal, () => simctl.startSimulator(UDID, 5_000));
    await waitForCondition(
      () => calls.includes(`xcrun simctl bootstatus ${UDID} -b`),
      "the abortable bootstatus command",
    );

    controller.abort(new Error("request cancelled"));

    await expect(start).rejects.toThrow("request cancelled");
    expect(shutdownCalls(calls)).toEqual([`xcrun simctl shutdown ${UDID}`]);
  });

  test("shuts down after an internal bootstatus timeout without replacing the timeout error", async () => {
    const calls: string[] = [];
    const timer = new FakeTimer();
    const requestController = new AbortController();
    let bootstatusSignal: AbortSignal | undefined;
    let shutdownSignal: AbortSignal | undefined;
    let shutdownStartedAborted: boolean | undefined;
    const simctl = new SimCtlClient(
      null,
      async (file, args, _maxBuffer, signal) => {
        const command = `${file} ${args.join(" ")}`;
        calls.push(command);
        if (command === "xcrun simctl --version") {
          return createExecResult("", "");
        }
        if (command === `xcrun simctl bootstatus ${UDID} -b`) {
          bootstatusSignal = signal;
          return new Promise((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
              { once: true },
            );
          });
        }
        if (command === `xcrun simctl shutdown ${UDID}`) {
          shutdownSignal = signal;
          shutdownStartedAborted = signal?.aborted;
          return rejectWhenAborted(signal);
        }
        return createExecResult("", "");
      },
      timer,
      "darwin",
    );
    const start = runWithAbortSignal(requestController.signal, () =>
      simctl.startSimulator(UDID, 1_234),
    );
    await waitForCondition(() => bootstatusSignal !== undefined, "the timed bootstatus command");

    timer.advanceTime(1_234);
    await waitForCondition(() => shutdownSignal !== undefined, "the bounded cleanup command");
    timer.advanceTime(10_000);

    await expect(start).rejects.toThrow(
      `Command timed out after 1234ms: xcrun simctl bootstatus ${UDID} -b`,
    );
    expect(requestController.signal.aborted).toBe(false);
    expect(bootstatusSignal.aborted).toBe(true);
    expect(shutdownCalls(calls)).toEqual([`xcrun simctl shutdown ${UDID}`]);
    expect(shutdownSignal).toBeDefined();
    expect(shutdownStartedAborted).toBe(false);
    expect(shutdownSignal?.aborted).toBe(true);
  });

  test("serializes same-UDID starts before failed-start cleanup", async () => {
    let completeCleanup: (() => void) | undefined;
    const harness = createConcurrentStartHarness(
      (invocation, signal) =>
        invocation === 1 ? rejectWhenAborted(signal) : Promise.resolve(createExecResult("", "")),
      bootedSimulatorListResult,
      {
        shutdown: () =>
          new Promise((resolve) => {
            completeCleanup = () => resolve(createExecResult("", ""));
          }),
      },
    );
    const firstStart = harness.createClient().startSimulator(UDID, 1_000);
    await waitForCondition(() => harness.bootstatusInvocations() === 1, "the first same-UDID boot");
    const secondStart = harness.createClient().startSimulator(UDID, 5_000);
    await drainMicrotasks();
    const bootstatusInvocationsBeforeFirstTimeout = harness.bootstatusInvocations();

    harness.timer.advanceTime(1_000);
    await waitForCondition(() => completeCleanup !== undefined, "failed-start cleanup");
    await drainMicrotasks();
    expect(harness.bootstatusInvocations()).toBe(1);
    completeCleanup();

    await expect(firstStart).rejects.toThrow(
      `Command timed out after 1000ms: xcrun simctl bootstatus ${UDID} -b`,
    );
    await expect(secondStart).resolves.toBeDefined();
    expect(bootstatusInvocationsBeforeFirstTimeout).toBe(1);
    expect(harness.lifecycleCalls).toEqual(["bootstatus-1", "shutdown", "bootstatus-2"]);
  });

  test("does not serialize boot attempts for different UDIDs", async () => {
    const calls: string[] = [];
    const firstController = new AbortController();
    const execAsync = async (
      file: string,
      args: string[],
      _maxBuffer?: number,
      signal?: AbortSignal,
    ) => {
      const command = `${file} ${args.join(" ")}`;
      calls.push(command);
      if (command === `xcrun simctl bootstatus ${UDID} -b`) {
        return rejectWhenAborted(signal, true);
      }
      if (command === `xcrun simctl bootstatus ${OTHER_UDID} -b`) {
        return createExecResult("", "");
      }
      if (command === "xcrun simctl list devices --json") {
        return createExecResult(
          JSON.stringify({
            devices: {
              "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
                { udid: UDID, name: "iPhone 17", state: "Booted", isAvailable: true },
                { udid: OTHER_UDID, name: "iPhone 17 Pro", state: "Booted", isAvailable: true },
              ],
            },
          }),
          "",
        );
      }
      return createExecResult("", "");
    };
    const timer = new FakeTimer();
    const createClient = () => new SimCtlClient(null, execAsync, timer, "darwin");
    const firstStart = runWithAbortSignal(firstController.signal, () =>
      createClient().startSimulator(UDID, 5_000),
    );
    await waitForCondition(
      () => calls.includes(`xcrun simctl bootstatus ${UDID} -b`),
      "the first UDID boot",
    );

    await expect(createClient().startSimulator(OTHER_UDID, 5_000)).resolves.toBeDefined();
    expect(calls).toContain(`xcrun simctl bootstatus ${OTHER_UDID} -b`);

    firstController.abort(new Error("first UDID cancelled"));
    await expect(firstStart).rejects.toThrow("first UDID cancelled");
  });

  test("serializes session auto-start behind failed-start cleanup", async () => {
    const harness = createConcurrentStartHarness((invocation, signal) =>
      invocation === 1 ? rejectWhenAborted(signal) : Promise.resolve(createExecResult("", "")),
    );
    const publicStart = harness.createClient().startSimulator(UDID, 1_000);
    await waitForCondition(
      () => harness.bootstatusInvocations() === 1,
      "the public start bootstatus",
    );
    const sessionStart = harness.createClient().bootSimulator(UDID);
    await drainMicrotasks();
    const bootstatusInvocationsBeforePublicTimeout = harness.bootstatusInvocations();

    harness.timer.advanceTime(1_000);

    await expect(publicStart).rejects.toThrow(
      `Command timed out after 1000ms: xcrun simctl bootstatus ${UDID} -b`,
    );
    await expect(sessionStart).resolves.toMatchObject({ deviceId: UDID });
    expect(bootstatusInvocationsBeforePublicTimeout).toBe(1);
    expect(harness.lifecycleCalls).toEqual(["bootstatus-1", "shutdown", "bootstatus-2"]);
  });

  test("serializes readiness verification behind failed-start cleanup", async () => {
    const harness = createConcurrentStartHarness((invocation, signal) =>
      invocation === 1 ? rejectWhenAborted(signal) : Promise.resolve(createExecResult("", "")),
    );
    const publicStart = harness.createClient().startSimulator(UDID, 1_000);
    await waitForCondition(
      () => harness.bootstatusInvocations() === 1,
      "the public start bootstatus",
    );
    const readiness = harness.createClient().waitForSimulatorReady(UDID, 5_000);
    await drainMicrotasks();
    const bootstatusInvocationsBeforePublicTimeout = harness.bootstatusInvocations();

    harness.timer.advanceTime(1_000);

    await expect(publicStart).rejects.toThrow(
      `Command timed out after 1000ms: xcrun simctl bootstatus ${UDID} -b`,
    );
    await expect(readiness).resolves.toMatchObject({ deviceId: UDID });
    expect(bootstatusInvocationsBeforePublicTimeout).toBe(1);
    expect(harness.lifecycleCalls).toEqual(["bootstatus-1", "shutdown", "bootstatus-2"]);
  });

  test("session auto-start cleans up an internal bootstatus timeout", async () => {
    const harness = createConcurrentStartHarness((_invocation, signal) =>
      rejectWhenAborted(signal),
    );
    const sessionStart = harness.createClient().bootSimulator(UDID);
    await waitForCondition(
      () => harness.bootstatusInvocations() === 1,
      "the session auto-start bootstatus",
    );

    harness.timer.advanceTime(DEFAULT_DEVICE_READY_TIMEOUT_MS);

    await expect(sessionStart).rejects.toThrow(
      `Command timed out after ${DEFAULT_DEVICE_READY_TIMEOUT_MS}ms: ` +
        `xcrun simctl bootstatus ${UDID} -b`,
    );
    expect(harness.lifecycleCalls).toEqual(["bootstatus-1", "shutdown"]);
  });

  test("session auto-start cleans up a post-boot registration failure", async () => {
    const harness = createConcurrentStartHarness(
      () => Promise.resolve(createExecResult("", "")),
      (invocation) =>
        invocation === 1
          ? bootedSimulatorListResult()
          : createExecResult(JSON.stringify({ devices: {} }), ""),
    );

    await expect(harness.createClient().bootSimulator(UDID)).rejects.toThrow(
      `Failed to boot iOS simulator ${UDID}`,
    );
    expect(harness.lifecycleCalls).toEqual(["bootstatus-1", "shutdown"]);
  });

  test("session auto-start preserves a post-boot registration discovery error", async () => {
    const registrationError = new Error("registration discovery failed");
    const harness = createConcurrentStartHarness(
      () => Promise.resolve(createExecResult("", "")),
      (invocation) => {
        if (invocation === 1) {
          return bootedSimulatorListResult();
        }
        throw registrationError;
      },
    );

    await expect(harness.createClient().bootSimulator(UDID)).rejects.toBe(registrationError);
    expect(harness.lifecycleCalls).toEqual(["bootstatus-1", "shutdown"]);
  });

  test("rejects a queued public owner but lets session and readiness adopt success", async () => {
    let completeFirstBootstatus: (() => void) | undefined;
    const harness = createConcurrentStartHarness((invocation) => {
      if (invocation > 1) {
        return Promise.resolve(createExecResult("", ""));
      }
      return new Promise((resolve) => {
        completeFirstBootstatus = () => resolve(createExecResult("", ""));
      });
    });

    const firstStart = harness.createClient().startSimulator(UDID, 5_000);
    await waitForCondition(
      () => completeFirstBootstatus !== undefined,
      "the owner bootstatus command",
    );
    const waitingStart = harness
      .createClient()
      .startSimulator(UDID, 100)
      .catch((error: unknown) => error);
    const sessionStart = harness.createClient().bootSimulator(UDID);
    const readiness = harness.createClient().waitForSimulatorReady(UDID, 5_000);
    completeFirstBootstatus();
    await expect(firstStart).resolves.toBeDefined();

    const waitingError = await waitingStart;
    await expect(sessionStart).resolves.toMatchObject({ deviceId: UDID });
    await expect(readiness).resolves.toMatchObject({ deviceId: UDID });
    expect(waitingError).toBeInstanceOf(ActionableError);
    expect((waitingError as Error).message).toBe(`iOS simulator ${UDID} is already running`);
    expect(harness.bootstatusInvocations()).toBe(2);
    expect(harness.shutdownInvocations()).toBe(0);
  });

  test("retains successful ownership for a caller that enters after lease release", async () => {
    const harness = createConcurrentStartHarness(() => Promise.resolve(createExecResult("", "")));
    const ownerHandle = await harness.createClient().startSimulator(UDID, 5_000);

    const lateStartError = await harness
      .createClient()
      .startSimulator(UDID, 5_000)
      .catch((error: unknown) => error);

    expect(lateStartError).toBeInstanceOf(ActionableError);
    expect((lateStartError as Error).message).toBe(`iOS simulator ${UDID} is already running`);
    expect(harness.bootstatusInvocations()).toBe(1);
    expect(ownerHandle.kill()).toBe(true);
    await waitForCondition(() => harness.shutdownInvocations() === 1, "owner shutdown");
  });

  test("reboots after out-of-band shutdown and invalidates the stale owner handle", async () => {
    const harness = createConcurrentStartHarness(
      () => Promise.resolve(createExecResult("", "")),
      (invocation) =>
        invocation === 2
          ? createExecResult(JSON.stringify({ devices: {} }), "")
          : bootedSimulatorListResult(),
    );
    const staleHandle = await harness.createClient().startSimulator(UDID, 5_000);

    const replacementHandle = await harness.createClient().startSimulator(UDID, 5_000);

    expect(harness.bootstatusInvocations()).toBe(2);
    expect(staleHandle.kill()).toBe(true);
    await drainMicrotasks();
    expect(harness.shutdownInvocations()).toBe(0);
    expect(replacementHandle.kill()).toBe(true);
    await waitForCondition(() => harness.shutdownInvocations() === 1, "replacement shutdown");
  });

  test("does not reuse an owner identity after coordinated state eviction", async () => {
    const harness = createConcurrentStartHarness(() => Promise.resolve(createExecResult("", "")));
    const staleHandle = await harness.createClient().startSimulator(UDID, 5_000);
    await harness.createClient().killSimulator({
      name: "iPhone 17",
      platform: "ios",
      deviceId: UDID,
    });
    expect(harness.shutdownInvocations()).toBe(1);
    const replacementHandle = await harness.createClient().startSimulator(UDID, 5_000);

    expect(staleHandle.kill()).toBe(true);
    await drainMicrotasks();
    expect(harness.shutdownInvocations()).toBe(1);
    expect(replacementHandle.kill()).toBe(true);
    await waitForCondition(() => harness.shutdownInvocations() === 2, "replacement shutdown");
  });

  test("session auto-start reboots after an out-of-band shutdown", async () => {
    const harness = createConcurrentStartHarness(
      () => Promise.resolve(createExecResult("", "")),
      (invocation) =>
        invocation === 3
          ? createExecResult(JSON.stringify({ devices: {} }), "")
          : bootedSimulatorListResult(),
    );
    await expect(harness.createClient().bootSimulator(UDID)).resolves.toMatchObject({
      deviceId: UDID,
    });

    await expect(harness.createClient().bootSimulator(UDID)).resolves.toMatchObject({
      deviceId: UDID,
    });

    expect(harness.bootstatusInvocations()).toBe(2);
    expect(harness.shutdownInvocations()).toBe(0);
  });

  test("does not clean up when a queued session adopter cannot resolve registration", async () => {
    let completeOwnerBootstatus: (() => void) | undefined;
    const registrationError = new Error("adopter registration failed");
    const harness = createConcurrentStartHarness(
      () =>
        new Promise((resolve) => {
          completeOwnerBootstatus = () => resolve(createExecResult("", ""));
        }),
      (invocation) => {
        if (invocation === 1) {
          return bootedSimulatorListResult();
        }
        throw registrationError;
      },
    );
    const owner = harness.createClient().startSimulator(UDID, 5_000);
    await waitForCondition(() => completeOwnerBootstatus !== undefined, "owner bootstatus");
    const adopter = harness
      .createClient()
      .bootSimulator(UDID)
      .catch((error: unknown) => error);
    completeOwnerBootstatus();

    await expect(owner).resolves.toBeDefined();
    await expect(adopter).resolves.toBe(registrationError);
    expect(harness.shutdownInvocations()).toBe(0);
  });

  test("bounds Simulator.app focus while retaining the successful boot lease", async () => {
    let openingSimulatorApp = false;
    let openSimulatorSignal: AbortSignal | undefined;
    const harness = createConcurrentStartHarness(
      () => Promise.resolve(createExecResult("", "")),
      bootedSimulatorListResult,
      {
        openSimulatorApp: (signal) => {
          openingSimulatorApp = true;
          openSimulatorSignal = signal;
          return rejectWhenAborted(signal);
        },
      },
    );

    const firstStart = harness.createClient().startSimulator(UDID, 100);
    await waitForCondition(() => openingSimulatorApp, "Simulator.app focus");
    const waitingStart = harness
      .createClient()
      .startSimulator(UDID, 5_000)
      .catch((error: unknown) => error);
    await drainMicrotasks();
    expect(harness.bootstatusInvocations()).toBe(1);

    harness.timer.advanceTime(100);

    await expect(firstStart).resolves.toBeDefined();
    expect(openSimulatorSignal?.aborted).toBe(true);
    const waitingError = await waitingStart;
    expect(waitingError).toBeInstanceOf(ActionableError);
    expect((waitingError as Error).message).toBe(`iOS simulator ${UDID} is already running`);
    expect(harness.bootstatusInvocations()).toBe(1);
    expect(harness.shutdownInvocations()).toBe(0);
  });

  test("does not reuse stale success after an idle start is shut down", async () => {
    const harness = createConcurrentStartHarness(() => Promise.resolve(createExecResult("", "")));
    const firstHandle = await harness.createClient().startSimulator(UDID, 5_000);
    if (!firstHandle) {
      throw new Error("The owning start must return a cancellation handle");
    }
    expect(firstHandle.kill()).toBe(true);
    await drainMicrotasks();

    const abortedOwnerController = new AbortController();
    const abortedOwner = runWithAbortSignal(abortedOwnerController.signal, () =>
      harness.createClient().startSimulator(UDID, 5_000),
    ).catch((error: unknown) => error);
    const waitingStart = harness.createClient().startSimulator(UDID, 5_000);
    abortedOwnerController.abort(new Error("new owner cancelled"));

    await expect(abortedOwner).resolves.toBeInstanceOf(Error);
    await expect(waitingStart).resolves.not.toBeNull();
    expect(harness.bootstatusInvocations()).toBe(2);
    expect(harness.shutdownInvocations()).toBe(1);
  });

  test("bounds and cancels same-UDID start lock waiters without booting or cleanup", async () => {
    const harness = createConcurrentStartHarness((_invocation, signal) =>
      rejectWhenAborted(signal, true),
    );
    const ownerController = new AbortController();
    const cancelledWaiterController = new AbortController();
    const ownerStart = runWithAbortSignal(ownerController.signal, () =>
      harness.createClient().startSimulator(UDID, 5_000),
    );
    await waitForCondition(
      () => harness.bootstatusInvocations() === 1,
      "the lock-owning bootstatus command",
    );
    const cancelledWaiter = runWithAbortSignal(cancelledWaiterController.signal, () =>
      harness.createClient().startSimulator(UDID, 5_000),
    ).catch((error: unknown) => error);
    const timedOutWaiter = harness
      .createClient()
      .startSimulator(UDID, 100)
      .catch((error: unknown) => error);
    await drainMicrotasks();

    cancelledWaiterController.abort(new Error("waiting request cancelled"));
    harness.timer.advanceTime(100);

    const cancelledError = await cancelledWaiter;
    const timedOutError = await timedOutWaiter;
    ownerController.abort(new Error("owner request cancelled"));
    await expect(ownerStart).rejects.toThrow("owner request cancelled");

    expect(cancelledError).toBeInstanceOf(Error);
    expect((cancelledError as Error).message).toBe("waiting request cancelled");
    expect(timedOutError).toBeInstanceOf(Error);
    expect((timedOutError as Error).message).toBe(
      `Timed out waiting to start iOS simulator ${UDID}`,
    );
    expect(harness.bootstatusInvocations()).toBe(1);
    expect(harness.shutdownInvocations()).toBe(1);
  });

  test("handle.kill shutdown does not inherit an aborted request signal", async () => {
    const harness = createHarness({ maxAttempts: 1, retryBackoffMs: 10 });
    harness.setStates(["Booted"]);
    const handle = await harness.timer.resolvePromise(harness.simctl.startSimulator(UDID, 5_000));
    const controller = new AbortController();
    controller.abort(new Error("request cancelled"));

    await runWithAbortSignal(controller.signal, async () => {
      expect(handle.kill()).toBe(true);
      await drainMicrotasks();
    });

    const shutdownSignal = harness.commandSignals.get(`xcrun simctl shutdown ${UDID}`)?.[0];
    expect(shutdownSignal).toBeDefined();
    expect(shutdownSignal?.aborted).toBe(false);
  });

  test("serializes handle shutdown with cold-readiness metadata and clears success", async () => {
    let completeMetadata: (() => void) | undefined;
    const harness = createConcurrentStartHarness(
      () => Promise.resolve(createExecResult("", "")),
      (invocation) => {
        if (invocation !== 2) {
          return bootedSimulatorListResult();
        }
        return new Promise((resolve) => {
          completeMetadata = () => resolve(bootedSimulatorListResult());
        });
      },
    );
    const handle = await harness.createClient().startSimulator(UDID, 5_000);
    const readiness = harness
      .createClient()
      .waitForSimulatorReady(UDID, 5_000, { assumeBooted: true });
    await waitForCondition(() => completeMetadata !== undefined, "cold-readiness metadata");

    expect(handle.kill()).toBe(true);
    await drainMicrotasks();
    expect(harness.shutdownInvocations()).toBe(0);
    completeMetadata();

    await expect(readiness).resolves.toMatchObject({ deviceId: UDID });
    await waitForCondition(
      () => harness.shutdownInvocations() === 1,
      "coordinated handle shutdown",
    );
    await expect(harness.createClient().startSimulator(UDID, 5_000)).resolves.toBeDefined();
    expect(harness.lifecycleCalls).toEqual(["bootstatus-1", "shutdown", "bootstatus-2"]);
  });

  test("bounds cold-readiness metadata while retaining the boot lease", async () => {
    let metadataSignal: AbortSignal | undefined;
    const harness = createConcurrentStartHarness(
      () => Promise.resolve(createExecResult("", "")),
      (invocation, signal) => {
        if (invocation > 1) {
          return bootedSimulatorListResult();
        }
        metadataSignal = signal;
        return rejectWhenAborted(signal);
      },
    );
    const readiness = harness
      .createClient()
      .waitForSimulatorReady(UDID, 100, { assumeBooted: true });
    await waitForCondition(() => metadataSignal !== undefined, "bounded cold-readiness metadata");

    harness.timer.advanceTime(100);

    await expect(readiness).rejects.toThrow(
      "Command timed out after 100ms: xcrun simctl list devices --json",
    );
    expect(metadataSignal?.aborted).toBe(true);
    await expect(harness.createClient().startSimulator(UDID, 5_000)).resolves.toBeDefined();
    expect(harness.shutdownInvocations()).toBe(0);
  });

  test("serializes killSimulator behind in-flight readiness verification", async () => {
    let completeReadiness: (() => void) | undefined;
    const harness = createConcurrentStartHarness(
      () =>
        new Promise((resolve) => {
          completeReadiness = () => resolve(createExecResult("", ""));
        }),
    );
    const readiness = harness.createClient().waitForSimulatorReady(UDID, 120_000);
    await waitForCondition(() => completeReadiness !== undefined, "readiness verification");
    const kill = harness.createClient().killSimulator({
      name: "iPhone 17",
      platform: "ios",
      deviceId: UDID,
    });
    harness.timer.advanceTime(10_001);
    await drainMicrotasks();
    expect(harness.shutdownInvocations()).toBe(0);

    completeReadiness();

    await expect(readiness).resolves.toMatchObject({ deviceId: UDID });
    await expect(kill).resolves.toBeUndefined();
    expect(harness.lifecycleCalls).toEqual(["bootstatus-1", "shutdown"]);
  });

  test("preserves successful boot state when coordinated shutdown fails", async () => {
    let completeOwnerBootstatus: (() => void) | undefined;
    const shutdownError = new Error("shutdown failed");
    const harness = createConcurrentStartHarness(
      (invocation) => {
        if (invocation > 1) {
          return Promise.resolve(createExecResult("", ""));
        }
        return new Promise((resolve) => {
          completeOwnerBootstatus = () => resolve(createExecResult("", ""));
        });
      },
      bootedSimulatorListResult,
      {
        shutdown: () => Promise.reject(shutdownError),
      },
    );
    const owner = harness.createClient().startSimulator(UDID, 5_000);
    await waitForCondition(() => completeOwnerBootstatus !== undefined, "owner bootstatus");
    const kill = harness
      .createClient()
      .killSimulator({ name: "iPhone 17", platform: "ios", deviceId: UDID })
      .catch((error: unknown) => error);
    const waitingStart = harness
      .createClient()
      .startSimulator(UDID, 5_000)
      .catch((error: unknown) => error);
    completeOwnerBootstatus();

    await expect(owner).resolves.toBeDefined();
    await expect(kill).resolves.toBe(shutdownError);
    const waitingError = await waitingStart;
    expect(waitingError).toBeInstanceOf(ActionableError);
    expect((waitingError as Error).message).toBe(`iOS simulator ${UDID} is already running`);
    expect(harness.bootstatusInvocations()).toBe(1);
  });

  test("a wedged boot (bootstatus exit 0, device Shutdown) fails with an actionable error", async () => {
    const harness = createHarness({ maxAttempts: 1, retryBackoffMs: 10 });

    const error = await harness.timer.resolvePromise(
      harness.simctl.startSimulator(UDID, 5000).then(
        () => null,
        (err: unknown) => err,
      ),
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
    const simctl = new SimCtlClient(
      null,
      async (file, args) => {
        const command = `${file} ${args.join(" ")}`;
        calls.push(command);
        if (command === "xcrun simctl --version") {
          return createExecResult("simctl version 1.0.0", "");
        }
        if (args[1] === "bootstatus") {
          throw error;
        }
        return createExecResult("", "");
      },
      new FakeTimer(),
      "darwin",
      undefined,
      undefined,
      { maxAttempts: 2, retryBackoffMs: 10 },
    );

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

  test("caps the complete retry sequence at the caller timeout", async () => {
    const harness = createHarness({ maxAttempts: 3, retryBackoffMs: 10_000 });
    const boot = harness.simctl.startSimulator(UDID, 5000).then(
      () => null,
      (error: unknown) => error,
    );

    // Set up the first retry before advancing fake time so its deadline starts at zero.
    await waitForCondition(
      () => harness.timer.getPendingSleepCount() === 1,
      "the retry backoff sleep",
    );
    const error = await harness.timer.resolvePromise(boot);

    expect(error).toBeInstanceOf(Error);
    expect(harness.timer.now()).toBe(5000);
    expect(harness.timer.getSleepHistory()).toEqual([5000]);
    expect(bootstatusCalls(harness.calls).length).toBe(1);
    expect(shutdownCalls(harness.calls).length).toBe(2);
  });

  test("stops after the bounded attempt count and reports the observed state", async () => {
    const harness = createHarness({ maxAttempts: 3, retryBackoffMs: 25 });

    const error = await harness.timer.resolvePromise(
      harness.simctl.startSimulator(UDID, 5000).then(
        () => null,
        (err: unknown) => err,
      ),
    );

    expect((error as Error).message).toContain("after 3 boot attempt(s)");
    expect(bootstatusCalls(harness.calls).length).toBe(3);
    expect(shutdownCalls(harness.calls).length).toBe(3);
    expect(harness.timer.getSleepHistory()).toEqual([25, 25]);
  });

  test("a bootstatus failure propagates immediately without burning a retry", async () => {
    const harness = createHarness({ maxAttempts: 3, retryBackoffMs: 10 });
    harness.failBootStatusWith(new Error("Invalid device: nope"));

    const error = await harness.timer.resolvePromise(
      harness.simctl.startSimulator(UDID, 5000).then(
        () => null,
        (err: unknown) => err,
      ),
    );

    expect((error as Error).message).toContain("Invalid device");
    expect(bootstatusCalls(harness.calls).length).toBe(1);
    expect(shutdownCalls(harness.calls).length).toBe(1);
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
    expect(shutdownCalls(harness.calls).length).toBe(1);
  });

  test("bootSimulator retries a wedged boot and returns the device once Booted", async () => {
    const harness = createHarness({ maxAttempts: 2, retryBackoffMs: 10 });
    harness.setStates(["Shutdown", "Booted"]);

    // FakeTimer: the retry backoff must be driven, as in the startSimulator case.
    const device = await harness.timer.resolvePromise(harness.simctl.bootSimulator(UDID));

    expect(device.deviceId).toBe(UDID);
    expect(bootstatusCalls(harness.calls).length).toBe(2);
    expect(shutdownCalls(harness.calls).length).toBe(1);
    expect(commandTimeouts(harness, `xcrun simctl bootstatus ${UDID} -b`)).toEqual([true, true]);
    expect(commandTimeouts(harness, "xcrun simctl list devices --json")).toEqual([
      true,
      true,
      true,
    ]);
  });

  test("waitForSimulatorReady rejects a wedged boot instead of returning a device", async () => {
    const harness = createHarness({ maxAttempts: 1, retryBackoffMs: 10 });

    const error = await harness.timer.resolvePromise(
      harness.simctl.waitForSimulatorReady(UDID, 5000).then(
        () => null,
        (err: unknown) => err,
      ),
    );

    expect(error).toBeInstanceOf(ActionableError);
    expect((error as Error).message).toContain("failed to become ready");
    expect((error as Error).message).toContain("Shutdown");
    expect(shutdownCalls(harness.calls).length).toBe(0);
  });
});

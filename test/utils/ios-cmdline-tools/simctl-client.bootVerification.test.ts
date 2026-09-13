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
  /** Queue successive `bootstatus` rejections, one per invocation. */
  queueBootStatusFailures(errors: Array<Error | null>): void;
  /** Make the next N `list devices --json` invocations reject with `error`. */
  failListDevicesWith(error: Error, times?: number): void;
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
  let listDevicesFailuresRemaining = 0;
  let listDevicesFailure: Error | null = null;
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
      if (listDevicesFailuresRemaining > 0) {
        listDevicesFailuresRemaining--;
        throw listDevicesFailure;
      }
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
    queueBootStatusFailures: (errors) => {
      bootStatusFailures = [...errors];
    },
    failListDevicesWith: (error, times = 1) => {
      listDevicesFailure = error;
      listDevicesFailuresRemaining = times;
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

function coreSimulator405ErrorForState(state: string): Error {
  return coreSimulator405Error(
    "Device boot failed\n" +
      "An error was encountered processing the command " +
      "(domain=com.apple.CoreSimulator.SimError, code=405): " +
      `Unable to boot device in current state: ${state}`,
  );
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

  test("does not spend the cold-boot budget focusing an already booted simulator", async () => {
    let openSignal: AbortSignal | undefined;
    const harness = createConcurrentStartHarness(
      () => Promise.resolve(createExecResult("", "")),
      bootedSimulatorListResult,
      {
        openSimulatorApp: (signal) => {
          openSignal = signal;
          return rejectWhenAborted(signal);
        },
      },
    );
    let completed = false;
    const start = harness
      .createClient()
      .startSimulator(UDID, 180_000)
      .then(() => {
        completed = true;
      });
    await waitForCondition(() => openSignal !== undefined, "Simulator.app focus");
    harness.timer.advanceTime(1_000);
    await drainMicrotasks();
    expect(completed).toBe(true);
    expect(openSignal?.aborted).toBe(true);
    expect(harness.shutdownInvocations()).toBe(0);
    await start;
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

  test("bounds killSimulator's boot-lease wait when no signal ever aborts it", async () => {
    // Simulate a wedged boot: readiness never resolves, so the boot lease is
    // held indefinitely. killSimulator (via deviceBootRecovery / handle.kill())
    // is called with no ambient abort signal (no getAbortSignal() in scope).
    let releaseBoot!: () => void;
    const harness = createConcurrentStartHarness(
      () =>
        new Promise((resolve) => {
          releaseBoot = () => resolve(createExecResult("", ""));
        }),
    );
    // A huge readiness timeout keeps the boot's own internal bootstatus exec
    // timeout from firing within this test's assertion window, isolating the
    // boot-lease wait's own deadline as the only thing that can settle `kill`.
    const readiness = harness.createClient().waitForSimulatorReady(UDID, 10_000_000);
    await drainMicrotasks();

    const kill = harness
      .createClient()
      .killSimulator({ name: "iPhone 17", platform: "ios", deviceId: UDID })
      .catch((error: unknown) => error);

    harness.timer.advanceTime(DEFAULT_DEVICE_READY_TIMEOUT_MS);
    await drainMicrotasks();

    const killResult = await kill;
    expect(killResult).toBeInstanceOf(Error);
    expect((killResult as Error).message).toBe(
      `Timed out waiting to shut down iOS simulator ${UDID}`,
    );
    expect(harness.shutdownInvocations()).toBe(0);

    releaseBoot();
    await readiness;
    await drainMicrotasks();
    expect(harness.shutdownInvocations()).toBe(0);
    await harness
      .createClient()
      .killSimulator({ name: "iPhone 17", platform: "ios", deviceId: UDID });
    expect(harness.shutdownInvocations()).toBe(1);
    expect(harness.timer.getPendingTimeoutCount()).toBe(0);
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

  // Issue #6411: CoreSimulator also emits the 405 with the domain/code appended
  // *inline after* the reported state ("...current state: Booted (domain=...,
  // code=405)"). A greedy state capture folded that trailing clause into the
  // reported state, so it no longer equalled "Booted" and the already-booted
  // simulator was rethrown instead of accepted.
  test("accepts a CoreSimulator 405 whose domain/code is appended inline after the state", async () => {
    const harness = createHarness({ maxAttempts: 2, retryBackoffMs: 10 });
    harness.setStates(["Booted"]);
    harness.failBootStatusWith(
      coreSimulator405Error(
        "Unable to boot device in current state: Booted " +
          "(domain=com.apple.CoreSimulator.SimError, code=405)",
      ),
    );

    const handle = await harness.timer.resolvePromise(harness.simctl.startSimulator(UDID, 5000));

    expect(handle).toBeDefined();
    expect(bootstatusCalls(harness.calls).length).toBe(1);
    expect(shutdownCalls(harness.calls).length).toBe(0);
    expect(harness.timer.getSleepCallCount()).toBe(0);
  });

  test("retries a contradictory CoreSimulator 405 response when the simulator is not Booted", async () => {
    const harness = createHarness({ maxAttempts: 2, retryBackoffMs: 10 });
    // The verification read after the 405 sees the genuine wedge (Shutdown);
    // the post-shutdown settle poll observes one in-flight transition
    // (Shutting Down, requiring the backoff) before Shutdown settles; the
    // retried bootstatus then sees the device Booted.
    harness.setStates(["Shutdown", "Shutting Down", "Shutdown", "Booted"]);
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

    // First verification sees the wedge; the post-shutdown settle poll
    // observes the in-flight transition (requiring the backoff) before the
    // device settles; the retry then sees a real boot.
    harness.setStates(["Shutdown", "Shutting Down", "Booted"]);

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
    // 3 reads: the post-bootstatus-1 verification, the post-shutdown settle
    // poll, and the post-bootstatus-2 verification.
    expect(commandTimeouts(harness, "xcrun simctl list devices --json")).toEqual([
      true,
      true,
      true,
    ]);
    expect(commandTimeouts(harness, `xcrun simctl shutdown ${UDID}`)).toEqual([true]);
  });

  test("caps the complete retry sequence at the caller timeout", async () => {
    const harness = createHarness({ maxAttempts: 3, retryBackoffMs: 10_000 });
    // Never settles, so the post-shutdown poll keeps sleeping (bounded by the
    // deadline) instead of ever re-issuing bootstatus.
    harness.setStates(["Shutting Down"]);
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
    // Each of the 2 retry shutdowns is followed by one in-flight transition
    // (requiring the backoff) before settling back to Shutdown; the device
    // never reaches Booted, so all 3 attempts are consumed.
    harness.setStates([
      "Shutdown",
      "Shutting Down",
      "Shutdown",
      "Shutdown",
      "Shutting Down",
      "Shutdown",
      "Shutdown",
    ]);

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
    // 4 reads: the post-bootstatus-1 verification, the post-shutdown settle
    // poll, the post-bootstatus-2 verification, and the post-boot metadata
    // resolution (resolveReadySimulator).
    expect(commandTimeouts(harness, "xcrun simctl list devices --json")).toEqual([
      true,
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

  // Issue #6413: the boot deadline elapsing between recovery steps must
  // surface as a classified `ActionableError` naming the UDID from every
  // entry point on the boot path, not as a bare `Error` on some of them.
  test("bootSimulator rejects with an ActionableError naming the UDID when the boot deadline elapses between recovery steps", async () => {
    // maxAttempts: 2 with an oversized retryBackoffMs so the retry-backoff
    // sleep is bounded by the boot deadline itself
    // (`Math.min(retryBackoffMs, remainingBootTimeoutMs(...))`), landing fake
    // time exactly on the deadline once the sleep resolves. The next recovery
    // step (attempt 2's `bootstatus`) then discovers the elapsed deadline
    // before issuing any command.
    const harness = createHarness({ maxAttempts: 2, retryBackoffMs: 999_999_999 });
    harness.setStates(["Shutdown"]);

    const boot = harness.simctl.bootSimulator(UDID);
    await drainMicrotasks();
    harness.timer.advanceTime(DEFAULT_DEVICE_READY_TIMEOUT_MS);

    await expect(boot).rejects.toBeInstanceOf(ActionableError);
    await expect(boot).rejects.toThrow(new RegExp(UDID));
  });

  test("waitForSimulatorReady with assumeBooted rejects with an ActionableError naming the UDID when the boot deadline elapses", async () => {
    const harness = createConcurrentStartHarness(() => Promise.resolve(createExecResult("", "")));

    // A timeout budget of 0ms means the deadline has already elapsed by the
    // time the cold-boot metadata resolution step runs.
    const readiness = harness.createClient().waitForSimulatorReady(UDID, 0, { assumeBooted: true });

    await expect(readiness).rejects.toBeInstanceOf(ActionableError);
    await expect(readiness).rejects.toThrow(new RegExp(UDID));
  });

  // #6412: bootSimulator (-> resolveRegisteredBootSimulator ->
  // getBootedSimulatorsChecked) and waitForSimulatorReady (->
  // resolveReadySimulator -> listSimulatorImages) resolve a finished boot
  // through two independent listings. Both must agree on whether a `Booted`
  // record with missing/false `isAvailable` counts as booted.
  function bootedDeviceListResult(isAvailable: boolean | undefined, availabilityError?: string) {
    const device: Record<string, unknown> = {
      udid: UDID,
      name: "iPhone 17",
      state: "Booted",
    };
    if (isAvailable !== undefined) {
      device.isAvailable = isAvailable;
    }
    if (availabilityError !== undefined) {
      device.availabilityError = availabilityError;
    }
    return createExecResult(
      JSON.stringify({
        devices: {
          "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [device],
        },
      }),
      "",
    );
  }

  test("bootSimulator and waitForSimulatorReady agree when isAvailable is absent", async () => {
    const bootHarness = createConcurrentStartHarness(
      () => createExecResult("", ""),
      () => bootedDeviceListResult(undefined),
    );
    const readyHarness = createConcurrentStartHarness(
      () => createExecResult("", ""),
      () => bootedDeviceListResult(undefined),
    );

    const bootDevice = await bootHarness
      .createClient()
      .bootSimulator(UDID)
      .then(
        (device) => ({ ok: true as const, device }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    const readyDevice = await readyHarness
      .createClient()
      .waitForSimulatorReady(UDID, 5_000)
      .then(
        (device) => ({ ok: true as const, device }),
        (error: unknown) => ({ ok: false as const, error }),
      );

    expect(bootDevice.ok).toBe(true);
    expect(readyDevice.ok).toBe(true);
    if (bootDevice.ok && readyDevice.ok) {
      expect(bootDevice.device.deviceId).toBe(UDID);
      expect(readyDevice.device.deviceId).toBe(UDID);
    }
  });

  test("bootSimulator and waitForSimulatorReady agree when isAvailable is false", async () => {
    const availabilityError = "the requested device runtime is unavailable";
    const bootHarness = createConcurrentStartHarness(
      () => createExecResult("", ""),
      () => bootedDeviceListResult(false, availabilityError),
    );
    const readyHarness = createConcurrentStartHarness(
      () => createExecResult("", ""),
      () => bootedDeviceListResult(false, availabilityError),
    );

    const bootError = await bootHarness
      .createClient()
      .bootSimulator(UDID)
      .then(
        () => null,
        (error: unknown) => error,
      );
    const readyError = await readyHarness
      .createClient()
      .waitForSimulatorReady(UDID, 5_000)
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(bootError).toBeInstanceOf(ActionableError);
    expect(readyError).toBeInstanceOf(ActionableError);
    expect((bootError as Error).message).toContain(availabilityError);
    expect((readyError as Error).message).toContain(availabilityError);
  });

  // Issue #6411: `readSimulatorState` used to collapse "device absent from
  // the listing" and "the listing itself failed" into the same `undefined`,
  // so a single transient `simctl list devices --json` hiccup at the end of
  // an otherwise healthy boot looked identical to "not Booted" and tore the
  // simulator back down.
  test("does not shut down a healthy simulator when a single state read fails transiently", async () => {
    const harness = createHarness({ maxAttempts: 2, retryBackoffMs: 10 });
    harness.setStates(["Booted"]);
    harness.failListDevicesWith(new Error("simctl list devices --json timed out"), 1);

    const handle = await harness.timer.resolvePromise(harness.simctl.startSimulator(UDID, 5000));

    expect(handle).toBeDefined();
    expect(bootstatusCalls(harness.calls).length).toBe(1);
    expect(shutdownCalls(harness.calls).length).toBe(0);
  });

  // Issue #6411: a boot deadline long enough to survive more than one
  // transient read failure must not be treated as an unrecoverable "unknown
  // state" — it keeps retrying the read itself within the deadline.
  test("retries an unreadable state repeatedly within the deadline without shutting down", async () => {
    const harness = createHarness({ maxAttempts: 2, retryBackoffMs: 10 });
    harness.setStates(["Booted"]);
    harness.failListDevicesWith(new Error("simctl list devices --json timed out"), 3);

    const handle = await harness.timer.resolvePromise(harness.simctl.startSimulator(UDID, 5000));

    expect(handle).toBeDefined();
    expect(bootstatusCalls(harness.calls).length).toBe(1);
    expect(shutdownCalls(harness.calls).length).toBe(0);
  });

  // Issue #6411: `isAlreadyBootedCoreSimulator405` only tolerated the literal
  // "current state: Booted" 405. Widened so a mid-transition rejection (e.g.
  // a prior retry's own `shutdown` not having settled yet) is recognized and
  // waited out instead of rethrown, which previously aborted the whole boot
  // without spending a retry.
  test("polls for settlement and retries within the same attempt on a mid-transition CoreSimulator 405", async () => {
    const harness = createHarness({ maxAttempts: 2, retryBackoffMs: 15 });
    harness.queueBootStatusFailures([coreSimulator405ErrorForState("Shutting Down")]);
    harness.setStates(["Shutting Down", "Booted"]);

    const handle = await harness.timer.resolvePromise(harness.simctl.startSimulator(UDID, 5000));

    expect(handle).toBeDefined();
    // bootstatus is re-issued once the transition settles, but this does not
    // burn a shutdown-and-retry cycle: no shutdown is ever issued.
    expect(bootstatusCalls(harness.calls).length).toBe(2);
    expect(shutdownCalls(harness.calls).length).toBe(0);
    expect(harness.timer.getSleepHistory()).toEqual([15, 15]);
  });

  // Issue #6411: `Booting` must be tolerated the same way as `Shutting Down`.
  test("polls for settlement on a Booting mid-transition CoreSimulator 405", async () => {
    const harness = createHarness({ maxAttempts: 2, retryBackoffMs: 15 });
    harness.queueBootStatusFailures([coreSimulator405ErrorForState("Booting")]);
    harness.setStates(["Booting", "Booted"]);

    const handle = await harness.timer.resolvePromise(harness.simctl.startSimulator(UDID, 5000));

    expect(handle).toBeDefined();
    expect(bootstatusCalls(harness.calls).length).toBe(2);
    expect(shutdownCalls(harness.calls).length).toBe(0);
  });

  // Issue #6411: a reported current state the loop has no recovery for (not
  // Booted and not a recognized mid-transition state) must still rethrow
  // rather than loop or silently proceed.
  test("rethrows a CoreSimulator 405 reporting a state with no known recovery", async () => {
    const harness = createHarness({ maxAttempts: 2, retryBackoffMs: 10 });
    const error = coreSimulator405ErrorForState("Creating");
    harness.failBootStatusWith(error);

    await expect(harness.simctl.startSimulator(UDID, 5000)).rejects.toBe(error);
    expect(shutdownCalls(harness.calls).length).toBe(1);
  });
  test("backs off repeated transition errors even when discovery is already settled", async () => {
    const harness = createHarness({ maxAttempts: 1, retryBackoffMs: 0 });
    harness.queueBootStatusFailures([
      coreSimulator405ErrorForState("Shutting Down"),
      coreSimulator405ErrorForState("Shutting Down"),
    ]);
    harness.setStates(["Shutdown", "Shutdown", "Booted"]);
    await harness.timer.resolvePromise(harness.simctl.startSimulator(UDID, 5000));
    expect(bootstatusCalls(harness.calls)).toHaveLength(3);
    expect(harness.timer.getSleepHistory()).toEqual([250, 250]);
  });

  test("cancellation during a discovery retry releases the boot lease without more reads", async () => {
    const harness = createHarness({ maxAttempts: 1, retryBackoffMs: 0 });
    harness.failListDevicesWith(new Error("discovery unavailable"), 100);
    const controller = new AbortController();
    const outcome = runWithAbortSignal(controller.signal, () =>
      harness.simctl.startSimulator(UDID, 120000),
    ).catch((error: unknown) => error);
    for (let turn = 0; turn < 100; turn++) {
      await Promise.resolve();
    }
    expect(harness.timer.getPendingTimeouts()).toContain(250);
    const reason = new Error("request cancelled during discovery");
    controller.abort(reason);
    expect(await outcome).toBe(reason);
    expect(harness.timer.getPendingTimeoutCount()).toBe(0);
    expect(harness.calls.filter((call) => call.includes("list devices"))).toHaveLength(1);
    expect(shutdownCalls(harness.calls)).toHaveLength(1);
    expect(harness.timer.now()).toBe(0);
    harness.failListDevicesWith(new Error("unused"), 0);
    harness.setStates(["Booted"]);
    await harness.simctl.startSimulator(UDID, 5000);
  });
  test("persistent discovery failures stop at the boot deadline", async () => {
    const harness = createHarness({ maxAttempts: 1, retryBackoffMs: 0 });
    harness.failListDevicesWith(new Error("discovery unavailable"), 100);
    const outcome = harness.simctl.startSimulator(UDID, 1000).catch((error: unknown) => error);
    expect(await harness.timer.resolvePromise(outcome)).toBeInstanceOf(Error);
    expect(harness.timer.now()).toBe(1000);
    expect(
      harness.calls.filter((call) => call.includes("list devices")).length,
    ).toBeLessThanOrEqual(4);
    expect(shutdownCalls(harness.calls)).toHaveLength(1);
  });

  test("zero configured backoff still bounds transition polling by the deadline", async () => {
    const harness = createHarness({ maxAttempts: 1, retryBackoffMs: 0 });
    harness.failBootStatusWith(coreSimulator405ErrorForState("Booting"));
    harness.setStates(["Booting"]);
    const outcome = harness.simctl.startSimulator(UDID, 1000).catch((error: unknown) => error);
    expect(await harness.timer.resolvePromise(outcome)).toBeInstanceOf(Error);
    expect(harness.timer.now()).toBe(1000);
    expect(harness.timer.getSleepHistory().every((delay) => delay > 0)).toBe(true);
  });
});

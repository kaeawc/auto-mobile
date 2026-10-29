import { afterEach, describe, expect, test } from "bun:test";
import { executionTracker, type ActiveExecution } from "../../src/daemon/executionTracker";
import { admitInputOnHolderSession } from "../../src/daemon/inputDeviceOwnership";
import { SessionReleasedDuringCallError } from "../../src/daemon/sessionReleasedDuringCall";
import {
  InputDeviceGating,
  type InputDeviceGatingPorts,
} from "../../src/daemon/socketServer/inputDeviceGating";

/**
 * Input admission on the holder's session runs under the caller's explicit signal, not the ambient
 * one (#15671): the `input/*` paths run outside `runWithAbortSignal`, so an ambient read saw no
 * signal and a release or client cancel could not stop an admission that waits (for example on
 * restart recovery). A call with no signal still admits as before.
 */

type DaemonStateView = ReturnType<InputDeviceGatingPorts["daemonState"]>;
type DevicePoolView = ReturnType<DaemonStateView["getDevicePool"]>;
type SessionManagerView = ReturnType<DaemonStateView["getSessionManager"]>;

const SESSION = "11111111-2222-4333-8444-555555555555";
const DEVICE = "emulator-5554";

const unused = (): never => {
  throw new Error("not used by input admission");
};

/** Admission that waits until `finish()` or until its signal aborts, as restart recovery does. */
class BlockingAdmission {
  readonly signals: Array<AbortSignal | undefined> = [];
  private unblock: () => void = () => {};
  readonly getSession = (): null => null;
  readonly getSessionForDevice = (): string => SESSION;
  readonly getDeviceLabels = unused;

  admitIssuedSessionForAutomation(
    _sessionId: string,
    _execution: unknown,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ assignedDevice: string }> {
    const { signal } = options;
    this.signals.push(signal);
    return new Promise((resolve, reject) => {
      this.unblock = () => resolve({ assignedDevice: DEVICE });
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }

  finish(): void {
    this.unblock();
  }
}

function observe(promise: Promise<unknown>): { settled: boolean; error: unknown } {
  const state: { settled: boolean; error: unknown } = { settled: false, error: undefined };
  promise.then(
    () => {
      state.settled = true;
    },
    (error: unknown) => {
      state.settled = true;
      state.error = error;
    },
  );
  return state;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe("admitInputOnHolderSession takes the caller's signal", () => {
  test("a cancel while admission waits stops it with the cancel's reason", async () => {
    const admission = new BlockingAdmission();
    const controller = new AbortController();
    const state = observe(
      admitInputOnHolderSession({
        deviceId: DEVICE,
        holderSessionUuid: SESSION,
        sessionManager: admission,
        execution: { executionId: "input-1", startTime: 0 },
        signal: controller.signal,
      }),
    );
    await flush();
    expect(state.settled).toBe(false);

    const reason = new Error("client cancelled");
    controller.abort(reason);
    await flush();

    expect(admission.signals).toEqual([controller.signal]);
    expect(state).toEqual({ settled: true, error: reason });
    admission.finish();
  });

  test("with no signal it admits as before", async () => {
    const admission = new BlockingAdmission();
    const state = observe(
      admitInputOnHolderSession({
        deviceId: DEVICE,
        holderSessionUuid: SESSION,
        sessionManager: admission,
        execution: { executionId: "input-2", startTime: 0 },
        signal: undefined,
      }),
    );
    admission.finish();
    await flush();

    expect(admission.signals).toEqual([undefined]);
    expect(state).toEqual({ settled: true, error: undefined });
  });
});

describe("InputDeviceGating.admitInputAsControlCall threads the execution and owner signals", () => {
  const started: ActiveExecution[] = [];

  afterEach(() => {
    for (const execution of started.splice(0)) {
      executionTracker.endExecution(execution.id);
    }
  });

  function startInput(): ActiveExecution {
    const execution = executionTracker.startExecution("input/tap", undefined, SESSION);
    started.push(execution);
    return execution;
  }

  test("a release of the holder's session while admission waits answers the release", async () => {
    const admission = new BlockingAdmission();
    const execution = startInput();
    const state = observe(
      gatingWith(admission).admitInputAsControlCall(execution, DEVICE, SESSION, undefined),
    );
    await flush();
    expect(state.settled).toBe(false);

    const release = new SessionReleasedDuringCallError(SESSION, "explicit-release");
    await executionTracker.cancelSessionUuidExecutions(SESSION, release);
    await flush();

    expect(state).toEqual({ settled: true, error: release });
    admission.finish();
  });

  test("the frame's own cancel while admission waits stops it", async () => {
    const admission = new BlockingAdmission();
    const owner = new AbortController();
    const state = observe(
      gatingWith(admission).admitInputAsControlCall(startInput(), DEVICE, SESSION, owner.signal),
    );
    await flush();
    expect(state.settled).toBe(false);

    const closed = new Error("socket closed");
    owner.abort(closed);
    await flush();

    expect(state).toEqual({ settled: true, error: closed });
    admission.finish();
  });

  test("with no owner signal an uncancelled input admits as before", async () => {
    const admission = new BlockingAdmission();
    const execution = startInput();
    const state = observe(
      gatingWith(admission).admitInputAsControlCall(execution, DEVICE, SESSION, undefined),
    );
    admission.finish();
    await flush();

    expect(admission.signals).toEqual([execution.abortController.signal]);
    expect(state).toEqual({ settled: true, error: undefined });
  });
});

describe("InputDeviceGating.runTrackedDeviceInput hands admission the frame's signal", () => {
  const device = { deviceId: DEVICE, name: "Pixel", platform: "android" as const };

  async function runInput(ownerSignal: AbortSignal | undefined) {
    const admitted: Array<AbortSignal | undefined> = [];
    const gating = gatingWith(new BlockingAdmission(), {
      assertDeviceActionable: () => {},
      assertInputBindingGate: async () => {},
      inputTargetOwners: () => new WeakMap(),
      admitInputAsControlCall: async (_execution, _deviceId, _holder, signal) => {
        admitted.push(signal);
      },
      runFencedInputOperation: (tracker, owner, operation) =>
        gating.runFencedInputOperation(tracker, owner, operation),
    });
    const result = await gating.runTrackedDeviceInput(
      "input/admission-signal-test",
      device,
      async () => "sent",
      ownerSignal,
      () => SESSION,
    );
    return { admitted, result };
  }

  test("the frame's owner signal reaches admission", async () => {
    const owner = new AbortController();

    expect(await runInput(owner.signal)).toEqual({ admitted: [owner.signal], result: "sent" });
  });

  test("a frame with no owner signal admits with none, as before", async () => {
    expect(await runInput(undefined)).toEqual({ admitted: [undefined], result: "sent" });
  });
});

function gatingWith(
  admission: BlockingAdmission,
  overrides: Partial<InputDeviceGatingPorts> = {},
): InputDeviceGating {
  const pool: DevicePoolView = {
    resolveAutolockSessionForMcpSession: unused,
    assertSessionReadyForAutomation: () => {},
    reconcileDiscoveryObservation: unused,
    assertDeviceActionable: unused,
    assertNotAssignedToBinding: unused,
  };
  const sessions: SessionManagerView = admission;
  const gating: InputDeviceGating = new InputDeviceGating({
    daemonState: () => ({
      isInitialized: () => true,
      getSessionManager: () => sessions,
      getDevicePool: () => pool,
    }),
    selectInputTargetDevice: unused,
    assertFrameTargetProven: unused,
    assertBrokerConnectionInputTarget: unused,
    captureInputTargetOwner: unused,
    assertBrokerConnectionControl: unused,
    inputTargetOwners: unused,
    discoverInputTargetDevices: unused,
    runTrackedDeviceInput: unused,
    runKeyedMcpForward: unused,
    runHeldInputOperation: unused,
    timer: unused,
    holdDispatchedInputRequest: unused,
    assertDeviceActionable: unused,
    assertInputBindingGate: unused,
    admitInputAsControlCall: unused,
    runCancellableInputHandler: unused,
    answeringSessionRelease: (execution, run) => gating.answeringSessionRelease(execution, run),
    runFencedInputOperation: unused,
    canonicalFrameDiscovery: unused,
    reconcileDiscoveryObservation: unused,
    ...overrides,
  } satisfies InputDeviceGatingPorts);
  return gating;
}

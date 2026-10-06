import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "child_process";
import type { BootedDevice } from "../../src/models";
import { EmulatorLaunchCancelledError } from "../../src/models/EmulatorLaunchCancelledError";
import {
  AndroidRebootCoordinator,
  UnconfirmedRecoveryShutdownError,
  type AndroidRebootCoordinatorPoolPort,
} from "../../src/daemon/androidRebootCoordinator";
import { AndroidRecoveryRecordLedger } from "../../src/daemon/androidRecoveryRecordLedger";
import type { IdentityEvidence } from "../../src/devices/deviceIdentityEvidence";
import type { DeviceRecoveryPolicy, PooledDevice } from "../../src/daemon/devicePool";
import { DeviceCriteriaMatcher } from "../../src/daemon/DeviceCriteriaMatcher";
import { BoundedAndroidDeviceReboot } from "../../src/devices/androidDeviceReboot";
import type { PlatformDeviceManager } from "../../src/devices/deviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";

const oldDevice: PooledDevice = {
  id: "emulator-5554",
  name: "Pixel",
  platform: "android",
  avdName: "Pixel",
  androidImage: { name: "Pixel", platform: "android", isRunning: false, source: "local" },
  sessionId: null,
  status: "idle",
  lastUsedAt: 0,
  assignmentCount: 0,
  errorCount: 0,
  incarnation: 1,
};
const ready: BootedDevice = { deviceId: "emulator-5556", name: "Pixel", platform: "android" };

class FakePoolPort implements AndroidRebootCoordinatorPoolPort {
  readonly calls: string[] = [];
  readonly outcomes: string[] = [];
  readonly attempts: string[] = [];
  readonly attemptNumbers: number[] = [];
  cancelAt = 0;
  cancellationChecks = 0;

  constructor(
    private readonly manager: PlatformDeviceManager,
    private readonly timer: FakeTimer,
  ) {}

  getDeviceManager(): PlatformDeviceManager {
    return this.manager;
  }
  getTimer(): FakeTimer {
    return this.timer;
  }
  getRecoveryPolicy(): DeviceRecoveryPolicy {
    return { onLoss: true, maxAttempts: 1 } as DeviceRecoveryPolicy;
  }
  async completeEmulatorLossRecovery(
    _incidentId: string | undefined,
    outcome: "recovered" | "exhausted" | "not-attempted",
  ): Promise<void> {
    this.outcomes.push(outcome);
  }
  async recordEmulatorLossRecoveryAttempt(
    _incidentId: string | undefined,
    attempt: { attempt: number; outcome: "failed" | "succeeded" },
  ): Promise<void> {
    this.attempts.push(attempt.outcome);
    this.attemptNumbers.push(attempt.attempt);
  }
  setRecoveringAndroidImage(): void {
    this.calls.push("set-image");
  }
  addRecoveringAndroidDeviceId(id: string): void {
    this.calls.push(`recovering:${id}`);
  }
  setAndroidRecoveryHandoffOwner(): void {
    this.calls.push("set-owner");
  }
  clearAndroidRecoveryHandoffOwnerIfCurrent(): void {
    this.calls.push("clear-owner");
  }
  readonly finishes: { retainRecoveryImage: boolean; lateShutdownSettled?: Promise<unknown> }[] =
    [];
  finishAndroidRecoveryAttempt(
    _avdName: string,
    _recoveryDeviceIds: ReadonlySet<string>,
    retainRecoveryImage: boolean,
    _replacementHandoffOwner: symbol,
    lateShutdownSettled?: Promise<unknown>,
  ): void {
    this.calls.push("finish");
    this.finishes.push({ retainRecoveryImage, lateShutdownSettled });
  }
  async stopAndroidEmulatorForRecovery(
    _device: PooledDevice,
    _avdName: string,
    retainLeaseUntil: (settlement: Promise<unknown>) => void,
  ): Promise<"stopped"> {
    this.calls.push("stop");
    this.onStop?.(retainLeaseUntil);
    return "stopped";
  }
  onStop: ((retainLeaseUntil: (settlement: Promise<unknown>) => void) => void) | undefined;
  async rebindSameAvdReplacementSession(): Promise<boolean> {
    this.calls.push("rebind-same-avd");
    return true;
  }
  detachSessionForAndroidRecovery(): boolean {
    this.calls.push("detach");
    return true;
  }
  async removeDevice(
    id: string,
    awaitCacheCleanup = true,
    expectedDevice?: PooledDevice,
  ): Promise<void> {
    this.calls.push(`remove:${id}:${awaitCacheCleanup}:${expectedDevice === oldDevice}`);
  }
  async addDevice(device: BootedDevice): Promise<void> {
    this.calls.push(`add:${device.deviceId}`);
  }
  identityEvidenceForBootedDevice(): IdentityEvidence {
    this.calls.push("identity");
    return {} as IdentityEvidence;
  }
  async bindRecoveredAndroidDeviceSession(
    _previousDeviceId: string,
    _avdName: string,
    preservedSessionId: string | undefined,
  ): Promise<void> {
    await this.bindOrReuseDeviceSession(preservedSessionId);
  }
  async bindOrReuseDeviceSession(sessionId: string | undefined): Promise<void> {
    // This represents the pool-owned bind operation, which may self-lock internally.
    this.calls.push(`bind:${sessionId ?? "none"}`);
  }
  readonly stoppedProcesses: Array<ChildProcess | null | undefined> = [];
  onStopProcess:
    | ((child: ChildProcess | null | undefined, retain: (s: Promise<unknown>) => void) => void)
    | undefined;
  async stopEmulatorProcess(
    child?: ChildProcess | null,
    retainLeaseUntil?: (settlement: Promise<unknown>) => void,
  ): Promise<void> {
    this.stoppedProcesses.push(child);
    this.calls.push("stop-process");
    this.onStopProcess?.(child, retainLeaseUntil ?? (() => {}));
  }
  consumeAndroidRecoveryCancellation(): boolean {
    this.cancellationChecks++;
    return this.cancellationChecks === this.cancelAt;
  }
  // This represents direct assignmentMutex access. The coordinator has no such port member.
  acquireAssignmentMutex(): never {
    throw new Error("coordinator acquired assignmentMutex");
  }
}

function setup(
  startDevice: () => Promise<ChildProcess | null> = async () => null,
  waitForDeviceReady: () => Promise<BootedDevice> = async () => ready,
  maxAttempts = 1,
) {
  const timer = new FakeTimer();
  const manager = {
    startDevice,
    waitForDeviceReady,
  } as PlatformDeviceManager;
  const port = new FakePoolPort(manager, timer);
  const { outcomes, attempts } = port;
  const recordLedger = new AndroidRecoveryRecordLedger(
    { getDevice: () => null, getSession: () => null, clearAdbResetReservation: () => {} },
    timer,
  );
  // A legitimate pool bind may self-lock. Only a direct coordinator mutex access is forbidden.
  const guardedPort = new Proxy(port, {
    get(target, property, receiver) {
      if (property === "assignmentMutex" || property === "runExclusive") {
        return target.acquireAssignmentMutex();
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const coordinator = new AndroidRebootCoordinator(
    guardedPort,
    recordLedger,
    new DeviceCriteriaMatcher(),
    new BoundedAndroidDeviceReboot(timer, maxAttempts),
  );
  return { coordinator, port, outcomes, attempts, timer, recordLedger };
}

async function run(
  coordinator: AndroidRebootCoordinator,
  options: { preserveSessionId?: string } = {},
) {
  return await coordinator.rebootDisconnectedAndroidDeviceCoordinated(
    oldDevice,
    "incident",
    options,
    new AbortController().signal,
    () => {},
  );
}

describe("AndroidRebootCoordinator", () => {
  test("preserves retry attempt numbers and the FakeTimer backoff", async () => {
    let starts = 0;
    const { coordinator, port, outcomes, attempts, timer } = setup(
      async () => {
        if (++starts === 1) {
          throw new Error("first launch failed");
        }
        return null;
      },
      undefined,
      2,
    );
    timer.enableAutoAdvance();
    expect(await run(coordinator)).toBe(true);
    expect(port.attemptNumbers).toEqual([1, 2]);
    expect(attempts).toEqual(["failed", "succeeded"]);
    expect(outcomes).toEqual(["recovered"]);
    expect(timer.getSleepHistory()).toEqual([1000]);
    expect(port.calls.slice(-3)).toEqual(["bind:none", "clear-owner", "finish"]);
  });

  test("settles cancellation during a failed launch without a registered replacement", async () => {
    const controller = new AbortController();
    const { coordinator, port, outcomes, attempts } = setup(async () => {
      controller.abort(new Error("cancel launch"));
      throw controller.signal.reason;
    });
    expect(
      await coordinator.rebootDisconnectedAndroidDeviceCoordinated(
        oldDevice,
        "incident",
        {},
        controller.signal,
        () => {},
      ),
    ).toBe(false);
    expect(port.calls.slice(-2)).toEqual(["stop-process", "finish"]);
    expect(outcomes).toEqual(["not-attempted"]);
    expect(attempts).toEqual([]);
  });
  test("stops the child a cancelled launch carries on its error (#10075)", async () => {
    const controller = new AbortController();
    const spawned = { pid: 4242 } as ChildProcess;
    const { coordinator, port } = setup(async () => {
      controller.abort(new Error("cancel launch"));
      throw new EmulatorLaunchCancelledError("Pixel", spawned);
    });
    expect(
      await coordinator.rebootDisconnectedAndroidDeviceCoordinated(
        oldDevice,
        "incident",
        {},
        controller.signal,
        () => {},
      ),
    ).toBe(false);
    expect(port.stoppedProcesses).toEqual([spawned]);
    expect(port.calls.slice(-2)).toEqual(["stop-process", "finish"]);
  });
  describe("a relaunch cancelled during startup validation (#10075)", () => {
    const cancelledLaunch = () => {
      const controller = new AbortController();
      const spawned = { pid: 4242 } as ChildProcess;
      const harnessed = setup(async () => {
        controller.abort(new Error("cancel launch"));
        throw new EmulatorLaunchCancelledError("Pixel", spawned);
      });
      const leaseSettlements: Promise<unknown>[] = [];
      const exited = Promise.withResolvers<void>();
      const cancelledRun = () =>
        harnessed.coordinator.rebootDisconnectedAndroidDeviceCoordinated(
          oldDevice,
          "incident",
          {},
          controller.signal,
          (settlement) => {
            leaseSettlements.push(settlement);
          },
        );
      return { ...harnessed, spawned, exited, leaseSettlements, cancelledRun };
    };

    test("a child that cannot be confirmed exited keeps the lease on its exit and does not reserve the image", async () => {
      const h = cancelledLaunch();
      h.port.onStopProcess = (_child, retain) => {
        retain(h.exited.promise);
        throw new Error("emulator process 4242 did not exit after SIGKILL");
      };
      await expect(h.cancelledRun()).rejects.toThrow("did not exit after SIGKILL");
      expect(h.port.stoppedProcesses).toEqual([h.spawned]);
      // The lifecycle lease is what fences the AVD until the child exits: the pool's
      // own retained-lease hook receives the child's exit, not a wrapper...
      expect(h.leaseSettlements).toHaveLength(1);
      expect(h.leaseSettlements[0]).toBe(h.exited.promise);
      // ...so the #10076 unconfirmed-reservation path is not entered for a relaunch
      // cleanup failure: the image reservation ends with the attempt.
      expect(h.port.finishes).toEqual([
        { retainRecoveryImage: false, lateShutdownSettled: undefined },
      ]);
    });

    test("a child confirmed exited leaves neither the lease nor the image held", async () => {
      const h = cancelledLaunch();
      expect(await h.cancelledRun()).toBe(false);
      expect(h.port.stoppedProcesses).toEqual([h.spawned]);
      expect(h.leaseSettlements).toEqual([]);
      expect(h.port.finishes).toEqual([
        { retainRecoveryImage: false, lateShutdownSettled: undefined },
      ]);
    });
  });
  test.each([1, 3])("cancels at checkpoint %i in handoff order", async (checkpoint) => {
    const { coordinator, port, outcomes, attempts, timer } = setup();
    port.cancelAt = checkpoint;
    expect(await run(coordinator)).toBe(false);
    expect(outcomes).toEqual(["not-attempted"]);
    expect(attempts).toEqual([]);
    expect(timer.getSleepHistory()).toEqual([]);
    expect(port.calls).toEqual([
      "set-image",
      "recovering:emulator-5554",
      "stop",
      "detach",
      "remove:emulator-5554:true:true",
      ...(checkpoint === 3
        ? [
            "recovering:emulator-5556",
            "set-owner",
            "identity",
            "add:emulator-5556",
            "remove:emulator-5556:true:false",
            "stop-process",
            "clear-owner",
          ]
        : []),
      "finish",
    ]);
  });

  test("retains the first cancellation cleanup failure and still clears ownership", async () => {
    const { coordinator, port, outcomes } = setup();
    port.cancelAt = 3;
    const first = new Error("remove failed");
    const originalRemove = port.removeDevice.bind(port);
    port.removeDevice = async (id, ...args) => {
      await originalRemove(id, ...args);
      if (id === ready.deviceId) {
        throw first;
      }
    };
    port.stopEmulatorProcess = async () => {
      port.calls.push("stop-process");
      throw new Error("stop failed");
    };
    await expect(run(coordinator)).rejects.toBe(first);
    expect(port.calls.slice(-3)).toEqual(["stop-process", "clear-owner", "finish"]);
    expect(outcomes).toEqual([]);
  });

  test.each([false, true])(
    "settles an aborted owned boot once (cleanup fails: %j)",
    async (cleanupFails) => {
      const controller = new AbortController();
      const failure = new Error("owned boot cleanup failed");
      const child = {
        kill: () => {
          throw new Error("unexpected direct kill");
        },
      } as ChildProcess;
      const { coordinator, port, outcomes, attempts, timer } = setup(
        async () => child,
        async () => {
          controller.abort(new Error("cancel readiness"));
          throw controller.signal.reason;
        },
      );
      port.stopEmulatorProcess = async () => {
        port.calls.push("stop-process");
        if (cleanupFails) {
          throw failure;
        }
      };
      const result = coordinator.rebootDisconnectedAndroidDeviceCoordinated(
        oldDevice,
        "incident",
        {},
        controller.signal,
        () => {},
      );
      if (cleanupFails) {
        await expect(result).rejects.toBe(failure);
      } else {
        expect(await result).toBe(false);
      }
      expect(port.calls.filter((call) => call === "stop-process")).toHaveLength(1);
      expect(port.calls.at(-1)).toBe("finish");
      expect(outcomes).toEqual(cleanupFails ? [] : ["not-attempted"]);
      expect(attempts).toEqual([]);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    },
  );

  test("cancels a failed bind and removes the registered replacement before stopping it", async () => {
    const { coordinator, port, outcomes, attempts } = setup();
    port.cancelAt = 4;
    port.bindRecoveredAndroidDeviceSession = async () => {
      throw new Error("bind failed");
    };
    expect(await run(coordinator)).toBe(false);
    expect(port.calls.slice(-4)).toEqual([
      "remove:emulator-5556:true:false",
      "stop-process",
      "clear-owner",
      "finish",
    ]);
    expect(outcomes).toEqual(["not-attempted"]);
    expect(attempts).toEqual([]);
  });

  test("records a bind failure and clears ownership before exhausting recovery", async () => {
    const { coordinator, port, outcomes, attempts } = setup();
    port.bindRecoveredAndroidDeviceSession = async () => {
      throw new Error("bind failed");
    };
    expect(await run(coordinator)).toBe(false);
    expect(port.calls.slice(-2)).toEqual(["clear-owner", "finish"]);
    expect(outcomes).toEqual(["exhausted"]);
    expect(attempts).toEqual(["failed"]);
  });
  test("reboots and rebinds in the original incarnation handoff order", async () => {
    const { coordinator, port, outcomes, attempts, recordLedger } = setup();
    const record = recordLedger.startAndroidRecoveryRecord("session", { deviceId: oldDevice.id }, [
      "loss",
    ]);
    expect(await run(coordinator, { preserveSessionId: "session" })).toBe(true);
    expect(record.reservations.has("image")).toBe(true);
    expect(port.calls).toEqual([
      "set-image",
      "recovering:emulator-5554",
      "stop",
      "detach",
      "remove:emulator-5554:true:true",
      "recovering:emulator-5556",
      "set-owner",
      "identity",
      "add:emulator-5556",
      "bind:session",
      "clear-owner",
      "finish",
    ]);
    expect(attempts).toEqual(["succeeded"]);
    expect(outcomes).toEqual(["recovered"]);
  });

  test("records a failed relaunch and exhausts the reboot budget", async () => {
    const { coordinator, port, outcomes, attempts } = setup(async () => {
      throw new Error("launch failed");
    });
    expect(await run(coordinator)).toBe(false);
    expect(attempts).toEqual(["failed"]);
    expect(outcomes).toEqual(["exhausted"]);
    expect(port.calls.at(-1)).toBe("finish");
  });

  test("consumes a cancellation after readiness without binding", async () => {
    const { coordinator, port, outcomes } = setup();
    port.cancelAt = 2;
    expect(await run(coordinator)).toBe(false);
    expect(port.calls).toContain("stop-process");
    expect(port.calls).not.toContain("bind:none");
    expect(outcomes).toEqual(["not-attempted"]);
  });

  test("completes a declined detach without attempting a relaunch", async () => {
    const { coordinator, port, outcomes, attempts } = setup();
    port.detachSessionForAndroidRecovery = () => false;
    expect(await run(coordinator, { preserveSessionId: "session" })).toBe(false);
    expect(outcomes).toEqual(["not-attempted"]);
    expect(attempts).toEqual([]);
    expect(port.calls).toEqual(["set-image", "recovering:emulator-5554", "stop", "finish"]);
  });

  describe("an unconfirmed shutdown", () => {
    const unconfirm = (port: FakePoolPort, lateKill?: Promise<unknown>) => {
      port.onStop = (retainLeaseUntil) => {
        if (lateKill) {
          retainLeaseUntil(lateKill);
        }
        throw new UnconfirmedRecoveryShutdownError("Pixel", new Error("x"));
      };
    };

    test.each([undefined, "session"])(
      "retains the image for the attempt end and hands the late kill to the pool (session %s)",
      async (preserveSessionId) => {
        const { coordinator, port } = setup();
        const lateKill = Promise.withResolvers<void>();
        unconfirm(port, lateKill.promise);
        await expect(run(coordinator, { preserveSessionId })).rejects.toBeInstanceOf(
          UnconfirmedRecoveryShutdownError,
        );
        expect(port.finishes).toHaveLength(1);
        expect(port.finishes[0].retainRecoveryImage).toBe(true);
        let settled = false;
        void port.finishes[0].lateShutdownSettled?.then(() => {
          settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);
        lateKill.resolve();
        await port.finishes[0].lateShutdownSettled;
        expect(settled).toBe(true);
      },
    );

    test("a settled failure is passed on without a late kill promise to wait for", async () => {
      const { coordinator, port } = setup();
      unconfirm(port);
      await expect(run(coordinator)).rejects.toBeInstanceOf(UnconfirmedRecoveryShutdownError);
      expect(await port.finishes[0].lateShutdownSettled).toEqual([]);
    });

    test("an ordinary stop failure does not retain the image", async () => {
      const { coordinator, port, outcomes } = setup();
      port.onStop = () => {
        throw new Error("kill failed");
      };
      expect(await run(coordinator)).toBe(false);
      expect(outcomes).toEqual(["exhausted"]);
      expect(port.finishes).toEqual([
        { retainRecoveryImage: false, lateShutdownSettled: undefined },
      ]);
    });
  });

  test("never accesses assignmentMutex directly through its port", async () => {
    const { coordinator, port } = setup();
    expect(await run(coordinator)).toBe(true);
    expect(port.calls).toContain("bind:none");
    // The guarded port throws on direct mutex access while allowing the pool's self-locking bind.
  });
});

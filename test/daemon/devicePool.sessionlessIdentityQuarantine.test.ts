import { FakeDeviceExecutionBinding } from "../fakes/FakeDeviceExecutionBinding";
import { Daemon } from "../../src/daemon/daemon";
import { FakeDeviceSessionRepository } from "../fakes/FakeDeviceSessionRepository";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeDatabaseInitializer } from "../fakes/FakeDatabaseInitializer";
import { FakeStartupFailureTracker } from "../fakes/FakeStartupFailureTracker";
import { afterEach, describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DaemonState } from "../../src/daemon/daemonState";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { ExecutionTracker, executionTracker } from "../../src/server/executionTracker";
import { DeviceLostError } from "../../src/server/deviceLossOutcome";
import { deviceLossCancellationReason } from "../../src/daemon/emulatorLossIncident";
import {
  runWithToolSelectionContext,
  getToolSelectionContext,
} from "../../src/features/toolSelection/toolSelectionContext";
import { AdbClient } from "../../src/utils/android-cmdline-tools/AdbClient";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { getAbortSignal, runWithAbortSignal } from "../../src/utils/AbortContext";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceSessionExecutionCanceller } from "../fakes/FakeDeviceSessionExecutionCanceller";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { AdmittingAdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";

const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };

async function setup(tracker: ExecutionTracker, options: { drain?: boolean } = {}) {
  const timer = new FakeTimer();
  const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  const manager = new FakeDeviceUtils();
  manager.setBootedDevices("android", [device]);
  const canceller = new FakeDeviceSessionExecutionCanceller({ tracker, ...options });
  const binding = new FakeDeviceExecutionBinding();
  const pool = new DevicePool(
    createDevicePoolDependencies(sessions, "test-daemon", {
      timer,
      deviceManager: manager,
      cancelDeviceSessionExecutions: canceller.cancel,
      ambientExecutionIdReader: binding,
    }),
  );
  await pool.initializeWithDevices([device]);
  DaemonState.getInstance().initialize(sessions, pool);
  const quarantine = (excludeExecutionId?: string) =>
    pool.reconcileDiscoveryObservation([{ ...device, name: "Replacement" }], "test", {
      excludeExecutionId,
    });
  return { pool, canceller, quarantine, binding };
}

afterEach(() => DaemonState.getInstance().reset());

describe("sessionless identity quarantine", () => {
  test.each([false, true])(
    "ambient quarantine excludes its caller from both cancellation and drain (explicit=%s)",
    async (explicit) => {
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const tracker = new ExecutionTracker(
        timer,
        new FakeIdGenerator(["ambient", "explicit", "other", "session-only"]),
      );
      const h = await setup(tracker, { drain: true });
      await h.pool.bindOrReuseDeviceSession("owner", device.deviceId, "android");
      const ambient = tracker.startExecution("setActiveDevice", undefined, "owner");
      const chosen = tracker.startExecution("killDevice", undefined, "owner");
      const other = tracker.startExecution("takeScreenshot");
      const sessionOnly = tracker.startExecution("takeScreenshot", undefined, "owner");
      for (const work of [ambient, chosen, other]) {
        tracker.bindDeviceExecution(work.id, device.deviceId);
      }
      for (const work of [ambient, chosen, other, sessionOnly]) {
        work.abortController.signal.addEventListener("abort", () => tracker.endExecution(work.id), {
          once: true,
        });
      }
      h.binding.executionId = ambient.id;
      const excluded = explicit ? chosen : ambient;
      try {
        await h.quarantine(explicit ? chosen.id : undefined);
        expect(excluded.abortController.signal.aborted).toBe(false);
        expect((explicit ? ambient : chosen).abortController.signal.aborted).toBe(true);
        expect(other.abortController.signal.aborted).toBe(true);
        expect(sessionOnly.abortController.signal.aborted).toBe(true);
        expect(h.canceller.devices).toEqual([device.deviceId]);
        expect(h.canceller.sessions).toEqual(["owner"]);
        expect(h.canceller.drains).toEqual([true, true]);
        expect(timer.now()).toBe(0);
      } finally {
        for (const work of [ambient, chosen, other, sessionOnly]) {
          tracker.endExecution(work.id);
        }
      }
    },
  );

  test("factory admission binds sessionless work; quarantine preserves discovery and other devices", async () => {
    const tracker = new ExecutionTracker(
      new FakeTimer(),
      new FakeIdGenerator(["work", "discover", "other"]),
    );
    const h = await setup(tracker);
    const work = tracker.startExecution("takeScreenshot");
    const discover = tracker.startExecution("killDevice");
    const other = tracker.startExecution("takeScreenshot");
    const factory = new AdmittingAdbClientFactory(new FakeAdbClientFactory());
    for (const [execution, target] of [
      [work, device],
      [discover, device],
      [other, { ...device, deviceId: "emulator-5556" }],
    ] as const) {
      await runWithToolSelectionContext(
        {
          execution: {
            executionId: execution.id,
            startTime: execution.startTime,
            deviceBinding: {
              bindDeviceExecution: (deviceId) =>
                tracker.bindDeviceExecution(execution.id, deviceId),
            },
          },
        },
        async () => {
          factory.create(target);
          factory.create(target);
        },
      );
    }
    await h.quarantine(discover.id);
    expect(h.canceller.devices).toEqual([device.deviceId]);
    expect(h.canceller.sessions).toEqual([]);
    expect(work.abortController.signal.aborted).toBe(true);
    expect(work.cancelReason).toBeInstanceOf(DeviceLostError);
    expect(work.cancelReason?.message).toBe(deviceLossCancellationReason(device.deviceId));
    expect(discover.abortController.signal.aborted).toBe(false);
    expect(other.abortController.signal.aborted).toBe(false);
    tracker.endExecution(work.id);
    expect(
      tracker.hasActiveDeviceExecutions(device.deviceId, { excludeExecutionId: discover.id }),
    ).toBe(false);
  });

  test("a retained AdbClient cannot pull or clean up after sessionless quarantine", async () => {
    const timer = new FakeTimer();
    const tracker = new ExecutionTracker(timer, new FakeIdGenerator(["screenshot"]));
    const h = await setup(tracker);
    const work = tracker.startExecution("takeScreenshot");
    const commands: string[] = [];
    const client = new AdbClient(
      device,
      async (command) => {
        commands.push(command);
        return {
          stdout: "",
          stderr: "",
          toString: () => "",
          trim: () => "",
          includes: () => false,
        };
      },
      null,
      new DefaultRetryExecutor(timer),
      timer,
    );
    const factory = new AdmittingAdbClientFactory({ create: () => client });
    await runWithToolSelectionContext(
      {
        execution: {
          executionId: work.id,
          startTime: work.startTime,
          deviceBinding: {
            bindDeviceExecution: (deviceId) => tracker.bindDeviceExecution(work.id, deviceId),
          },
        },
      },
      () =>
        runWithAbortSignal(work.abortController.signal, async () => {
          const retained = factory.create(device);
          await retained.execute(["shell", "screencap", "/sdcard/screen.png"], { noRetry: true });
          await h.quarantine();
          await expect(
            retained.execute(["pull", "/sdcard/screen.png"], { noRetry: true }),
          ).rejects.toBeInstanceOf(DeviceLostError);
          await expect(
            retained.execute(["shell", "rm", "/sdcard/screen.png"], { noRetry: true }),
          ).rejects.toBeInstanceOf(DeviceLostError);
        }),
    );
    expect(commands).toHaveLength(1);
    tracker.endExecution(work.id);
  });

  test("quarantine also cancels work indexed only under the bound session", async () => {
    const tracker = new ExecutionTracker(new FakeTimer(), new FakeIdGenerator(["session-work"]));
    const h = await setup(tracker);
    await h.pool.bindOrReuseDeviceSession("owner", device.deviceId, "android");
    const work = tracker.startExecution("takeScreenshot", undefined, "owner");
    await h.quarantine();
    expect(h.canceller.devices).toEqual([device.deviceId]);
    expect(h.canceller.sessions).toEqual(["owner"]);
    expect(work.abortController.signal.aborted).toBe(true);
  });

  test("production daemon wiring cancels and drains sessionless work without starting a daemon", async () => {
    const daemon = new Daemon(
      {},
      new FakeInstalledAppsRepository(),
      new FakeTimer(),
      new FakeDeviceSessionRepository(),
      new FakeIdGenerator(),
      new FakeDatabaseInitializer(),
      new FakeStartupFailureTracker(),
    );
    const work = executionTracker.startExecution("takeScreenshot");
    try {
      const pool = daemon.getDevicePool();
      await pool.initializeWithDevices([device]);
      executionTracker.bindDeviceExecution(work.id, device.deviceId);
      work.abortController.signal.addEventListener(
        "abort",
        () => executionTracker.endExecution(work.id),
        { once: true },
      );
      await pool.reconcileDiscoveryObservation([{ ...device, name: "Replacement" }], "test");
      expect(work.abortController.signal.aborted).toBe(true);
      expect(work.cancelReason).toBeInstanceOf(DeviceLostError);
      expect(executionTracker.hasActiveDeviceExecutions(device.deviceId)).toBe(false);
    } finally {
      executionTracker.endExecution(work.id);
      daemon.getSessionManager().stopCleanupTimer();
    }
  });

  test("production identity quarantine preserves the ambient sessionless caller and drains other work", async () => {
    const daemon = new Daemon(
      {},
      new FakeInstalledAppsRepository(),
      new FakeTimer(),
      new FakeDeviceSessionRepository(),
      new FakeIdGenerator(),
      new FakeDatabaseInitializer(),
      new FakeStartupFailureTracker(),
    );
    const caller = executionTracker.startExecution("setActiveDevice");
    const other = executionTracker.startExecution("takeScreenshot");
    try {
      const pool = daemon.getDevicePool();
      await pool.initializeWithDevices([device]);
      for (const work of [caller, other]) {
        executionTracker.bindDeviceExecution(work.id, device.deviceId);
        work.abortController.signal.addEventListener(
          "abort",
          () => executionTracker.endExecution(work.id),
          { once: true },
        );
      }
      await runWithToolSelectionContext(
        { execution: { executionId: caller.id, startTime: caller.startTime } },
        () =>
          pool.reconcileDiscoveryObservation(
            [{ ...device, name: "Replacement" }],
            "setActiveDevice:resumeCtrlProxy",
          ),
      );
      expect(caller.abortController.signal.aborted).toBe(false);
      expect(other.abortController.signal.aborted).toBe(true);
      expect(
        executionTracker.hasActiveDeviceExecutions(device.deviceId, {
          excludeExecutionId: caller.id,
        }),
      ).toBe(false);
    } finally {
      executionTracker.endExecution(caller.id);
      executionTracker.endExecution(other.id);
      daemon.getSessionManager().stopCleanupTimer();
    }
  });

  describe("input resolved for a session that has since left the device (#9958)", () => {
    const newServer = () =>
      new UnixSocketServer(
        "scratch/never-listened.sock",
        "http://localhost:0/mcp",
        DaemonState.getInstance(),
        new FakeTimer(),
      );

    test("is refused instead of running as an unowned call", async () => {
      const h = await setup(new ExecutionTracker(new FakeTimer(), new FakeIdGenerator()));
      await h.pool.bindOrReuseDeviceSession("owner", device.deviceId, "android");
      const server = newServer();
      server["captureInputTargetOwner"](device);

      const sessions = DaemonState.getInstance().getSessionManager();
      await sessions.rebindSession("owner", "emulator-5556", "android");
      expect(sessions.getSessionForDevice(device.deviceId)).toBe(null);

      let ran = false;
      await expect(
        server["runTrackedDeviceInput"]("input/tap", device, async () => {
          ran = true;
        }),
      ).rejects.toThrow(/Session owner no longer owns device 'emulator-5554'/);
      expect(ran).toBe(false);
      expect(executionTracker.hasActiveDeviceExecutions(device.deviceId)).toBe(false);
    });

    test("still runs while the resolving session owns the device", async () => {
      const h = await setup(new ExecutionTracker(new FakeTimer(), new FakeIdGenerator()));
      await h.pool.bindOrReuseDeviceSession("owner", device.deviceId, "android");
      const server = newServer();
      server["captureInputTargetOwner"](device);

      let ran = false;
      await server["runTrackedDeviceInput"]("input/tap", device, async () => {
        ran = true;
      });
      expect(ran).toBe(true);
    });

    test("an input resolved on an unowned device still runs sessionless", async () => {
      await setup(new ExecutionTracker(new FakeTimer(), new FakeIdGenerator()));
      const server = newServer();
      server["captureInputTargetOwner"](device);

      let ran = false;
      await server["runTrackedDeviceInput"]("input/tap", device, async () => {
        ran = true;
      });
      expect(ran).toBe(true);
    });
  });

  test("daemon sessionless input carries execution context, binding, and ambient abort", async () => {
    const h = await setup(executionTracker);
    const server = new UnixSocketServer(
      "scratch/never-listened.sock",
      "http://localhost:0/mcp",
      DaemonState.getInstance(),
      new FakeTimer(),
    );
    let executionId: string | undefined;
    await server["runTrackedDeviceInput"]("input/tap", device, async (signal) => {
      executionId = getToolSelectionContext()?.execution?.executionId;
      expect(executionId).toBeDefined();
      expect(getToolSelectionContext()?.execution?.deviceBinding).toBeDefined();
      expect(getAbortSignal()).toBe(signal);
      expect(signal?.aborted).toBe(false);
      expect(executionTracker.hasActiveDeviceExecutions(device.deviceId)).toBe(true);
      await h.quarantine();
      expect(signal?.aborted).toBe(true);
    });
    expect(executionTracker.hasActiveDeviceExecutions(device.deviceId)).toBe(false);
    expect(executionId).toBeDefined();
  });
});

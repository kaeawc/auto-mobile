import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  openSqliteBindingRegistry,
  type SqliteBindingRegistry,
} from "../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import {
  computeBindingScopeKey,
  type BindingProcessIdentity,
} from "../../../src/daemon/sessionBroker/registry/bindingRegistry";
import { SessionBroker } from "../../../src/daemon/sessionBroker/broker";
import {
  parseSessionBrokerHostConfig,
  SESSION_BROKER_SCOPE,
} from "../../../src/daemon/sessionBroker/hostConfig";
import {
  openSessionBrokerService,
  createAndroidResetStrategy,
  SessionBrokerService,
  type OpenSessionBrokerServiceOptions,
  type SessionBrokerHostLock,
} from "../../../src/daemon/sessionBroker/service";
import type { SqliteSessionBrokerStore } from "../../../src/daemon/sessionBroker/sqliteStore";
import { FakeTimer } from "../../fakes/FakeTimer";
import { SESSION_BROKER_RETRY_AFTER_MS } from "../../../src/daemon/sessionBroker/SessionRequestOwnerMismatchError";
import { SESSION_BROKER_RECOVERY_INTERVAL_MS } from "../../../src/daemon/sessionBroker/timing";
import {
  androidDefaults,
  iosCatalog,
  iosDefaults,
} from "../../devices/sessionRequirements/fixtures";
import { drainUntil } from "../../helpers/fakeTimerStepping";
import { boundAndroidResetInventory } from "../../../src/daemon/sessionBroker/service";
import type { BootedDevice } from "../../../src/models/DeviceInfo";
import { FakeNativePort } from "../../helpers/fakeSessionBrokerDevicePort";
import type { Session } from "../../../src/daemon/sessionManager/sessionTypes";
import { iosMutationIncarnation } from "../../../src/daemon/sessionBroker/mutations/recorder";
import { logger } from "../../../src/utils/logger";
import { DEFAULT_ANDROID_RESET_TIMEOUT_MS } from "../../../src/daemon/sessionBroker/androidBaselineReset";
import { FakeAndroidKeepBootedResetPort } from "../../fakes/FakeAndroidKeepBootedResetPort";
import { FakeDeviceMutationJournal } from "../../fakes/FakeDeviceMutationJournal";
import { ANDROID_RESET_DEVICE } from "./fixtures/androidReset";

const OWNER: BindingProcessIdentity = {
  daemonId: "broker-daemon",
  pid: 101,
  processGenerationToken: "process-a",
};
const BROKER_SCOPE_KEY = computeBindingScopeKey(SESSION_BROKER_SCOPE);

describe("service Android reset strategy construction", () => {
  test.each([undefined, 90_000])(
    "snapshot fallback honors configured overall budget %s beyond 30 seconds",
    async (configuredTimeout) => {
      const timer = new FakeTimer();
      const port = new FakeAndroidKeepBootedResetPort({
        completeKinds: [],
        // An empty capture is never persisted as a baseline, so keep one observation.
        observations: [
          {
            kind: "installed-app",
            key: "user:0:com.example.baseline",
            value: { state: "present", value: true },
          },
        ],
        unobservable: [],
      });
      const budget = configuredTimeout ?? DEFAULT_ANDROID_RESET_TIMEOUT_MS;
      let receivedBudget: number | undefined;
      let fallbackSignal: AbortSignal | undefined;
      const strategy = createAndroidResetStrategy(
        parseSessionBrokerHostConfig({
          contractVersion: 1,
          limits: { totalDeviceCap: 1, sessionCap: 1, idlePoolCap: 0 },
          defaults: { android: androidDefaults() },
          reuseAndroidCleanDevices: true,
          androidResetMode: "keep-booted",
          androidKeepBootedFallback: "snapshot",
          ...(configuredTimeout === undefined ? {} : { androidResetTimeoutMs: configuredTimeout }),
        }),
        {
          timer,
          journal: new FakeDeviceMutationJournal(timer),
          port: () => port,
          snapshot: {
            reset: async (_device, _packages, fence, context) => {
              receivedBudget = context.timeoutMs;
              fallbackSignal = context.signal;
              await timer.sleep(31_000);
              context.signal?.throwIfAborted();
              await fence();
              return {
                outcome: "fallback:wipe-data",
                mode: "wipe-data",
                phases: {},
                fallbackReason: "load failed",
              };
            },
          },
        },
      )!;
      const session = { resourceId: "resource-a", sessionId: "session-a", incarnation: "boot-a" };
      await strategy.capture!(ANDROID_RESET_DEVICE, {
        ...session,
        signal: new AbortController().signal,
        timeoutMs: 5000,
        assertOwned: async () => {},
      });
      port.beforeClean = async () => {
        timer.advanceTime(12_000);
        throw new Error("clean failed");
      };
      const result = strategy.reset(ANDROID_RESET_DEVICE, new Set(), async () => {}, {
        ...session,
        timeoutMs: budget,
        deadlineMs: timer.now() + budget,
      });
      await drainUntil(() => receivedBudget !== undefined, {
        description: "snapshot fallback started",
      });
      expect(receivedBudget).toBe(budget - 12_000 - 2001);
      timer.advanceTime(31_000);
      await expect(result).resolves.toMatchObject({
        outcome: "fallback:wipe-data",
        mode: "wipe-data",
        fallbackReason: "clean failed; load failed",
      });
      expect(fallbackSignal?.aborted).toBe(false);
    },
  );
});

const unusedNativeCall = async (): Promise<never> => {
  throw new Error("native work must not run in this test");
};

function hostConfig() {
  return parseSessionBrokerHostConfig({
    contractVersion: 1,
    limits: { totalDeviceCap: 1, sessionCap: 1, idlePoolCap: 0 },
    defaults: { ios: iosDefaults() },
  });
}

class RecordingLock implements SessionBrokerHostLock {
  readonly events: string[] = [];

  acquire(): void {
    this.events.push("lock:acquire");
  }

  release(): void {
    this.events.push("lock:release");
  }
}

class ControlledBroker extends SessionBroker {
  readonly recoveryStarted = Promise.withResolvers<void>();
  readonly finishRecovery = Promise.withResolvers<void>();
  readonly events: string[] = [];
  blockRecovery = false;

  constructor(store: SqliteSessionBrokerStore) {
    super({
      store,
      devices: {
        prepare: unusedNativeCall,
        release: unusedNativeCall,
        destroy: unusedNativeCall,
      },
      owner: OWNER,
      limits: {},
      catalog: async () => iosCatalog(),
      defaults: () => iosDefaults(),
    });
  }

  override async recoverCleanup(): Promise<void> {
    this.events.push("recover:start");
    this.recoveryStarted.resolve();
    if (this.blockRecovery) {
      await this.finishRecovery.promise;
    }
    this.events.push("recover:end");
  }

  override async close(): Promise<void> {
    this.events.push("broker:close");
  }

  override async markRestartHandoff(): Promise<void> {
    this.events.push("broker:handoff");
    await super.markRestartHandoff();
  }
}

describe("session broker service lifecycle", () => {
  let registry: SqliteBindingRegistry;

  beforeEach(async () => {
    registry = await openSqliteBindingRegistry({
      dbPath: ":memory:",
      isExecOwnerLive: () => true,
    });
  });

  afterEach(async () => {
    await registry.close();
  });

  function openOptions(
    timer: FakeTimer,
    lock: SessionBrokerHostLock,
  ): OpenSessionBrokerServiceOptions {
    return {
      config: hostConfig(),
      registry,
      acquisition: { acquire: unusedNativeCall },
      release: { releaseExecution: unusedNativeCall },
      journal: { owner: OWNER, redriveBinding: unusedNativeCall },
      owner: OWNER,
      timer,
      sessionDisposition: () => "live",
      hostLock: lock,
      catalog: async () => iosCatalog(),
    };
  }

  test("startup passes the service timer to broker release replies", async () => {
    const timer = new FakeTimer();
    const service = await openSessionBrokerService(openOptions(timer, new RecordingLock()));
    const timeout = spyOn(timer, "setTimeout");
    try {
      expect(await service.broker.release("missing-session")).toEqual({
        sessionUuid: "missing-session",
        outcome: "unknown_session",
      });
      expect(timeout).toHaveBeenCalledWith(expect.any(Function), 30_000);
      // Startup recovers receipts only; the daemon starts the cleanup loop after socket bind.
      expect(timer.getPendingTimeouts()).toEqual([]);
    } finally {
      timeout.mockRestore();
      await service.close();
    }
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("startup continues when mutation recorder recovery cannot list requests", async () => {
    const timer = new FakeTimer();
    const lock = new RecordingLock();
    const store = registry.sessionBrokerStore(BROKER_SCOPE_KEY);
    const originalList = store.listRecoverableRequests.bind(store);
    const failure = new Error("recoverable requests unavailable");
    let listCalls = 0;
    const list = spyOn(store, "listRecoverableRequests").mockImplementation(async () => {
      listCalls += 1;
      if (listCalls === 2) {
        throw failure;
      }
      return originalList();
    });
    const storeFactory = spyOn(registry, "sessionBrokerStore").mockReturnValue(store);
    const warning = spyOn(logger, "warn").mockImplementation(() => {});

    try {
      const service = await openSessionBrokerService(openOptions(timer, lock));
      expect(service).toBeInstanceOf(SessionBrokerService);
      expect(list).toHaveBeenCalledTimes(3);
      expect(warning).toHaveBeenCalledWith(
        "Cannot list recoverable session requests for mutation recorder recovery",
        failure,
      );
      await service.close();
    } finally {
      warning.mockRestore();
      storeFactory.mockRestore();
      list.mockRestore();
    }
    expect(lock.events).toEqual(["lock:acquire", "lock:release"]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("Android reset requires readiness ports and releases the lock on rejection", async () => {
    const timer = new FakeTimer();
    const lock = new RecordingLock();
    const options = openOptions(timer, lock);
    options.config = parseSessionBrokerHostConfig({
      contractVersion: 1,
      limits: { totalDeviceCap: 1, sessionCap: 1, idlePoolCap: 0 },
      defaults: { android: androidDefaults() },
      reuseAndroidCleanDevices: true,
    });

    await expect(openSessionBrokerService(options)).rejects.toThrow(
      "Android baseline reset requires the daemon readiness ports",
    );

    expect(lock.events).toEqual(["lock:acquire", "lock:release"]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test.each(["snapshot", "keep-booted"])(
    "%s snapshot wiring refuses unavailable snapshot ports",
    async (mode) => {
      const timer = new FakeTimer();
      const lock = new RecordingLock();
      const options = openOptions(timer, lock);
      options.config = parseSessionBrokerHostConfig({
        contractVersion: 1,
        limits: {},
        defaults: { android: androidDefaults() },
        reuseAndroidCleanDevices: true,
        androidResetMode: mode,
        ...(mode === "keep-booted" ? { androidKeepBootedFallback: "snapshot" } : {}),
      });
      options.androidReset = { inventory: async () => [], ctrlProxyReady: async () => true };
      await expect(openSessionBrokerService(options)).rejects.toThrow(
        "snapshot reset requires daemon readiness and identity ports",
      );
      expect(lock.events).toEqual(["lock:acquire", "lock:release"]);
    },
  );

  test.each([undefined, "destroy"])(
    "keep-booted fallback %s does not require snapshot ports",
    async (fallback) => {
      const timer = new FakeTimer();
      const lock = new RecordingLock();
      const options = openOptions(timer, lock);
      options.config = parseSessionBrokerHostConfig({
        contractVersion: 1,
        limits: {},
        defaults: { android: androidDefaults() },
        reuseAndroidCleanDevices: true,
        androidResetMode: "keep-booted",
        androidKeepBootedFallback: fallback,
      });
      options.androidReset = { inventory: async () => [], ctrlProxyReady: async () => true };
      const service = await openSessionBrokerService(options);
      await service.close();
      expect(lock.events).toEqual(["lock:acquire", "lock:release"]);
    },
  );

  test("Android reset inventory honors its timeout and abort signal", async () => {
    const timer = new FakeTimer();
    const inventoryOptions: Array<{ signal?: AbortSignal; timeoutMs?: number }> = [];
    const inventory = boundAndroidResetInventory((inventoryOption) => {
      inventoryOptions.push(inventoryOption ?? {});
      return new Promise<BootedDevice[]>(() => {});
    }, timer);
    const controller = new AbortController();
    const pending = inventory({ signal: controller.signal, timeoutMs: 317 });

    expect(inventoryOptions).toEqual([{ signal: expect.any(AbortSignal), timeoutMs: 317 }]);
    expect(inventoryOptions[0]!.signal).not.toBe(controller.signal);
    expect(timer.getPendingTimeouts()).toEqual([317]);
    timer.advanceTime(316);
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
    expect(inventoryOptions[0]!.signal?.aborted).toBe(true);
    expect(timer.getPendingTimeoutCount()).toBe(0);

    const timeoutPending = inventory({ timeoutMs: 91 });
    expect(timer.getPendingTimeouts()).toEqual([91]);
    timer.advanceTime(91);
    await expect(timeoutPending).rejects.toThrow("timed out after 91ms");
    expect(inventoryOptions[1]!.signal?.aborted).toBe(true);
    expect(timer.getPendingTimeoutCount()).toBe(0);

    const defaultTimeoutPending = inventory();
    expect(timer.getPendingTimeouts()).toEqual([2000]);
    timer.advanceTime(2000);
    await expect(defaultTimeoutPending).rejects.toThrow("timed out after 2000ms");
    expect(inventoryOptions[2]!.signal?.aborted).toBe(true);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("Android inventory timeout aborts the inner call without aborting its caller", async () => {
    const timer = new FakeTimer();
    const controller = new AbortController();
    let innerAborted = false;
    const inventory = boundAndroidResetInventory(
      (options) =>
        new Promise<BootedDevice[]>((_resolve, reject) => {
          const signal = options?.signal;
          if (!signal) {
            throw new Error("Missing inventory abort signal");
          }
          signal.addEventListener(
            "abort",
            () => {
              innerAborted = true;
              reject(signal.reason);
            },
            { once: true },
          );
        }),
      timer,
    );
    const pending = inventory({ signal: controller.signal, timeoutMs: 91 });

    expect(innerAborted).toBe(false);
    timer.advanceTime(91);
    await expect(pending).rejects.toThrow("timed out after 91ms");
    expect(innerAborted).toBe(true);
    expect(controller.signal.aborted).toBe(false);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });
  test.each(["startup", "late recovery", "startup stale assignment", "startup registry error"])(
    "%s reattaches the durable mutation recorder to a recovered live broker session",
    async (recovery) => {
      const timer = new FakeTimer();
      await registry.ensureScope(SESSION_BROKER_SCOPE);
      const store = registry.sessionBrokerStore(BROKER_SCOPE_KEY);
      const devices = new FakeNativePort(registry, undefined, OWNER);
      const bootstrap = new SessionBroker({
        store,
        devices,
        owner: OWNER,
        timer,
        limits: {},
        catalog: async () => iosCatalog(),
        defaults: () => iosDefaults(),
      });
      const result = await bootstrap.prepare(
        {
          contractVersion: 1,
          requestId: "restore-recorder",
          device: {
            schemaVersion: 1,
            platform: "ios",
            hardware: { kind: "omitted" },
            os: { kind: "omitted" },
          },
        },
        "consumer-token",
      );
      expect(result.outcome).toBe("ready");
      if (!result.sessionUuid) {
        throw new Error("Missing prepared session");
      }
      const resource = devices.sessions.get(result.sessionUuid)!;
      const assignment = (await registry.getAssignment({
        scopeKey: BROKER_SCOPE_KEY,
        bindingIndex: resource.allocationIndex,
      }))!;
      const session: Pick<Session, "sessionId" | "assignedDevice" | "mutationRecorder"> = {
        sessionId: result.sessionUuid,
        assignedDevice: assignment.stableDeviceId!,
      };
      const scope = {
        sessionUuid: session.sessionId,
        deviceId: session.assignedDevice,
        incarnation: iosMutationIncarnation(
          resource.scopeKey,
          resource.allocationIndex,
          assignment.stableDeviceId!,
        ),
      };
      await registry.deviceMutationJournal().record(scope, {
        kind: "clipboard",
        key: "device",
        priorValue: { state: "present", value: "original" },
        toolName: "clipboard",
      });
      let visible = recovery !== "late recovery";
      const startupAssignmentRead =
        recovery === "startup stale assignment"
          ? spyOn(registry, "getAssignment").mockResolvedValue({ ...assignment, state: "settling" })
          : recovery === "startup registry error"
            ? spyOn(registry, "getAssignment").mockRejectedValue(new Error("registry unavailable"))
            : undefined;
      const service = await openSessionBrokerService({
        ...openOptions(timer, new RecordingLock()),
        deferStart: true,
        mutationSessions: {
          peekSession: (uuid) => (visible && uuid === session.sessionId ? session : null),
        },
        liveSessionIds: () => (visible ? [session.sessionId] : []),
      });
      try {
        if (startupAssignmentRead) {
          expect(session.mutationRecorder).toBeUndefined();
          startupAssignmentRead.mockRestore();
          await service.recoverMutationRecorder(session.sessionId);
        }
        if (!visible) {
          expect(session.mutationRecorder).toBeUndefined();
          visible = true;
          for (const invalidAssignment of [
            { ...assignment, execOwner: { ...OWNER, sessionUuid: "foreign-session" } },
            { ...assignment, state: "settling" as const },
            { ...assignment, stableDeviceId: "foreign-device" },
          ]) {
            const assignmentRead = spyOn(registry, "getAssignment").mockResolvedValue(
              invalidAssignment,
            );
            const warn = spyOn(logger, "warn").mockImplementation(() => {});
            try {
              expect(await service.recoverMutationRecorder(session.sessionId)).toBeUndefined();
              expect(warn).toHaveBeenCalledWith(
                `Cannot recover mutation recorder for session ${session.sessionId}; proceeding without recording`,
                expect.objectContaining({
                  message:
                    "Cannot recover broker mutation recording without the exact native assignment",
                }),
              );
              expect(session.mutationRecorder).toBeUndefined();
            } finally {
              assignmentRead.mockRestore();
              warn.mockRestore();
            }
          }
          expect(await service.recoverMutationRecorder(session.sessionId)).toBe(
            session.mutationRecorder,
          );
        }
        expect(session.mutationRecorder?.scope).toEqual(scope);
        const requestsRead = spyOn(store, "listRequests").mockRejectedValue(
          new Error("hot path must not scan receipts"),
        );
        try {
          session.mutationRecorder = undefined;
          const recovered = await service.recoverMutationRecorder(session.sessionId);
          expect(recovered).toBe(session.mutationRecorder);
          expect(recovered?.scope).toEqual(scope);
          expect(requestsRead).not.toHaveBeenCalled();
        } finally {
          requestsRead.mockRestore();
        }
        await session.mutationRecorder!.record({
          kind: "clipboard",
          key: "device",
          priorValue: { state: "present", value: "changed" },
          toolName: "clipboard",
        });
        expect(await registry.deviceMutationJournal().list(scope)).toMatchObject([
          { priorValue: { state: "present", value: "original" } },
        ]);
      } finally {
        startupAssignmentRead?.mockRestore();
        await service.close();
        await bootstrap.close();
      }
    },
  );

  test("fatal startup failure closes the built broker before releasing its lock", async () => {
    const timer = new FakeTimer();
    const lock = new RecordingLock();
    const recovery = spyOn(SessionBroker.prototype, "recoverReceipts").mockRejectedValue(
      new Error("receipt recovery unavailable"),
    );
    const close = spyOn(SessionBroker.prototype, "close").mockImplementation(async () => {
      lock.events.push("broker:close");
    });
    try {
      await expect(openSessionBrokerService(openOptions(timer, lock))).rejects.toThrow(
        "Session broker startup failed",
      );
      expect(lock.events).toEqual(["lock:acquire", "broker:close", "lock:release"]);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      recovery.mockRestore();
      close.mockRestore();
    }
  });

  test("close wakes an idle loop, closes the broker, and releases the lock once", async () => {
    const timer = new FakeTimer();
    const lock = new RecordingLock();
    const broker = new ControlledBroker(registry.sessionBrokerStore(BROKER_SCOPE_KEY));
    const service = new SessionBrokerService(broker, BROKER_SCOPE_KEY, lock, timer);
    service.start();
    await drainUntil(() => timer.getPendingTimeoutCount() === 1, {
      description: "idle recovery loop",
    });
    expect(SESSION_BROKER_RETRY_AFTER_MS).toBe(5_000);
    expect(SESSION_BROKER_RETRY_AFTER_MS).toBe(SESSION_BROKER_RECOVERY_INTERVAL_MS);
    expect(timer.getPendingTimeouts()).toEqual([SESSION_BROKER_RETRY_AFTER_MS]);

    const first = service.close();
    const second = service.close();

    expect(second).toBe(first);
    await first;
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(broker.events).toEqual([
      "recover:start",
      "recover:end",
      "broker:handoff",
      "broker:close",
    ]);
    expect(lock.events).toEqual(["lock:release"]);
  });

  test("close joins an in-flight recovery pass before broker close and lock release", async () => {
    const timer = new FakeTimer();
    const lock = new RecordingLock();
    const broker = new ControlledBroker(registry.sessionBrokerStore(BROKER_SCOPE_KEY));
    broker.blockRecovery = true;
    const service = new SessionBrokerService(broker, BROKER_SCOPE_KEY, lock, timer);
    service.start();
    await broker.recoveryStarted.promise;

    let closed = false;
    const closing = service.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(lock.events).toEqual([]);
    expect(broker.events).toEqual(["recover:start", "broker:handoff"]);

    broker.finishRecovery.resolve();
    await closing;
    expect(broker.events).toEqual([
      "recover:start",
      "broker:handoff",
      "recover:end",
      "broker:close",
    ]);
    expect(lock.events).toEqual(["lock:release"]);
  });

  test("start recovers immediately and waits five seconds before the second pass", async () => {
    const timer = new FakeTimer();
    const lock = new RecordingLock();
    const broker = new ControlledBroker(registry.sessionBrokerStore(BROKER_SCOPE_KEY));
    const service = new SessionBrokerService(broker, BROKER_SCOPE_KEY, lock, timer);
    try {
      service.start();
      service.start();
      await drainUntil(() => broker.events.includes("recover:end"), {
        description: "immediate first recovery pass",
      });
      expect(timer.now()).toBe(0);
      expect(broker.events).toEqual(["recover:start", "recover:end"]);
      await drainUntil(() => timer.getPendingTimeoutCount() === 1, {
        description: "recovery cadence wait",
      });
      timer.advanceTime(4_999);
      expect(broker.events).toEqual(["recover:start", "recover:end"]);
      timer.advanceTime(1);
      await drainUntil(
        () => broker.events.filter((event) => event === "recover:end").length === 2,
        {
          description: "second recovery pass at five seconds",
        },
      );
      expect(timer.now()).toBe(5_000);
      expect(broker.events).toEqual([
        "recover:start",
        "recover:end",
        "recover:start",
        "recover:end",
      ]);
    } finally {
      await service.close();
    }
  });

  test("startup leaves foreign managed inventory untouched and never starts its loop", async () => {
    const timer = new FakeTimer();
    const lock = new RecordingLock();
    const scope = await registry.ensureScope({
      managedHostScope: "legacy-host",
      runnerNamespace: "legacy-runner",
      runnerIncarnation: "legacy-process",
    });
    if (scope.kind !== "ready") {
      throw new Error(`foreign scope unavailable: ${scope.kind}`);
    }
    const key = { scopeKey: scope.scope.scopeKey, bindingIndex: 0 };
    await registry.initBinding(key, {
      role: "primary",
      platform: "ios",
      requestedSpec: {},
    });
    const committed = await registry.commitBinding(
      key,
      { generation: 0, stableDeviceId: null },
      {
        stableDeviceId: "foreign-device",
        deviceName: "foreign-device",
        resolvedSpec: {},
        specFingerprint: "foreign",
        state: "ready",
      },
    );
    expect(committed.kind).toBe("committed");

    await expect(openSessionBrokerService(openOptions(timer, lock))).rejects.toThrow(
      "existing inventory remains untouched",
    );

    expect(await registry.getAssignment(key)).toMatchObject({
      stableDeviceId: "foreign-device",
    });
    expect(lock.events).toEqual(["lock:acquire", "lock:release"]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("startup rejects a live generic session before starting recovery", async () => {
    const timer = new FakeTimer();
    const lock = new RecordingLock();
    const events: string[] = [];
    const options = openOptions(timer, {
      acquire: () => {
        events.push("lock:acquire");
        lock.acquire();
      },
      release: () => {
        events.push("lock:release");
        lock.release();
      },
    });
    options.liveSessionIds = () => {
      events.push("sessions:read");
      return ["00000000-0000-4000-8000-000000000099"];
    };

    await expect(openSessionBrokerService(options)).rejects.toThrow("prior generic sessions");

    expect(events).toEqual(["lock:acquire", "sessions:read", "lock:release"]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });
});

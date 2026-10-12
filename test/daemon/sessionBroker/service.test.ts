import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  openSqliteSlotRegistry,
  type SqliteSlotRegistry,
} from "../../../src/daemon/managedSlots/sqliteSlotRegistry";
import {
  computeSlotScopeKey,
  type SlotProcessIdentity,
} from "../../../src/daemon/managedSlots/slotRegistry";
import { SessionBroker } from "../../../src/daemon/sessionBroker/broker";
import {
  parseSessionBrokerHostConfig,
  SESSION_BROKER_SCOPE,
} from "../../../src/daemon/sessionBroker/hostConfig";
import {
  openSessionBrokerService,
  SessionBrokerService,
  type OpenSessionBrokerServiceOptions,
  type SessionBrokerHostLock,
} from "../../../src/daemon/sessionBroker/service";
import type { SqliteSessionBrokerStore } from "../../../src/daemon/sessionBroker/sqliteStore";
import { FakeTimer } from "../../fakes/FakeTimer";
import { iosCatalog, iosDefaults } from "../../devices/sessionRequirements/fixtures";

const OWNER: SlotProcessIdentity = {
  daemonId: "broker-daemon",
  pid: 101,
  processGenerationToken: "process-a",
};
const BROKER_SCOPE_KEY = computeSlotScopeKey(SESSION_BROKER_SCOPE);

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

  override async recover(): Promise<void> {
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
}

describe("session broker service lifecycle", () => {
  let registry: SqliteSlotRegistry;

  beforeEach(async () => {
    registry = await openSqliteSlotRegistry({
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
      journal: { owner: OWNER, redriveSlot: unusedNativeCall },
      owner: OWNER,
      timer,
      sessionIsLive: () => true,
      hostLock: lock,
      catalog: async () => iosCatalog(),
    };
  }

  test("close wakes an idle loop, closes the broker, and releases the lock once", async () => {
    const timer = new FakeTimer();
    const lock = new RecordingLock();
    const broker = new ControlledBroker(registry.sessionBrokerStore(BROKER_SCOPE_KEY));
    const service = new SessionBrokerService(broker, BROKER_SCOPE_KEY, lock, timer);
    service.start();
    expect(timer.getPendingTimeouts()).toEqual([5_000]);

    const first = service.close();
    const second = service.close();

    expect(second).toBe(first);
    await first;
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(broker.events).toEqual(["broker:close"]);
    expect(lock.events).toEqual(["lock:release"]);
  });

  test("close joins an in-flight recovery pass before broker close and lock release", async () => {
    const timer = new FakeTimer();
    const lock = new RecordingLock();
    const broker = new ControlledBroker(registry.sessionBrokerStore(BROKER_SCOPE_KEY));
    broker.blockRecovery = true;
    const service = new SessionBrokerService(broker, BROKER_SCOPE_KEY, lock, timer);
    service.start();
    timer.advanceTime(5_000);
    await broker.recoveryStarted.promise;

    let closed = false;
    const closing = service.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(lock.events).toEqual([]);

    broker.finishRecovery.resolve();
    await closing;
    expect(broker.events).toEqual(["recover:start", "recover:end", "broker:close"]);
    expect(lock.events).toEqual(["lock:release"]);
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
    const key = { scopeKey: scope.scope.scopeKey, slotIndex: 0 };
    await registry.initSlot(key, {
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

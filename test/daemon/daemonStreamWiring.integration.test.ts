import { afterEach, describe, expect, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import {
  OBSERVATION_BATCH_HEADROOM_MS,
  PER_DEVICE_OBSERVATION_TIMEOUT_MS,
} from "../../src/daemon/observationRequestBatch";
import type {
  DeviceSessionRecord,
  DeviceSessionRegistry,
} from "../../src/daemon/deviceSessionRegistry";
import type { DeviceSessionResolver } from "../../src/daemon/deviceSessionResolver";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import { NavigationRepository } from "../../src/db/navigationRepository";
import { TestCoverageRepository } from "../../src/db/testCoverageRepository";
import { NavigationGraphManager } from "../../src/features/navigation/NavigationGraphManager";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeTimer } from "../fakes/FakeTimer";

interface RoutingTarget {
  setDeviceSessionResolver(resolver: DeviceSessionResolver): void;
}

interface RoutingTargets {
  deviceDataStream: RoutingTarget | null;
  performancePush: RoutingTarget | null;
  failuresPush: RoutingTarget | null;
  telemetryPush: RoutingTarget | null;
}

interface PooledEntry {
  id: string;
  platform: string;
}

interface DaemonStreamInternals {
  devicePool: {
    isPooledIdentityUnresolved(deviceId: string): boolean;
    getAllDevices(): PooledEntry[];
    assertDeviceActionable(deviceId: string, purpose: string): void;
  };
  observationStreamHealth: {
    isHealthy(): boolean;
    recover(): Promise<void>;
  };
  deviceSessionRegistry: DeviceSessionRegistry;
  getDeviceSessionRoutingTargets(): RoutingTargets;
  setupDeviceSessionRouting(): void;
  setupNavigationGraphStreamListener(server: unknown): void;
  setupNavigationGraphUpdateListener(manager: NavigationGraphManager): void;
  attemptRecovery(failureKind?: string): Promise<void>;
  applyStorageSubscriptionRequest(request: {
    deviceId: string | null;
    packageName: string;
    fileName: string;
    subscribe: boolean;
  }): Promise<void>;
}

class FakePushServer implements RoutingTarget {
  resolver: DeviceSessionResolver | null = null;

  setDeviceSessionResolver(resolver: DeviceSessionResolver): void {
    this.resolver = resolver;
  }
}

class FakeDeviceDataStreamServer extends FakePushServer {
  started: DeviceSessionRecord[] = [];
  navigationUpdates: Array<{ appId: string | null; deviceId: string | null | undefined }> = [];
  subscriberCallbackInstalled = false;
  screenshotCadenceCallbackInstalled = false;
  hierarchyCadenceCallbackInstalled = false;
  observationCallbackInstalled = false;
  observationRequestTimeoutMs: number | undefined;
  navigationRequestCallbackInstalled = false;
  storageSubscriptionCallbackInstalled = false;

  pushDeviceSessionStarted(record: DeviceSessionRecord): void {
    this.started.push(record);
  }

  pushDeviceSessionEnded(_record: DeviceSessionRecord): void {}

  pushNavigationGraphUpdate(
    streamData: { appId: string | null },
    deviceId: string | null | undefined,
  ): void {
    this.navigationUpdates.push({ appId: streamData.appId, deviceId });
  }

  setOnSubscriberConnected(_handler: unknown): void {
    this.subscriberCallbackInstalled = true;
  }

  setOnScreenshotCadenceChanged(_handler: unknown): void {
    this.screenshotCadenceCallbackInstalled = true;
  }

  setOnHierarchyCadenceChanged(_handler: unknown): void {
    this.hierarchyCadenceCallbackInstalled = true;
  }

  setOnObservationRequested(_handler: unknown, timeoutMs?: number): void {
    this.observationCallbackInstalled = true;
    this.observationRequestTimeoutMs = timeoutMs;
  }

  setOnNavigationGraphRequested(_handler: unknown): void {
    this.navigationRequestCallbackInstalled = true;
  }

  setOnStorageSubscriptionRequested(_handler: unknown): void {
    this.storageSubscriptionCallbackInstalled = true;
  }
}

function targets(deviceDataStream: FakeDeviceDataStreamServer): RoutingTargets {
  return {
    deviceDataStream,
    performancePush: new FakePushServer(),
    failuresPush: new FakePushServer(),
    telemetryPush: new FakePushServer(),
  };
}

async function flushNavigationUpdate(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("Daemon stream wiring", () => {
  afterEach(() => {
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
    NavigationGraphManager.resetInstance();
  });

  test("reinstalls routing and lifecycle delivery on an observation-stream replacement", async () => {
    const timer = new FakeTimer();
    const db = await createTestDatabase();
    const daemon = new Daemon(
      {},
      undefined,
      timer,
      new DeviceSessionRepository(db),
      new CountingIdGenerator("device-session"),
    );
    const internals = daemon as unknown as DaemonStreamInternals;
    const originalStream = new FakeDeviceDataStreamServer();
    const replacementStream = new FakeDeviceDataStreamServer();
    let activeTargets = targets(originalStream);
    internals.getDeviceSessionRoutingTargets = () => activeTargets;

    try {
      internals.setupDeviceSessionRouting();
      const originalRecord = internals.deviceSessionRegistry.onDeviceConnected({
        deviceId: "emulator-original",
        platform: "android",
        incarnation: 1,
      });

      internals.observationStreamHealth = {
        isHealthy: () => false,
        recover: async () => {
          activeTargets = targets(replacementStream);
        },
      };
      await internals.attemptRecovery("socket");

      const recoveredRecord = internals.deviceSessionRegistry.onDeviceConnected({
        deviceId: "emulator-recovered",
        platform: "android",
        incarnation: 1,
      });

      expect(originalStream.resolver?.resolveUuid(originalRecord.deviceId)).toBe(
        originalRecord.deviceSessionUuid,
      );
      expect(originalStream.started).toEqual([originalRecord]);
      expect(replacementStream.resolver?.resolveUuid(recoveredRecord.deviceId)).toBe(
        recoveredRecord.deviceSessionUuid,
      );
      expect(replacementStream.started).toEqual([recoveredRecord]);
      expect(replacementStream.subscriberCallbackInstalled).toBe(true);
      expect(replacementStream.screenshotCadenceCallbackInstalled).toBe(true);
      expect(replacementStream.hierarchyCadenceCallbackInstalled).toBe(true);
      expect(replacementStream.observationCallbackInstalled).toBe(true);
      expect(replacementStream.observationRequestTimeoutMs).toBe(
        PER_DEVICE_OBSERVATION_TIMEOUT_MS + OBSERVATION_BATCH_HEADROOM_MS,
      );
      expect(replacementStream.navigationRequestCallbackInstalled).toBe(true);
      expect(replacementStream.storageSubscriptionCallbackInstalled).toBe(true);
    } finally {
      daemon.getSessionManager().stopCleanupTimer();
    }
  });

  // The resolver handed to every push server reads the POOL's quarantine, not just
  // the registry, so a serial whose AVD identity is unresolved has no routing
  // identity in either direction while the epoch itself is preserved (#6863 review).
  test("withholds routing identity for a pool-quarantined serial", async () => {
    const timer = new FakeTimer();
    const db = await createTestDatabase();
    const daemon = new Daemon(
      {},
      undefined,
      timer,
      new DeviceSessionRepository(db),
      new CountingIdGenerator("device-session"),
    );
    const internals = daemon as unknown as DaemonStreamInternals;
    const stream = new FakeDeviceDataStreamServer();
    internals.getDeviceSessionRoutingTargets = () => targets(stream);
    let quarantined = false;
    internals.devicePool.isPooledIdentityUnresolved = (deviceId: string) =>
      quarantined && deviceId === "emulator-5554";

    try {
      internals.setupDeviceSessionRouting();
      const record = internals.deviceSessionRegistry.onDeviceConnected({
        deviceId: "emulator-5554",
        platform: "android",
        incarnation: 1,
      });
      expect(stream.resolver?.resolveUuid("emulator-5554")).toBe(record.deviceSessionUuid);

      quarantined = true;

      expect(stream.resolver?.resolveUuid("emulator-5554")).toBeNull();
      expect(stream.resolver?.resolveDeviceId(record.deviceSessionUuid)).toBeNull();
      expect(stream.resolver?.isRoutingSuspended("emulator-5554")).toBe(true);

      quarantined = false;

      // The epoch was preserved underneath, so routing resumes on the SAME uuid.
      expect(stream.resolver?.resolveUuid("emulator-5554")).toBe(record.deviceSessionUuid);
    } finally {
      daemon.getSessionManager().stopCleanupTimer();
    }
  });

  test("forwards live session-scoped navigation changes to the active stream", async () => {
    const timer = new FakeTimer();
    const db = await createTestDatabase();
    const sessionId = "navigation-session";
    const sessionNavigation = NavigationGraphManager.createForTesting(
      new NavigationRepository(db),
      new TestCoverageRepository(undefined, db),
      undefined,
      sessionId,
    );
    NavigationGraphManager.setInstanceForTesting(
      NavigationGraphManager.createForTesting(
        new NavigationRepository(db),
        new TestCoverageRepository(undefined, db),
      ),
    );
    NavigationGraphManager.setInstanceForSessionForTesting(sessionId, sessionNavigation);
    const daemon = new Daemon(
      {},
      undefined,
      timer,
      new DeviceSessionRepository(db),
      new CountingIdGenerator("daemon"),
    );
    const internals = daemon as unknown as DaemonStreamInternals;
    const stream = new FakeDeviceDataStreamServer();
    internals.getDeviceSessionRoutingTargets = () => targets(stream);

    try {
      await daemon.getSessionManager().createSession(sessionId, "emulator-5554", "android");
      internals.setupDeviceSessionRouting();
      internals.setupNavigationGraphStreamListener(stream);

      await sessionNavigation.setCurrentApp("com.example.session");
      await flushNavigationUpdate();

      expect(stream.navigationUpdates).toEqual([{ appId: "com.example.session", deviceId: null }]);
    } finally {
      daemon.getSessionManager().stopCleanupTimer();
    }
  });

  test("attaches a newly-created session without a later stream configuration pass", async () => {
    const timer = new FakeTimer();
    const db = await createTestDatabase();
    const sessionId = "created-after-stream-setup";
    const sessionNavigation = NavigationGraphManager.createForTesting(
      new NavigationRepository(db),
      new TestCoverageRepository(undefined, db),
      undefined,
      sessionId,
    );
    NavigationGraphManager.setInstanceForTesting(
      NavigationGraphManager.createForTesting(
        new NavigationRepository(db),
        new TestCoverageRepository(undefined, db),
      ),
    );
    NavigationGraphManager.setInstanceForSessionForTesting(sessionId, sessionNavigation);
    const daemon = new Daemon(
      {},
      undefined,
      timer,
      new DeviceSessionRepository(db),
      new CountingIdGenerator("daemon"),
    );
    const internals = daemon as unknown as DaemonStreamInternals;
    const stream = new FakeDeviceDataStreamServer();
    internals.getDeviceSessionRoutingTargets = () => targets(stream);

    try {
      internals.setupDeviceSessionRouting();
      internals.setupNavigationGraphStreamListener(stream);
      await daemon.getSessionManager().createSession(sessionId, "emulator-5554", "android");

      await sessionNavigation.setCurrentApp("com.example.created-after-setup");
      await flushNavigationUpdate();

      expect(stream.navigationUpdates).toEqual([
        { appId: "com.example.created-after-setup", deviceId: null },
      ]);
    } finally {
      daemon.getSessionManager().stopCleanupTimer();
    }
  });

  test("replaces the navigation listener when a session rebinds", async () => {
    const timer = new FakeTimer();
    const db = await createTestDatabase();
    const sessionId = "rebound-navigation-session";
    const initialNavigation = NavigationGraphManager.createForTesting(
      new NavigationRepository(db),
      new TestCoverageRepository(undefined, db),
      undefined,
      sessionId,
    );
    NavigationGraphManager.setInstanceForTesting(
      NavigationGraphManager.createForTesting(
        new NavigationRepository(db),
        new TestCoverageRepository(undefined, db),
      ),
    );
    NavigationGraphManager.setInstanceForSessionForTesting(sessionId, initialNavigation);
    const daemon = new Daemon(
      {},
      undefined,
      timer,
      new DeviceSessionRepository(db),
      new CountingIdGenerator("daemon"),
    );
    const internals = daemon as unknown as DaemonStreamInternals;
    const stream = new FakeDeviceDataStreamServer();
    internals.getDeviceSessionRoutingTargets = () => targets(stream);
    const attachedManagers: NavigationGraphManager[] = [];
    internals.setupNavigationGraphUpdateListener = (manager) => {
      attachedManagers.push(manager);
    };

    try {
      internals.setupDeviceSessionRouting();
      internals.setupNavigationGraphStreamListener(stream);
      await daemon.getSessionManager().createSession(sessionId, "emulator-old", "android");

      await daemon.getSessionManager().rebindSession(sessionId, "emulator-new", "android");

      expect(attachedManagers).toHaveLength(3);
      expect(attachedManagers[1]).toBe(initialNavigation);
      expect(attachedManagers[2]).not.toBe(initialNavigation);
    } finally {
      daemon.getSessionManager().stopCleanupTimer();
    }
  });

  test("does not deliver an in-flight navigation update after session release", async () => {
    const timer = new FakeTimer();
    const db = await createTestDatabase();
    const sessionId = "released-navigation-session";
    NavigationGraphManager.setInstanceForTesting(
      NavigationGraphManager.createForTesting(
        new NavigationRepository(db),
        new TestCoverageRepository(undefined, db),
      ),
    );
    const sessionNavigation = NavigationGraphManager.createForTesting(
      new NavigationRepository(db),
      new TestCoverageRepository(undefined, db),
      undefined,
      sessionId,
    );
    NavigationGraphManager.setInstanceForSessionForTesting(sessionId, sessionNavigation);
    const daemon = new Daemon(
      {},
      undefined,
      timer,
      new DeviceSessionRepository(db),
      new CountingIdGenerator("daemon"),
    );
    const internals = daemon as unknown as DaemonStreamInternals;
    const stream = new FakeDeviceDataStreamServer();
    internals.getDeviceSessionRoutingTargets = () => targets(stream);

    try {
      internals.setupDeviceSessionRouting();
      internals.setupNavigationGraphStreamListener(stream);
      await daemon.getSessionManager().createSession(sessionId, "emulator-5554", "android");
      const originalExport = sessionNavigation.exportGraphSummary.bind(sessionNavigation);
      const exportStarted = Promise.withResolvers<void>();
      const resumeExport = Promise.withResolvers<void>();
      sessionNavigation.exportGraphSummary = async () => {
        exportStarted.resolve();
        await resumeExport.promise;
        return await originalExport();
      };

      await sessionNavigation.setCurrentApp("com.example.released");
      await exportStarted.promise;
      await daemon.getSessionManager().releaseSession(sessionId);
      resumeExport.resolve();
      await flushNavigationUpdate();

      expect(stream.navigationUpdates).toEqual([]);
    } finally {
      daemon.getSessionManager().stopCleanupTimer();
    }
  });

  test("clears a released UUID tombstone before attaching its recreated session", async () => {
    const timer = new FakeTimer();
    const db = await createTestDatabase();
    const sessionId = "recreated-session";
    const globalNavigation = NavigationGraphManager.createForTesting(
      new NavigationRepository(db),
      new TestCoverageRepository(undefined, db),
    );
    NavigationGraphManager.setInstanceForTesting(globalNavigation);
    NavigationGraphManager.releaseSession(sessionId);
    const daemon = new Daemon(
      {},
      undefined,
      timer,
      new DeviceSessionRepository(db),
      new CountingIdGenerator("daemon"),
    );
    const internals = daemon as unknown as DaemonStreamInternals;
    const attachedManagers: NavigationGraphManager[] = [];
    internals.setupNavigationGraphUpdateListener = (manager) => {
      attachedManagers.push(manager);
    };

    try {
      await daemon.getSessionManager().createSession(sessionId, "emulator-5554", "android");

      const recreatedNavigation = NavigationGraphManager.getInstanceForSession(sessionId);
      expect(recreatedNavigation).not.toBe(globalNavigation);
      expect(attachedManagers).toEqual([recreatedNavigation]);
    } finally {
      daemon.getSessionManager().stopCleanupTimer();
    }
  });

  // An all-device `subscribe_storage` names no serial, so the socket server's
  // FUNNEL 2 preflight cannot run: `storageDeviceId` is null and the fan-out
  // below interprets null as EVERY pooled Android device. Each target it expands
  // to is device-addressed work in its own right and must pass the gate, or the
  // request installs a content observer on whichever replacement AVD answers on a
  // quarantined serial and still acks success
  // ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
  describe("all-device storage subscription fan-out", () => {
    async function daemonWithPool(
      pooled: PooledEntry[],
      quarantined: ReadonlySet<string>,
    ): Promise<{ daemon: Daemon; internals: DaemonStreamInternals }> {
      const db = await createTestDatabase();
      const daemon = new Daemon(
        {},
        undefined,
        new FakeTimer(),
        new DeviceSessionRepository(db),
        new CountingIdGenerator("device-session"),
      );
      const internals = daemon as unknown as DaemonStreamInternals;
      internals.devicePool.getAllDevices = () => pooled;
      internals.devicePool.assertDeviceActionable = (deviceId: string, purpose: string) => {
        if (quarantined.has(deviceId)) {
          throw new Error(`Refusing ${purpose} on device '${deviceId}'`);
        }
      };
      return { daemon, internals };
    }

    test("refuses an all-device subscribe that expands to a quarantined serial", async () => {
      const { daemon, internals } = await daemonWithPool(
        [
          { id: "emulator-5554", platform: "android" },
          { id: "emulator-5556", platform: "android" },
        ],
        new Set(["emulator-5556"]),
      );

      try {
        await expect(
          internals.applyStorageSubscriptionRequest({
            deviceId: null,
            packageName: "com.example",
            fileName: "prefs.xml",
            subscribe: true,
          }),
        ).rejects.toThrow(/emulator-5556/);
      } finally {
        daemon.getSessionManager().stopCleanupTimer();
      }
    });

    test("applies an all-device subscribe when no target is quarantined", async () => {
      const { daemon, internals } = await daemonWithPool(
        [{ id: "emulator-5554", platform: "android" }],
        new Set(),
      );

      try {
        await internals.applyStorageSubscriptionRequest({
          deviceId: null,
          packageName: "com.example",
          fileName: "prefs.xml",
          subscribe: true,
        });
      } finally {
        daemon.getSessionManager().stopCleanupTimer();
      }
    });

    // Teardown stays exempt for the same reason the socket server exempts it:
    // refusing it would strand the observer this daemon registered.
    test("still releases an all-device subscription that expands to a quarantined serial", async () => {
      const { daemon, internals } = await daemonWithPool(
        [{ id: "emulator-5554", platform: "android" }],
        new Set(["emulator-5554"]),
      );

      try {
        await internals.applyStorageSubscriptionRequest({
          deviceId: null,
          packageName: "com.example",
          fileName: "prefs.xml",
          subscribe: false,
        });
      } finally {
        daemon.getSessionManager().stopCleanupTimer();
      }
    });
  });
});

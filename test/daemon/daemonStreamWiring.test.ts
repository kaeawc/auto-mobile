import { afterEach, describe, expect, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
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

interface DaemonStreamInternals {
  observationStreamHealth: {
    isHealthy(): boolean;
    recover(): Promise<void>;
  };
  deviceSessionRegistry: DeviceSessionRegistry;
  getDeviceSessionRoutingTargets(): RoutingTargets;
  setupDeviceSessionRouting(): void;
  setupNavigationGraphStreamListener(server: unknown): void;
  attemptRecovery(failureKind?: string): Promise<void>;
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

  setOnNavigationGraphRequested(_handler: unknown): void {}
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
});

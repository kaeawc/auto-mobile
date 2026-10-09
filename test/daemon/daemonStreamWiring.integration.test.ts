import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios/IOSCtrlProxyClient";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import { DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV } from "../../src/daemon/liveAcceptanceCapability";
import { DeviceDataStreamSocketServer } from "../../src/daemon/deviceDataStreamSocketServer";
import { DefaultObservationInitialFrameCoordinator } from "../../src/daemon/observationInitialFrameCoordinator";
import type { InitialObservationFrame } from "../../src/daemon/observationInitialFrame";
import { DevicePool } from "../../src/daemon/devicePool";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { installDeviceDataStreamSocketServerForTesting } from "../../src/daemon/deviceDataStreamSocketServer";
import { createFakeDaemonState } from "./helpers/inputSocketHarness";
import { FakeSocket } from "../fakes/FakeNetServer";
import type { BootedDevice } from "../../src/models";
import {
  OBSERVATION_BATCH_HEADROOM_MS,
  PER_DEVICE_OBSERVATION_TIMEOUT_MS,
} from "../../src/daemon/observationRequestBatch";
import type {
  DeviceSessionRecord,
  DeviceSessionEndOptions,
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
import { FakeDeviceSessionRepository } from "../fakes/FakeDeviceSessionRepository";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeDatabaseInitializer } from "../fakes/FakeDatabaseInitializer";
import { FakeStartupFailureTracker } from "../fakes/FakeStartupFailureTracker";
import { FakeIOSCtrlProxyManager } from "../fakes/FakeIOSCtrlProxyManager";
import { logger } from "../../src/utils/logger";
import { RealObserveScreen } from "../../src/features/observe/ObserveScreen";
import type { ObserveResult } from "../../src/models";
import * as appearanceSyncScheduler from "../../src/daemon/AppearanceSyncScheduler";
import type {
  OnNavigationGraphRequestedCallback,
  OnObservationRequestedCallback,
  OnSubscriberConnectedCallback,
  RequestedObservation,
} from "../../src/daemon/deviceDataStreamSocketServer";

interface RoutingTarget {
  setDeviceSessionResolver(resolver: DeviceSessionResolver): void;
}

class StaticScreenStreamServer extends DeviceDataStreamSocketServer {
  requestObservation(socket: FakeSocket): Promise<void> {
    // All-device requests can start while a serial is quarantined; delivery still checks identity.
    return this.processLine(socket, JSON.stringify({ command: "request_observation" }));
  }

  subscribe(socket: FakeSocket): void {
    this.subscribers.set("static-pane", {
      socket,
      subscriptionId: "static-pane",
      lastActivity: 0,
      filter: {
        deviceSessionUuid: null,
        deviceId: null,
        screenshotIntervalMs: null,
        hierarchyIntervalMs: null,
      },
      backfilling: false,
      drainPending: false,
    });
  }
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
  sessionManager: {
    getSession(sessionUuid: string): unknown | null;
    getSessionForDevice(deviceId: string): string | null;
    getDeviceLabels(sessionUuid: string): Record<string, string> | undefined;
  };
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
  setupDeviceDataStreamCallback(): void;
  setupNavigationGraphStreamListener(server: unknown): void;
  setupNavigationGraphUpdateListener(manager: NavigationGraphManager): void;
  attemptRecovery(failureKind?: string): Promise<void>;
  applyStorageSubscriptionRequest(request: {
    deviceId: string | null;
    sessionUuid: string;
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
  ended: Array<{ record: DeviceSessionRecord; successorSessionUuid?: string }> = [];
  navigationUpdates: Array<{ appId: string | null; deviceId: string | null | undefined }> = [];
  subscriberCallbackInstalled = false;
  screenshotCadenceCallbackInstalled = false;
  hierarchyCadenceCallbackInstalled = false;
  observationCallbackInstalled = false;
  observationHandler: OnObservationRequestedCallback | null = null;
  observationRequestTimeoutMs: number | undefined;
  navigationRequestCallbackInstalled = false;
  navigationRequestHandler: OnNavigationGraphRequestedCallback | null = null;
  storageSubscriptionCallbackInstalled = false;
  subscriberConnected: ((deviceId: string | null) => void) | null = null;
  screenshotCadenceChanged: ((deviceId: string | null) => void) | null = null;
  hierarchyCadenceChanged: ((deviceId: string | null) => void) | null = null;

  invalidateDeviceFrames(_deviceId: string): void {}

  invalidateInitialDeviceFrames(_deviceId: string): void {}

  removeDeviceFrames(_deviceId: string): void {}

  getDeviceSessionUuid(deviceId: string): string | null {
    return this.resolver?.resolveUuid(deviceId) ?? null;
  }

  getLiveFrameGeneration(_deviceId: string): number {
    return 0;
  }

  pushDeviceSessionStarted(record: DeviceSessionRecord): void {
    this.started.push(record);
  }

  pushDeviceSessionEnded(record: DeviceSessionRecord, options?: DeviceSessionEndOptions): void {
    this.ended.push({
      record,
      ...options,
    });
  }

  pushNavigationGraphUpdate(
    streamData: { appId: string | null },
    deviceId: string | null | undefined,
  ): void {
    this.navigationUpdates.push({ appId: streamData.appId, deviceId });
  }

  setOnSubscriberConnected(handler: OnSubscriberConnectedCallback): void {
    this.subscriberCallbackInstalled = true;
    let subscriptions = 0;
    this.subscriberConnected = (deviceId) =>
      handler(deviceId, {
        subscriptionId: `fake-pane-${subscriptions++}`,
        signal: new AbortController().signal,
      });
  }

  setOnScreenshotCadenceChanged(handler: (deviceId: string | null) => void): void {
    this.screenshotCadenceCallbackInstalled = true;
    this.screenshotCadenceChanged = handler;
  }

  setOnHierarchyCadenceChanged(handler: (deviceId: string | null) => void): void {
    this.hierarchyCadenceCallbackInstalled = true;
    this.hierarchyCadenceChanged = handler;
  }

  getHierarchyIntervalMsForDevice(_deviceId: string): number {
    return 1_000;
  }

  setOnObservationRequested(handler: OnObservationRequestedCallback, timeoutMs?: number): void {
    this.observationCallbackInstalled = true;
    this.observationHandler = handler;
    this.observationRequestTimeoutMs = timeoutMs;
  }

  setOnNavigationGraphRequested(handler: OnNavigationGraphRequestedCallback): void {
    this.navigationRequestCallbackInstalled = true;
    this.navigationRequestHandler = handler;
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
  beforeAll(async () => {
    // Migrations are fixture setup, not the lifecycle behavior under the 100 ms budget.
    // Warm the shared template while keeping each test's cloned database independent.
    const db = await createTestDatabase();
    await db.destroy();
  });

  afterEach(() => {
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
    NavigationGraphManager.resetInstance();
  });

  const invalidationEvents: Array<{
    name: string;
    owned?: boolean;
    quarantined?: boolean;
    apply(daemon: Daemon, pool: DevicePool): Promise<void> | void;
    additionalDevice?: string;
    generationOnly?: boolean;
  }> = [
    {
      name: "ownership acquisition",
      generationOnly: true,
      apply: async (daemon) => {
        await daemon.getSessionManager().createSession("owner", "emulator-5554", "android");
      },
    },
    {
      name: "ownership release",
      generationOnly: true,
      owned: true,
      apply: async (daemon) => {
        await daemon.getSessionManager().releaseSession("owner");
      },
    },
    {
      name: "same-serial unchanged-runtime session rebind",
      owned: true,
      generationOnly: true,
      apply: async (daemon) => {
        await daemon.getSessionManager().rebindSession("owner", "emulator-5554", "android");
      },
    },
    {
      name: "same-serial session rebind",
      owned: true,
      apply: async (daemon) => {
        await daemon
          .getSessionManager()
          .rebindSession("owner", "emulator-5554", "android", { force: true });
      },
    },
    {
      name: "replacement-serial session rebind",
      owned: true,
      additionalDevice: "emulator-5556",
      apply: async (daemon) => {
        await daemon.getSessionManager().rebindSession("owner", "emulator-5556", "android");
      },
    },
    {
      name: "terminal-release recovery rebind",
      owned: true,
      additionalDevice: "emulator-5556",
      apply: async (daemon) => {
        const manager = daemon.getSessionManager();
        const session = manager.getSession("owner")!;
        const releaseReservation = manager.reserveSessionForTerminalRelease(
          session,
          "emulator-5554",
        );
        try {
          await manager.rebindSessionForTerminalReleaseRecovery(
            session,
            "emulator-5556",
            "android",
          );
        } finally {
          releaseReservation();
        }
      },
    },
    {
      name: "pool reinitialization",
      apply: async (_daemon, pool) => {
        await pool.initializeWithDevices([
          { deviceId: "emulator-5554", name: "Pixel", platform: "android" },
        ]);
      },
    },
    {
      name: "pool removal",
      apply: async (_daemon, pool) => {
        await pool.removeDevice("emulator-5554");
      },
    },
    {
      name: "pool removal followed by serial re-add",
      apply: async (daemon, pool) => {
        await pool.removeDevice("emulator-5554");
        const stream = (
          daemon as unknown as { deviceDataStreamServer: DeviceDataStreamSocketServer }
        ).deviceDataStreamServer;
        expect(
          (
            stream as unknown as { liveFrameGenerations: ReadonlyMap<string, number> }
          ).liveFrameGenerations.has("emulator-5554"),
        ).toBe(false);
        await pool.addDevice({ deviceId: "emulator-5554", name: "Pixel", platform: "android" });
      },
    },
    {
      name: "VM restore incarnation change",
      apply: (_daemon, pool) => {
        pool.bumpDeviceIncarnation("emulator-5554");
      },
    },
    {
      name: "identity quarantine entry",
      apply: async (_daemon, pool) => {
        await pool.reconcileDiscoveryObservation(
          [
            {
              deviceId: "emulator-5554",
              name: "Different AVD",
              platform: "android",
              observedAt: 1,
            },
          ],
          "test",
        );
      },
    },
    {
      name: "identity quarantine lift",
      quarantined: true,
      apply: async (_daemon, pool) => {
        await pool.reconcileDiscoveryObservation(
          [{ deviceId: "emulator-5554", name: "Pixel", platform: "android", observedAt: 2 }],
          "test",
        );
      },
    },
  ];

  for (const event of invalidationEvents) {
    for (const state of ["in-flight", "cached"] as const) {
      test(`invalidates ${state} device frames on ${event.name}`, async () => {
        const timer = new FakeTimer();
        const db = await createTestDatabase();
        const graph = NavigationGraphManager.createForTesting(
          new NavigationRepository(db),
          new TestCoverageRepository(undefined, db),
        );
        const navigation = spyOn(NavigationGraphManager, "getInstanceForSession").mockReturnValue(
          graph,
        );
        const daemon = new Daemon(
          {},
          new FakeInstalledAppsRepository(),
          timer,
          new FakeDeviceSessionRepository(),
          new CountingIdGenerator("epoch"),
          new FakeDatabaseInitializer(),
          new FakeStartupFailureTracker(),
        );
        const internals = daemon as unknown as DaemonStreamInternals;
        const stream = new StaticScreenStreamServer("/fake/unused.sock", timer, {
          authorize: () => {},
        });
        internals.getDeviceSessionRoutingTargets = () => ({
          deviceDataStream: stream,
          performancePush: null,
          failuresPush: null,
          telemetryPush: null,
        });
        internals.setupNavigationGraphUpdateListener = () => {};
        const pool = internals.devicePool as unknown as DevicePool;
        try {
          internals.setupDeviceSessionRouting();
          await pool.initializeWithDevices([
            { deviceId: "emulator-5554", name: "Pixel", platform: "android" },
          ]);
          if (event.owned) {
            await daemon.getSessionManager().createSession("owner", "emulator-5554", "android");
          }
          if (event.quarantined) {
            await pool.reconcileDiscoveryObservation(
              [
                {
                  deviceId: "emulator-5554",
                  name: "Different AVD",
                  platform: "android",
                  observedAt: 1,
                },
              ],
              "test",
            );
          }
          const pane = new FakeSocket();
          stream.subscribe(pane);
          const hierarchy = { hierarchy: { node: { $: { class: "Root", text: "unchanged" } } } };
          stream.pushHierarchyUpdate("emulator-5554", hierarchy, "static-context");
          const inputServer = new UnixSocketServer(
            "/fake/input.sock",
            "http://localhost:0/mcp",
            createFakeDaemonState(),
            timer,
          );
          const input = inputServer as unknown as {
            requireCurrentFrameContext(
              deviceId: string,
              frameContext: string,
              action: string,
            ): void;
          };
          installDeviceDataStreamSocketServerForTesting(stream);
          const coordinator = new DefaultObservationInitialFrameCoordinator(
            timer,
            2,
            (id) => stream.getLiveFrameGeneration(id),
            (id) => stream.getDeviceSessionUuid(id),
          );
          const frame: InitialObservationFrame = {
            hierarchy: { hierarchy: {} },
            screenshot: { data: "pixels", width: 1, height: 1, metadata: {} },
            recordHierarchy: () => {},
          };
          const capture = Promise.withResolvers<InitialObservationFrame>();
          const signal = new AbortController().signal;
          let captures = 0;
          const first = coordinator.request(
            "emulator-5554",
            () => {
              captures++;
              return capture.promise;
            },
            signal,
          );
          if (state === "cached") {
            capture.resolve(frame);
            expect((await first)?.replay).toBe(false);
          }
          const generation = stream.getLiveFrameGeneration("emulator-5554");
          const otherGeneration = event.additionalDevice
            ? stream.getLiveFrameGeneration(event.additionalDevice)
            : undefined;
          const observation = Promise.withResolvers<RequestedObservation[]>();
          const observationStarted = Promise.withResolvers<void>();
          stream.setOnObservationRequested(() => {
            observationStarted.resolve();
            return observation.promise;
          });
          const explicit = stream.requestObservation(pane);
          await observationStarted.promise;
          await event.apply(daemon, pool);
          expect(stream.getLiveFrameGeneration("emulator-5554")).toBeGreaterThan(generation);
          if (event.generationOnly) {
            expect(() =>
              input.requireCurrentFrameContext("emulator-5554", "static-context", "input/tap"),
            ).not.toThrow();
          } else {
            expect(stream.getCurrentFrameContext("emulator-5554")).toBeUndefined();
          }
          if (state === "in-flight") {
            capture.resolve(frame);
            expect(await first).toBeUndefined();
          }
          const fresh = await coordinator.request(
            "emulator-5554",
            async () => {
              captures++;
              return { ...frame };
            },
            signal,
          );
          expect(captures).toBe(2);
          expect(fresh?.replay).toBe(false);
          expect(fresh?.frame.deviceSessionUuid).toBe(stream.getDeviceSessionUuid("emulator-5554"));
          const frameCount = pane
            .getWrittenMessages<{ type: string }>()
            .filter((m) => m.type === "hierarchy_update").length;
          observation.resolve([
            {
              deviceId: "emulator-5554",
              observation: {
                updatedAt: "2026-10-01T00:00:00Z",
                screenSize: { width: 1, height: 1 },
                systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
                viewHierarchy: { ...hierarchy, frameContext: "static-context" },
              },
            },
          ]);
          await explicit;
          if (event.generationOnly) {
            expect(
              pane
                .getWrittenMessages<{ type: string }>()
                .filter((m) => m.type === "hierarchy_update"),
            ).toHaveLength(frameCount + 1);
            expect(
              pane
                .getWrittenMessages<{
                  type: string;
                  hierarchyDiff?: { hasBaseline: boolean; changed: number };
                }>()
                .filter((m) => m.type === "hierarchy_update")
                .at(-1)?.hierarchyDiff,
            ).toMatchObject({ hasBaseline: true, changed: 0 });
            expect(() =>
              input.requireCurrentFrameContext("emulator-5554", "static-context", "input/tap"),
            ).not.toThrow();
          } else {
            expect(
              pane
                .getWrittenMessages<{ type: string }>()
                .filter((m) => m.type === "hierarchy_update"),
            ).toHaveLength(frameCount);
            expect(stream.getCurrentFrameContext("emulator-5554")).toBeUndefined();
          }
          if (event.additionalDevice && otherGeneration !== undefined) {
            expect(stream.getLiveFrameGeneration(event.additionalDevice)).toBeGreaterThan(
              otherGeneration,
            );
          }
        } finally {
          installDeviceDataStreamSocketServerForTesting(null);
          daemon.getSessionManager().stopCleanupTimer();
          navigation.mockRestore();
        }
      });
    }
  }

  test("forwards a successor uuid only when the registry replaces a live epoch", () => {
    const daemon = new Daemon(
      {},
      new FakeInstalledAppsRepository(),
      new FakeTimer(),
      new FakeDeviceSessionRepository(),
      new CountingIdGenerator("device-session"),
      new FakeDatabaseInitializer(),
      new FakeStartupFailureTracker(),
    );
    const internals = daemon as unknown as DaemonStreamInternals;
    const stream = new FakeDeviceDataStreamServer();
    internals.getDeviceSessionRoutingTargets = () => targets(stream);

    try {
      internals.setupDeviceSessionRouting();
      const first = internals.deviceSessionRegistry.onDeviceConnected({
        deviceId: "emulator-5554",
        platform: "android",
        incarnation: 1,
      });
      const second = internals.deviceSessionRegistry.onDeviceConnected({
        deviceId: "emulator-5554",
        platform: "android",
        incarnation: 2,
      });
      expect(stream.ended).toEqual([
        { record: first, successorSessionUuid: second.deviceSessionUuid },
      ]);

      internals.deviceSessionRegistry.onDeviceDisconnected("emulator-5554");
      expect(stream.ended).toEqual([
        { record: first, successorSessionUuid: second.deviceSessionUuid },
        { record: second },
      ]);
    } finally {
      daemon.getSessionManager().stopCleanupTimer();
    }
  });

  test("an all-device subscriber connects owned Android and logs the skipped unowned device", async () => {
    const previousAllowlist = process.env.AUTOMOBILE_ANDROID_OBSERVATION_STREAM_DEVICES;
    delete process.env.AUTOMOBILE_ANDROID_OBSERVATION_STREAM_DEVICES;
    const connected: string[] = [];
    const client = spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation((device) => {
      connected.push(device.deviceId);
      return { ensureConnected: async () => false } as unknown as AndroidCtrlProxyClient;
    });
    const sync = spyOn(appearanceSyncScheduler, "syncAppearanceForDevice").mockResolvedValue(
      undefined,
    );
    const info = spyOn(logger, "info").mockImplementation(() => {});
    const daemon = new Daemon(
      {},
      new FakeInstalledAppsRepository(),
      new FakeTimer(),
      new FakeDeviceSessionRepository(),
      new CountingIdGenerator("device-session"),
      new FakeDatabaseInitializer(),
      new FakeStartupFailureTracker(),
    );
    const internals = daemon as unknown as DaemonStreamInternals;
    const stream = new FakeDeviceDataStreamServer();
    internals.getDeviceSessionRoutingTargets = () => targets(stream);
    internals.setupNavigationGraphStreamListener = () => {};
    try {
      await (internals.devicePool as unknown as DevicePool).initializeWithDevices([
        { deviceId: "android-owned", name: "Owned Pixel", platform: "android" },
        { deviceId: "android-unowned", name: "Other Pixel", platform: "android" },
      ]);
      await daemon.getSessionManager().createSession("session-owned", "android-owned", "android");
      internals.setupDeviceSessionRouting();
      internals.setupDeviceDataStreamCallback();
      stream.subscriberConnected?.(null);
      await Promise.resolve();

      expect(connected).toEqual(["android-owned"]);
      expect(info).toHaveBeenCalledWith(
        expect.stringContaining(
          "Skipping observation-stream connect for android device android-unowned: passive-work policy filtered it; set AUTOMOBILE_ANDROID_OBSERVATION_STREAM_DEVICES to opt in",
        ),
      );
      expect(info).not.toHaveBeenCalledWith("[Daemon] No devices in pool to connect");
    } finally {
      daemon.getSessionManager().stopCleanupTimer();
      client.mockRestore();
      sync.mockRestore();
      info.mockRestore();
      if (previousAllowlist === undefined) {
        delete process.env.AUTOMOBILE_ANDROID_OBSERVATION_STREAM_DEVICES;
      } else {
        process.env.AUTOMOBILE_ANDROID_OBSERVATION_STREAM_DEVICES = previousAllowlist;
      }
    }
  });

  test("an all-device stream reconnect after runner A restarts never starts idle runner B", async () => {
    const previousSecret = process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV];
    const previousAllowlist = process.env.AUTOMOBILE_IOS_WARMUP_DEVICES;
    const connectedDevices: string[] = [];
    const managers = new Map<string, FakeIOSCtrlProxyManager>();
    const fakeClient = {
      ensureConnected: async (deviceId: string) => {
        connectedDevices.push(deviceId);
        await managers.get(deviceId)?.setup(true);
        return false;
      },
    };
    const getInstance = spyOn(IOSCtrlProxyClient, "getInstance").mockImplementation(
      (device) =>
        ({
          ensureConnected: () => fakeClient.ensureConnected(device.deviceId),
        }) as unknown as IOSCtrlProxyClient,
    );
    const getExistingInstance = spyOn(IOSCtrlProxyClient, "getExistingInstance").mockImplementation(
      (deviceId) =>
        ({
          ensureConnected: () => fakeClient.ensureConnected(deviceId),
          refreshObservationStreamScreenshotCadence: () => {
            void fakeClient.ensureConnected(deviceId);
          },
        }) as unknown as IOSCtrlProxyClient,
    );
    const bootedDevices: BootedDevice[] = [
      { deviceId: "sim-a", name: "iPhone A", platform: "ios" },
      { deviceId: "sim-b", name: "iPhone Duo", platform: "ios" },
    ];

    try {
      for (const environment of [
        { secret: "acceptance-secret", allowlist: undefined },
        { secret: undefined, allowlist: "sim-a" },
      ]) {
        if (environment.secret === undefined) {
          delete process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV];
        } else {
          process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV] = environment.secret;
        }
        if (environment.allowlist === undefined) {
          delete process.env.AUTOMOBILE_IOS_WARMUP_DEVICES;
        } else {
          process.env.AUTOMOBILE_IOS_WARMUP_DEVICES = environment.allowlist;
        }

        const daemon = new Daemon(
          {},
          new FakeInstalledAppsRepository(),
          new FakeTimer(),
          new FakeDeviceSessionRepository(),
          new CountingIdGenerator("device-session"),
          new FakeDatabaseInitializer(),
          new FakeStartupFailureTracker(),
        );
        const internals = daemon as unknown as DaemonStreamInternals;
        const stream = new FakeDeviceDataStreamServer();
        const managerA = new FakeIOSCtrlProxyManager();
        const managerB = new FakeIOSCtrlProxyManager();
        managers.set("sim-a", managerA);
        managers.set("sim-b", managerB);
        internals.getDeviceSessionRoutingTargets = () => targets(stream);
        internals.setupNavigationGraphStreamListener = () => {};

        try {
          await (internals.devicePool as unknown as DevicePool).initializeWithDevices(
            bootedDevices,
          );
          await daemon.getSessionManager().createSession("session-a", "sim-a", "ios");
          internals.setupDeviceSessionRouting();
          internals.setupDeviceDataStreamCallback();

          // A reconnect after its runner restart replays the broad subscription.
          await managerA.forceRestart();
          stream.subscriberConnected?.(null);
          stream.subscriberConnected?.(null);
          stream.hierarchyCadenceChanged?.(null);
          stream.screenshotCadenceChanged?.(null);
          await Promise.resolve();

          expect(connectedDevices).toEqual(
            environment.secret === undefined ? ["sim-a", "sim-a", "sim-a"] : [],
          );
          expect(managerA.getCallCount("forceRestart")).toBe(1);
          expect(managerB.getCallCount("setup")).toBe(0);
          expect(getInstance).toHaveBeenCalledTimes(environment.secret === undefined ? 1 : 0);
          if (environment.secret === undefined) {
            expect(getExistingInstance).toHaveBeenCalledWith("sim-a");
          }
          expect(getExistingInstance).not.toHaveBeenCalledWith("sim-b");
        } finally {
          connectedDevices.length = 0;
          managers.clear();
          getInstance.mockClear();
          getExistingInstance.mockClear();
          daemon.getSessionManager().stopCleanupTimer();
          DaemonState.getInstance().reset();
        }
      }
    } finally {
      getInstance.mockRestore();
      getExistingInstance.mockRestore();
      if (previousSecret === undefined) {
        delete process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV];
      } else {
        process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV] = previousSecret;
      }
      if (previousAllowlist === undefined) {
        delete process.env.AUTOMOBILE_IOS_WARMUP_DEVICES;
      } else {
        process.env.AUTOMOBILE_IOS_WARMUP_DEVICES = previousAllowlist;
      }
    }
  });

  test("stream subscribe and cadence skip unowned devices on both platforms", async () => {
    const previousIos = process.env.AUTOMOBILE_IOS_WARMUP_DEVICES;
    const previousAndroid = process.env.AUTOMOBILE_ANDROID_OBSERVATION_STREAM_DEVICES;
    const previousSecret = process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV];
    delete process.env.AUTOMOBILE_IOS_WARMUP_DEVICES;
    delete process.env.AUTOMOBILE_ANDROID_OBSERVATION_STREAM_DEVICES;
    delete process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV];
    const androidClient = spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation(
      () => ({ ensureConnected: async () => false }) as unknown as AndroidCtrlProxyClient,
    );
    const iosClient = spyOn(IOSCtrlProxyClient, "getInstance").mockImplementation(
      () => ({ ensureConnected: async () => false }) as unknown as IOSCtrlProxyClient,
    );
    const androidExisting = spyOn(AndroidCtrlProxyClient, "getExistingInstance").mockReturnValue(
      null,
    );
    const iosExisting = spyOn(IOSCtrlProxyClient, "getExistingInstance").mockReturnValue(null);
    try {
      for (const allowlisted of [false, true]) {
        if (allowlisted) {
          process.env.AUTOMOBILE_IOS_WARMUP_DEVICES = "sim-foreign";
          process.env.AUTOMOBILE_ANDROID_OBSERVATION_STREAM_DEVICES = "android-foreign";
        }
        const daemon = new Daemon(
          {},
          new FakeInstalledAppsRepository(),
          new FakeTimer(),
          new FakeDeviceSessionRepository(),
          new CountingIdGenerator("device-session"),
          new FakeDatabaseInitializer(),
          new FakeStartupFailureTracker(),
        );
        const internals = daemon as unknown as DaemonStreamInternals;
        const stream = new FakeDeviceDataStreamServer();
        internals.getDeviceSessionRoutingTargets = () => targets(stream);
        internals.setupNavigationGraphStreamListener = () => {};
        try {
          await (internals.devicePool as unknown as DevicePool).initializeWithDevices([
            { deviceId: "sim-foreign", name: "Foreign iPhone", platform: "ios" },
            { deviceId: "android-foreign", name: "Foreign Pixel", platform: "android" },
          ]);
          internals.setupDeviceSessionRouting();
          internals.setupDeviceDataStreamCallback();
          stream.subscriberConnected?.(null);
          stream.screenshotCadenceChanged?.(null);
          stream.hierarchyCadenceChanged?.(null);
          await Promise.resolve();

          expect(androidClient).toHaveBeenCalledTimes(allowlisted ? 1 : 0);
          expect(iosClient).toHaveBeenCalledTimes(allowlisted ? 1 : 0);
          expect(androidExisting).toHaveBeenCalledTimes(allowlisted ? 2 : 0);
          expect(iosExisting).toHaveBeenCalledTimes(allowlisted ? 2 : 0);
        } finally {
          daemon.getSessionManager().stopCleanupTimer();
          androidClient.mockClear();
          iosClient.mockClear();
          androidExisting.mockClear();
          iosExisting.mockClear();
          DaemonState.getInstance().reset();
        }
      }
    } finally {
      androidClient.mockRestore();
      iosClient.mockRestore();
      androidExisting.mockRestore();
      iosExisting.mockRestore();
      if (previousIos === undefined) {
        delete process.env.AUTOMOBILE_IOS_WARMUP_DEVICES;
      } else {
        process.env.AUTOMOBILE_IOS_WARMUP_DEVICES = previousIos;
      }
      if (previousAndroid === undefined) {
        delete process.env.AUTOMOBILE_ANDROID_OBSERVATION_STREAM_DEVICES;
      } else {
        process.env.AUTOMOBILE_ANDROID_OBSERVATION_STREAM_DEVICES = previousAndroid;
      }
      if (previousSecret === undefined) {
        delete process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV];
      } else {
        process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV] = previousSecret;
      }
    }
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

  test("on-demand unscoped graph request resolves the sole session manager", async () => {
    const timer = new FakeTimer();
    const db = await createTestDatabase();
    const sessionId = "navigation-request-session";
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
      await sessionNavigation.setCurrentApp("com.example.session");
      await sessionNavigation.recordNavigationEvent({
        destination: "Home",
        source: "",
        arguments: {},
        metadata: {},
        timestamp: 1,
        sequenceNumber: 1,
      });
      internals.setupNavigationGraphStreamListener(stream);

      const summary = await stream.navigationRequestHandler?.();
      expect(summary?.appId).toBe("com.example.session");
      expect(summary?.nodes.length).toBeGreaterThan(0);
    } finally {
      daemon.getSessionManager().stopCleanupTimer();
      NavigationGraphManager.resetInstance();
      await db.destroy();
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
      internals.sessionManager.getSession = (sessionUuid) =>
        sessionUuid === "caller-session" ? {} : null;
      internals.sessionManager.getSessionForDevice = () => null;
      internals.sessionManager.getDeviceLabels = () => undefined;
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
            sessionUuid: "caller-session",
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
          sessionUuid: "caller-session",
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
          sessionUuid: "caller-session",
          packageName: "com.example",
          fileName: "prefs.xml",
          subscribe: false,
        });
      } finally {
        daemon.getSessionManager().stopCleanupTimer();
      }
    });

    // Watching stored values is a read (#10830): another session's device is watched too.
    test("an all-device subscribe also watches a device owned by another session", async () => {
      const { daemon, internals } = await daemonWithPool(
        [
          { id: "emulator-5554", platform: "android" },
          { id: "emulator-5556", platform: "android" },
        ],
        new Set(),
      );
      internals.sessionManager.getSessionForDevice = (deviceId) =>
        deviceId === "emulator-5556" ? "other-session" : "caller-session";
      const originalGetExistingInstance = AndroidCtrlProxyClient.getExistingInstance;
      const touched: string[] = [];
      AndroidCtrlProxyClient.getExistingInstance = ((deviceId: string) => ({
        subscribeStorage: async () => {
          touched.push(deviceId);
        },
      })) as typeof AndroidCtrlProxyClient.getExistingInstance;

      try {
        await internals.applyStorageSubscriptionRequest({
          deviceId: null,
          sessionUuid: "caller-session",
          packageName: "com.example",
          fileName: "prefs.xml",
          subscribe: true,
        });
        expect(touched).toEqual(["emulator-5554", "emulator-5556"]);
      } finally {
        AndroidCtrlProxyClient.getExistingInstance = originalGetExistingInstance;
        daemon.getSessionManager().stopCleanupTimer();
      }
    });

    test("reports a per-device observation failure for an unknown session", async () => {
      const { daemon, internals } = await daemonWithPool(
        [{ id: "emulator-5556", platform: "android" }],
        new Set(),
      );
      internals.sessionManager.getSessionForDevice = () => "other-session";
      const stream = new FakeDeviceDataStreamServer();
      internals.getDeviceSessionRoutingTargets = () => targets(stream);

      try {
        internals.setupDeviceSessionRouting();
        internals.setupDeviceDataStreamCallback();
        const observations = await stream.observationHandler!({
          deviceId: null,
          sessionUuid: "stranger-session",
          signal: new AbortController().signal,
        });
        expect(observations).toHaveLength(1);
        expect(observations[0]?.deviceId).toBe("emulator-5556");
        expect(observations[0]?.observation.error).toMatch(/not an active daemon session/);
      } finally {
        daemon.getSessionManager().stopCleanupTimer();
      }
    });

    // #10967: the session observe pipeline can rebind the accessibility service and set up
    // CtrlProxy; on a device another session holds, a viewer gets only the connect-only read.
    async function observeAs(options: {
      requester: string;
      holder: string | null;
      platform: "android" | "ios";
    }): Promise<{ paths: string[]; error: string | undefined }> {
      const { daemon, internals } = await daemonWithPool(
        [{ id: "device-1", platform: options.platform }],
        new Set(),
      );
      internals.sessionManager.getSession = (sessionUuid) =>
        sessionUuid === options.requester || sessionUuid === options.holder ? {} : null;
      internals.sessionManager.getSessionForDevice = () => options.holder;
      const stream = new FakeDeviceDataStreamServer();
      internals.getDeviceSessionRoutingTargets = () => targets(stream);
      const paths: string[] = [];
      const observation: ObserveResult = {
        observationId: "observed",
        updatedAt: 0,
        screenSize: { width: 1, height: 1 },
        systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      };
      const deviceRead = spyOn(RealObserveScreen.prototype, "executeDeviceRead").mockImplementation(
        async () => {
          paths.push("device-read");
          return observation;
        },
      );
      const sessionObserve = spyOn(RealObserveScreen.prototype, "execute").mockImplementation(
        async () => {
          paths.push("session-pipeline");
          return observation;
        },
      );
      try {
        internals.setupDeviceSessionRouting();
        internals.setupDeviceDataStreamCallback();
        // An all-device request: the pooled entry is listed rather than looked up by serial.
        const observations = await stream.observationHandler!({
          deviceId: null,
          sessionUuid: options.requester,
          signal: new AbortController().signal,
        });
        return { paths, error: observations[0]?.observation.error };
      } finally {
        deviceRead.mockRestore();
        sessionObserve.mockRestore();
        daemon.getSessionManager().stopCleanupTimer();
      }
    }

    for (const platform of ["android", "ios"] as const) {
      test(`a viewer's request_observation on a held ${platform} device takes the connect-only read`, async () => {
        const { paths, error } = await observeAs({
          requester: "viewer-session",
          holder: "owner-session",
          platform,
        });
        expect(error).toBeUndefined();
        expect(paths).toEqual(["device-read"]);
      });
    }

    test("the holder's own request_observation keeps the session observe pipeline", async () => {
      const { paths } = await observeAs({
        requester: "owner-session",
        holder: "owner-session",
        platform: "ios",
      });
      expect(paths).toEqual(["session-pipeline"]);
    });
  });
});

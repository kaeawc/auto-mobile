import { fakeServerContext } from "../helpers/fakeServerContext";
import { Server, type ServerContext } from "@modelcontextprotocol/server";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { z } from "zod/v4";
import {
  ToolRegistry,
  type AuditRunnerInput,
  type ToolRegistryCollaborators,
} from "../../src/server/toolRegistry";
import { registerAppTools } from "../../src/server/appTools";
import { registerDatabaseTools } from "../../src/server/databaseTools";
import { registerNetworkTools } from "../../src/server/networkTools";
import { registerPreferenceTools } from "../../src/server/preferenceTools";
import { registerSnapshotOfTools } from "../../src/server/snapshotOfTools";
import { registerStorageTools } from "../../src/server/storageTools";
import { registerUtilityTools } from "../../src/server/utilityTools";
import { registerAccessibilityTools } from "../../src/server/accessibilityTools";
import { registerDeepLinkTools } from "../../src/server/deepLinkTools";
import { registerInteractionTools } from "../../src/server/interactionTools";
import { registerNavigationTools } from "../../src/server/navigationTools";
import { registerNotificationTools } from "../../src/server/notificationTools";
import { registerObserveTools } from "../../src/server/observeTools";
import { registerPrototypeTools } from "../../src/server/prototypeTools";
import {
  DEVICE_OWNED_BY_OTHER_SESSION_CODE,
  InputDeviceOwnedError,
} from "../../src/daemon/inputDeviceOwnership";
import type { DeviceObservationAccess } from "../../src/server/deviceObservationAccess";
import { FakeDeviceReadiness } from "../fakes/FakeDeviceReadiness";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDeviceHealthMarkers } from "../fakes/FakeDeviceHealthMarkers";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import type { BootedDevice } from "../../src/models";
import { DaemonState } from "../../src/daemon/daemonState";
import { SessionManager, TerminalSessionError } from "../../src/daemon/sessionManager";
import { ManagedExecutionReowner } from "../../src/daemon/sessionBroker/provisioning/executionReowner";
import { BindingOwnershipUnconfirmedError } from "../../src/daemon/sessionBroker/provisioning/refusal";
import { DevicePool } from "../../src/daemon/devicePool";
import {
  isSessionlessDeviceRead,
  runWithToolSelectionContext,
} from "../../src/features/toolSelection/toolSelectionContext";
import { executionTracker, type ActiveExecution } from "../../src/daemon/executionTracker";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import {
  getDeviceToolsDependencies,
  resetDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { getDbWriteBarrier, resetDbWriteBarrier } from "../../src/db/dbWriteBarrier";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { FeatureFlagService } from "../../src/features/featureFlags/FeatureFlagService";
import { SessionReleaseBroadcaster } from "../../src/daemon/sessionReleaseBroadcast";
import { getDaemonStreamDeviceLifecycleEmitter } from "../../src/daemon/streamDeviceLifecycleEvents";
import { SessionToolBinding } from "../../src/server/SessionToolBinding";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";
import type { AppsQueryResourceContent } from "../../src/server/appResources";
import { serverConfig } from "../../src/utils/ServerConfig";
import { setDebugModeEnabled } from "../../src/utils/debug";
import { getAbortSignal } from "../../src/utils/AbortContext";
import { createAppToolsHarness } from "../helpers/appToolsHarness";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

const appTools = createAppToolsHarness();

/**
 * Read-only tools on a device another session holds (#10830). Watching is allowed on any device
 * (#10730), but a sessionless call used to ready its target through ensureDeviceReady (CtrlProxy
 * setup, the current-device pin, settings), so read tools were refused on a held device (#10828).
 * A sessionless read-only call that would land on a held device now runs through the read-only
 * device path: resolved from the booted list, with no readiness, no recording and no audit.
 */
type IngressHandler = (
  request: { method: string; params: { name: string; arguments: Record<string, unknown> } },
  ctx: ServerContext,
) => Promise<unknown>;

function isIngressHandler(value: unknown): value is IngressHandler {
  return typeof value === "function";
}

describe("ToolRegistry read-only device path on a held device (#10830)", () => {
  const held: BootedDevice = { name: "Pixel A", deviceId: "emulator-5554", platform: "android" };
  const free: BootedDevice = { name: "Pixel B", deviceId: "emulator-5556", platform: "android" };
  const agent = "agent-session";
  // Probe registration shares one immutable schema instead of compiling equivalent parsers.
  const probeSchema = z.object({}).passthrough();

  let audited: Array<{ name: string; deviceId: string }>;
  let recorded: string[];
  let reads: Array<{ deviceId: string; readPath: boolean; sessionUuid: unknown }>;
  let listed: number;
  let authorized: boolean;
  /** Whether the fake audit runner also runs the audited tool's handler. */
  let runAuditedHandlers: boolean;
  let originalCollaborators: ToolRegistryCollaborators;
  let restorePipeline: () => void;
  let sessionManager: SessionManager;
  let devices: FakeDeviceReadiness;
  let timer: FakeTimer;
  let markers: FakeDeviceHealthMarkers;
  let pool: DevicePool;
  let persistence: FakeDeviceSessionPersistence;
  let reowner: ManagedExecutionReowner | undefined;

  const call = (name: string, args: Record<string, unknown>) =>
    ToolRegistry.getTool(name)!.handler(args);

  async function outcome(name: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      return await call(name, args);
    } catch (error) {
      return error;
    }
  }

  function expectNoReadiness(): void {
    expect(devices.getEnsureDeviceReadyCalls()).toBe(0);
    expect(devices.getExplicitDevicePin()).toBeUndefined();
  }

  async function setUpDevicePath(): Promise<void> {
    reowner = undefined;
    audited = [];
    recorded = [];
    reads = [];
    listed = 0;
    authorized = true;
    runAuditedHandlers = false;
    ToolRegistry.clearTools();
    const deviceReadAccess: DeviceObservationAccess = {
      listBooted: async () => {
        listed++;
        return [held, free];
      },
      isAuthorized: () => authorized,
    };
    restorePipeline = ToolRegistry.setPipelineOverridesForTesting({
      displayInventory: new FakeDisplayInventoryProvider(),
      deviceReadAccess,
      auditRunner: {
        async run(input: AuditRunnerInput) {
          audited.push({ name: input.name, deviceId: input.device.deviceId });
          return runAuditedHandlers ? input.handler(input.device, input.args) : { success: true };
        },
      },
      afterToolCall: {
        async handle(input) {
          return { durationMs: 0, finalizedResponse: input.response };
        },
      },
    });
    devices = new FakeDeviceReadiness();
    devices.setConnectedDevices([held, free]);
    originalCollaborators = ToolRegistry.getCollaboratorsForTesting();
    ToolRegistry.setCollaboratorsForTesting({ deviceReadiness: devices });
    ToolRegistry.setCollaboratorsForTesting({
      toolCallRepository: { async recordToolCall(): Promise<void> {} },
    });
    ToolRegistry.setCollaboratorsForTesting({
      navigationToolCallRecorder: {
        record: (name: string) => {
          recorded.push(name);
          return undefined;
        },
      },
    });

    timer = new FakeTimer();
    persistence = new FakeDeviceSessionPersistence();
    sessionManager = new SessionManager(timer, persistence);
    sessionManager.stopCleanupTimer();
    const fakeDeviceUtils = new FakeDeviceUtils();
    fakeDeviceUtils.setBootedDevices("android", [held, free]);
    markers = new FakeDeviceHealthMarkers(timer);
    pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "read-only-device-path", {
        timer,
        deviceManager: fakeDeviceUtils,
        deviceHealthMarkers: markers,
        managedExecutionOwnership: () => reowner,
      }),
    );
    await pool.initializeWithDevices([held, free]);
    DaemonState.getInstance().initialize(sessionManager, pool);
    await sessionManager.createSession(agent, held.deviceId, "android");
    sessionManager.setDeviceReadiness(agent, "automationReady");

    // A read-only probe whose handler records how it was reached.
    ToolRegistry.registerDeviceAware(
      "readProbe",
      "Read-only probe",
      probeSchema,
      async (device: BootedDevice, args: Record<string, unknown>) => {
        reads.push({
          deviceId: device.deviceId,
          readPath: isSessionlessDeviceRead(),
          sessionUuid: args.sessionUuid,
        });
        return { content: [{ type: "text", text: JSON.stringify({ success: true }) }] };
      },
      { deviceReadOnly: true },
    );
  }
  // Builds the DevicePool harness inside each test, so its cost is paid honestly in the test body.
  function arranged(name: string, fn: () => void | Promise<void>, timeout?: number): void {
    test(
      name,
      async () => {
        await setUpDevicePath();
        await fn();
      },
      timeout,
    );
  }

  function arrangedEach<T>(table: readonly T[]) {
    return (name: string, fn: (row: T) => void | Promise<void>, timeout?: number): void => {
      test.each([...table])(
        name,
        async (row: T) => {
          await setUpDevicePath();
          await fn(row);
        },
        timeout,
      );
    };
  }

  function tearDownDevicePath(): void {
    reowner?.close();
    expect(executionTracker.getActiveExecutionCount()).toBe(0);
    serverConfig.setEmbeddedSdkEnabled(false);
    restorePipeline();
    ToolRegistry.setCollaboratorsForTesting(originalCollaborators);
    ToolRegistry.clearTools();
    DaemonState.getInstance().reset();
    sessionManager.stopCleanupTimer();
  }
  afterEach(tearDownDevicePath);

  arranged(
    "a sessionless read with a held deviceId runs on the read-only path with no readiness",
    async () => {
      await call("readProbe", { platform: "android", deviceId: held.deviceId });

      expect(reads).toEqual([{ deviceId: held.deviceId, readPath: true, sessionUuid: undefined }]);
      expect(listed).toBe(1);
      expectNoReadiness();
      expect(audited).toEqual([]);
      expect(recorded).toEqual([]);
      expect(sessionManager.getSessionForDevice(held.deviceId)).toBe(agent);
    },
  );

  arranged(
    "a sessionless read with no deviceId that would land on a held device watches it",
    async () => {
      devices.setConnectedDevices([held]);
      await call("readProbe", { platform: "android" });

      expect(reads).toEqual([{ deviceId: held.deviceId, readPath: true, sessionUuid: undefined }]);
      expectNoReadiness();
    },
  );

  arranged("the holder's own read keeps its session path", async () => {
    await call("readProbe", { sessionUuid: agent, deviceId: held.deviceId });

    expect(listed).toBe(0);
    expect(audited).toEqual([{ name: "readProbe", deviceId: held.deviceId }]);
    expect(recorded).toEqual(["readProbe"]);
  });

  arranged(
    "a sessionless read on an unheld device runs required readiness without pinning (readiness needed to answer the read, #11964)",
    async () => {
      await call("readProbe", { platform: "android", deviceId: free.deviceId });

      expect(listed).toBe(0);
      expect(devices.getEnsureDeviceReadyCalls()).toBe(1);
      expect(devices.getLastOptions()?.intent).toBe("read");
      expect(devices.getExplicitDevicePin()).toBeUndefined();
      expect(audited).toEqual([{ name: "readProbe", deviceId: free.deviceId }]);
    },
  );

  arranged(
    "#12112 a sessionless read on an unhealthy free device preserves its marker and read readiness",
    async () => {
      markers.mark(free.deviceId, pool.getDeviceIncarnation(free.deviceId)!, "app-cleanup");
      await expect(
        call("readProbe", { platform: "android", deviceId: free.deviceId }),
      ).resolves.toMatchObject({ success: true });
      expect(sessionManager.getSessionForDevice(free.deviceId)).toBeNull();
      expect(pool.getDeviceHealthMarker(free.deviceId)?.reason).toBe("app-cleanup");
      // #12112: current behaviour, see issue
      expect(devices.getEnsureDeviceReadyCalls()).toBe(1);
      expect(devices.getLastOptions()?.intent).toBe("read");
      expect(devices.getExplicitDevicePin()).toBeUndefined();
    },
  );

  arranged(
    "a sessionless control call on a free device uses control readiness and pins",
    async () => {
      ToolRegistry.registerDeviceAware("controlProbe", "Control probe", probeSchema, async () => ({
        success: true,
      }));
      await call("controlProbe", { platform: "android", deviceId: free.deviceId });
      expect(devices.getEnsureDeviceReadyCalls()).toBe(1);
      expect(devices.getLastOptions()?.intent).toBeUndefined();
      expect(devices.getExplicitDevicePin()).toBeUndefined();
    },
  );

  // #10968: the IDE injects its observer session UUID into every call. That UUID is not a device
  // session this daemon issued, so a read carrying it is sessionless rather than refused.
  arranged(
    "a read naming an unissued (observer) session watches a held device sessionlessly",
    async () => {
      await call("readProbe", { sessionUuid: "observer-session", deviceId: held.deviceId });

      expect(reads).toEqual([{ deviceId: held.deviceId, readPath: true, sessionUuid: undefined }]);
      expectNoReadiness();
      expect(sessionManager.getSession("observer-session")).toBeNull();
    },
  );

  arranged(
    "a read naming an unissued (observer) session runs on a free device without a session",
    async () => {
      await call("readProbe", { sessionUuid: "observer-session", deviceId: free.deviceId });

      expect(devices.getEnsureDeviceReadyCalls()).toBe(1);
      expect(devices.getLastOptions()?.intent).toBe("read");
      expect(devices.getExplicitDevicePin()).toBeUndefined();
      expect(audited).toEqual([{ name: "readProbe", deviceId: free.deviceId }]);
      expect(sessionManager.getSession("observer-session")).toBeNull();
      expect(sessionManager.getSessionForDevice(free.deviceId)).toBeNull();
    },
  );

  arranged(
    "an observer-session read of a tool with its own device read uses it on a free device",
    async () => {
      const resolved: string[] = [];
      ToolRegistry.registerDeviceAware(
        "observeProbe",
        "Observe-like probe",
        probeSchema,
        async (device: BootedDevice, args: Record<string, unknown>) => {
          reads.push({
            deviceId: device.deviceId,
            readPath: isSessionlessDeviceRead(),
            sessionUuid: args.sessionUuid,
          });
          return { success: true };
        },
        {
          deviceReadOnly: true,
          sessionlessDeviceRead: {
            resolve: async (deviceId: string) => {
              resolved.push(deviceId);
              return free;
            },
            assertAuthorized: () => {},
          },
        },
      );

      await call("observeProbe", { sessionUuid: "observer-session", deviceId: free.deviceId });

      expect(resolved).toEqual([free.deviceId]);
      expect(reads).toEqual([{ deviceId: free.deviceId, readPath: true, sessionUuid: undefined }]);
      expectNoReadiness();
    },
  );

  arranged("a control call naming an unissued session is still refused as unissued", async () => {
    ToolRegistry.registerDeviceAware("controlProbe", "Control probe", probeSchema, async () => ({
      success: true,
    }));
    const error = await outcome("controlProbe", {
      sessionUuid: "observer-session",
      deviceId: free.deviceId,
    });

    expect((error as Error).message).toContain("observer-session");
    expect(audited).toEqual([]);
  });

  arrangedEach([
    { state: "unconfirmed", article: "an" },
    { state: "lost", article: "a" },
  ] as const)(
    "$article $state managed session read watches without admission, readiness or use",
    async ({ state }) => {
      const recovered = Promise.withResolvers<void>();
      reowner = new ManagedExecutionReowner({
        registry: async () => ({
          findExecutionAssignments: async () => [],
          claimExecution: async () => {
            throw new Error("must not claim");
          },
        }),
        owner: () => ({ daemonId: "test", pid: 1 }),
        timer,
      });
      if (state === "unconfirmed") {
        reowner.noteRecovering(agent, recovered.promise);
      } else {
        await reowner.reown([agent], { rehydrated: true });
      }
      const admission = spyOn(sessionManager, "admitIssuedSessionForAutomation");
      const mark = spyOn(executionTracker, "markSessionAdmitted");
      try {
        await call("readProbe", { sessionUuid: agent });
        expect(reads).toEqual([
          { deviceId: held.deviceId, readPath: true, sessionUuid: undefined },
        ]);
        expectNoReadiness();
        expect(admission).not.toHaveBeenCalled();
        expect(mark).not.toHaveBeenCalled();
      } finally {
        admission.mockRestore();
        mark.mockRestore();
        recovered.resolve();
      }
    },
  );

  arranged(
    "gated control keeps its unconfirmed refusal and a foreign read keeps its explicit target",
    async () => {
      const recovered = Promise.withResolvers<void>();
      reowner = new ManagedExecutionReowner({
        registry: async () => {
          throw new Error("must not open");
        },
        owner: () => ({ daemonId: "test", pid: 1 }),
        timer,
      });
      reowner.noteRecovering(agent, recovered.promise);
      ToolRegistry.registerDeviceAware("controlProbe", "Control probe", probeSchema, async () => ({
        success: true,
      }));
      expect(await outcome("controlProbe", { sessionUuid: agent })).toBeInstanceOf(
        BindingOwnershipUnconfirmedError,
      );
      await call("readProbe", { sessionUuid: agent, deviceId: free.deviceId });
      expect(reads).toEqual([{ deviceId: free.deviceId, readPath: true, sessionUuid: undefined }]);
      expectNoReadiness();
      reowner.close();
      recovered.resolve();
    },
  );

  describe("a session whose row expired while the daemon was down (#11361)", () => {
    const expired = "expired-while-down";

    /** A row a previous daemon left behind, now past its deadline. */
    async function seedExpiredRow(): Promise<void> {
      await persistence.upsertActiveSession({
        sessionUuid: expired,
        deviceId: free.deviceId,
        stableDeviceId: free.name,
        platform: "android",
        daemonSessionId: "dead-daemon",
        createdAtMs: timer.now(),
        lastUsedAtMs: timer.now(),
        expiresAtMs: timer.now() + 1_000,
        sessionTimeoutMs: 1_000,
        heartbeatTimeoutMs: 1_000,
        hasReceivedHeartbeat: true,
      });
      timer.advanceTime(1_001);
    }

    arranged(
      "a read naming it is not refused: it runs sessionless, as a read of an unissued id does",
      async () => {
        await seedExpiredRow();
        await call("readProbe", { sessionUuid: expired, deviceId: held.deviceId });

        expect(reads).toEqual([
          { deviceId: held.deviceId, readPath: true, sessionUuid: undefined },
        ]);
        expectNoReadiness();
        expect(sessionManager.getSession(expired)).toBeNull();
      },
    );

    arranged(
      "a control call naming it gets the typed terminal refusal with reason expired",
      async () => {
        await seedExpiredRow();
        ToolRegistry.registerDeviceAware(
          "controlProbe",
          "Control probe",
          probeSchema,
          async () => ({
            success: true,
          }),
        );
        const error = await outcome("controlProbe", { sessionUuid: expired });

        expect(error).toBeInstanceOf(TerminalSessionError);
        expect((error as TerminalSessionError).release).toMatchObject({
          sessionId: expired,
          releaseReason: "expired",
          terminal: true,
        });
        expect(audited).toEqual([]);
        expect(sessionManager.getSessionForDevice(free.deviceId)).toBeNull();
      },
    );
  });

  // #11361: a read that names a session past its idle deadline, still held by earlier work, is
  // not admitted under the session. It must still read the device of the session it named.
  describe("a late read while earlier work holds the named session (#11361)", () => {
    const other = "other-session";

    async function arrangeNested(): Promise<void> {
      await sessionManager.createSession(other, free.deviceId, "android");
      sessionManager.setDeviceReadiness(other, "automationReady");
      // Sessionless selection would settle on the other session's device.
      devices.setExplicitDevicePin(free);
      const earlierStart = sessionManager.sessionNow();
      sessionManager.setActiveSessionExecutionChecker(
        (sessionId, query) =>
          sessionId === agent &&
          !query?.recoveryOnly &&
          query?.excludeExecutionId !== "earlier" &&
          (query?.sessionClockStartedAtOrBefore === undefined ||
            earlierStart <= query.sessionClockStartedAtOrBefore),
      );
      const deadline = sessionManager
        .getAllSessions()
        .find((session) => session.sessionId === agent)!.expiresAt;
      timer.setCurrentTime(deadline + 1);
    }

    function arrangedNested(name: string, fn: () => void | Promise<void>, timeout?: number): void {
      arranged(
        name,
        async () => {
          await arrangeNested();
          await fn();
        },
        timeout,
      );
    }

    arrangedNested(
      "the read returns the named session's device, sessionless and without readiness",
      async () => {
        const readinessBefore = devices.getEnsureDeviceReadyCalls();
        const deadline = sessionManager.getSession(agent)!.expiresAt;

        // The read begins after the deadline, as MCP ingress stamps it.
        await runWithToolSelectionContext(
          { execution: { executionId: "late-read", startTime: timer.now() } },
          () => call("readProbe", { sessionUuid: agent }),
        );

        expect(reads).toEqual([
          { deviceId: held.deviceId, readPath: true, sessionUuid: undefined },
        ]);
        expect(devices.getEnsureDeviceReadyCalls()).toBe(readinessBefore);
        expect(audited).toEqual([]);
        // Nothing was bound, released or credited: the session still holds its device and deadline.
        expect(sessionManager.getSessionForDevice(held.deviceId)).toBe(agent);
        expect(sessionManager.getSession(agent)!.expiresAt).toBe(deadline);
      },
    );

    arrangedNested(
      "another session's control gets the same typed ownership refusal before and after the holder's deadline",
      async () => {
        ToolRegistry.registerDeviceAware(
          "controlProbe",
          "Control probe",
          probeSchema,
          async () => ({
            success: true,
          }),
        );
        const deadline = sessionManager.getSession(agent)!.expiresAt;
        const args = { sessionUuid: other, deviceId: held.deviceId };
        const pinsBefore = devices.getExplicitDevicePin();
        const after = await outcome("controlProbe", args);
        timer.setCurrentTime(deadline - 1);
        const before = await outcome("controlProbe", args);
        for (const error of [before, after]) {
          expect(error).toBeInstanceOf(InputDeviceOwnedError);
          expect((error as InputDeviceOwnedError).code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
        }
        expect((after as InputDeviceOwnedError).message).toBe(
          (before as InputDeviceOwnedError).message,
        );
        expect(sessionManager.getSessionForDevice(held.deviceId)).toBe(agent);
        expect(audited).toEqual([]);
        expect(devices.getEnsureDeviceReadyCalls()).toBe(0);
        expect(devices.getExplicitDevicePin()).toEqual(pinsBefore);
      },
    );
  });

  describe("late reads never bind through MCP ingress (#12113)", () => {
    const connection = "late-read-connection";
    let fixture: McpTestFixture;
    let binding: SessionToolBinding;
    let restoreServer: () => void;
    let bindingLookup: ReturnType<typeof spyOn>;
    let release: ReturnType<typeof spyOn>;
    let executions: ActiveExecution[];
    let session: NonNullable<ReturnType<SessionManager["peekSession"]>>;
    let cancellations: string[];
    let recovering: boolean;
    let ingressHandler: IngressHandler;
    let finishControl: (() => void) | undefined;
    let pendingControl: Promise<unknown> | undefined;
    let previousFeatureFlags: FeatureFlagService | null;
    let previousFlagNotifier: Parameters<FeatureFlagService["setToolListChangedNotifier"]>[0];
    let previousResources: ReturnType<typeof ResourceRegistry.getAllResources>;
    let previousRegistry: ReturnType<typeof ResourceRegistry.snapshotForTesting>;
    let previousToolServers: ReturnType<typeof ToolRegistry.trackedServerCountsForTesting>;
    let previousResourceServers: ReturnType<typeof ResourceRegistry.trackedServerCountsForTesting>;
    let previousBindingHandlers: number;
    let previousReleaseListeners: ReturnType<typeof SessionReleaseBroadcaster.listenersForTesting>;
    let previousDeviceRemovalListeners: Array<(deviceId: string) => void>;

    beforeAll(async () => {
      previousFeatureFlags = FeatureFlagService.peekInstanceForTesting();
      if (previousFeatureFlags) {
        previousFlagNotifier = previousFeatureFlags.toolListChangedNotifierForTesting();
      }
      previousResources = ResourceRegistry.getAllResources();
      previousRegistry = ResourceRegistry.snapshotForTesting();
      previousToolServers = ToolRegistry.trackedServerCountsForTesting();
      previousResourceServers = ResourceRegistry.trackedServerCountsForTesting();
      previousBindingHandlers = ToolRegistry.sessionBindingReleaseHandlerCountForTesting();
      previousReleaseListeners = SessionReleaseBroadcaster.listenersForTesting();
      previousDeviceRemovalListeners =
        getDaemonStreamDeviceLifecycleEmitter().removedListenersForTesting();
      // Warm the real server/SDK setup outside the individual test budgets.
      restoreServer = installHermeticServerFixture();
      const warm = new McpTestFixture({ daemonMode: true });
      await setUpDevicePath();
      try {
        runAuditedHandlers = true;
        ToolRegistry.registerDeviceAware(
          "ingressWarmup",
          "Ingress warmup",
          probeSchema,
          async () => ({ success: true }),
        );
        await warm.setup();
        await warm.client.callTool({ name: "ingressWarmup", arguments: { sessionUuid: agent } });
      } finally {
        await warm.teardown();
        tearDownDevicePath();
      }
    });

    afterAll(() => {
      restoreServer();
      // The fixture restores a manager it lazily created; retire both factory slots instead.
      PlatformDeviceManagerFactory.reset();
      const deviceToolsDependencies = getDeviceToolsDependencies();
      resetDeviceToolsDependencies();
      resetDbWriteBarrier();
      // Match the neighbouring suite's identity restore; this tracker has no reset API.
      // No getter on the tracker: restore its constructor default (an identity clock).
      executionTracker.setSessionClockOffsetProvider(() => 0);
      DaemonState.getInstance().reset();
      // Obtain the current shared prototype host's public disposer, then retire its lifecycle.
      registerPrototypeTools()();
      SessionReleaseBroadcaster.clearForTesting();
      for (const listener of previousReleaseListeners) {
        SessionReleaseBroadcaster.subscribe(listener);
      }
      // The stream emitter has no reset API; restore its existing listener set in place.
      getDaemonStreamDeviceLifecycleEmitter().clearRemovedListenersForTesting();
      for (const listener of previousDeviceRemovalListeners) {
        getDaemonStreamDeviceLifecycleEmitter().onDeviceRemoved(listener);
      }
      ToolRegistry.clearTools();
      ResourceRegistry.clearResources();
      ResourceRegistry.restoreForTesting(previousRegistry);
      if (previousFeatureFlags) {
        previousFeatureFlags.setToolListChangedNotifier(previousFlagNotifier);
        expect(previousFeatureFlags.toolListChangedNotifierForTesting()).toBe(previousFlagNotifier);
      }
      // FeatureFlagService has no singleton reset API; restore its pre-ingress identity.
      FeatureFlagService.setInstanceForTesting(previousFeatureFlags);
      expect(FeatureFlagService.peekInstanceForTesting()).toBe(previousFeatureFlags);
      expect(PlatformDeviceManagerFactory.slotsForTesting()).toEqual({
        instance: null,
        injectedManager: null,
        injectedAdbFactory: null,
      });
      expect(executionTracker.getActiveExecutionCount()).toBe(0);
      expect(DaemonState.getInstance().isInitialized()).toBe(false);
      expect(ToolRegistry.getAllTools()).toHaveLength(0);
      expect(getDbWriteBarrier().inFlightCount()).toBe(0);
      expect(getDbWriteBarrier().isDraining()).toBe(false);
      expect(getDeviceToolsDependencies()).not.toBe(deviceToolsDependencies);
      expect(ResourceRegistry.getAllResources()).toEqual(previousResources);
      expect(ResourceRegistry.snapshotForTesting()).toEqual(previousRegistry);
      // Closing the fixtures must unsubscribe their servers and binding closures, not mask leaks.
      expect(ToolRegistry.trackedServerCountsForTesting()).toEqual(previousToolServers);
      expect(ResourceRegistry.trackedServerCountsForTesting()).toEqual(previousResourceServers);
      expect(ToolRegistry.sessionBindingReleaseHandlerCountForTesting()).toBe(
        previousBindingHandlers,
      );
      expect(SessionReleaseBroadcaster.listenersForTesting()).toEqual(previousReleaseListeners);
      expect(getDaemonStreamDeviceLifecycleEmitter().removedListenersForTesting()).toEqual(
        previousDeviceRemovalListeners,
      );
    });

    async function arrangeNested2(): Promise<void> {
      // The pin is per connection (#14161); this suite's calls run under `connection` (#14385).
      devices.setExplicitDevicePin(held, connection);
      executions = [];
      finishControl = undefined;
      pendingControl = undefined;
      runAuditedHandlers = true;
      session = sessionManager.peekSession(agent)!;
      cancellations = [];
      recovering = false;
      executionTracker.setSessionClockOffsetProvider(
        (wallNowMs = Date.now()) => sessionManager.sessionNow() - wallNowMs,
      );
      sessionManager.setActiveSessionExecutionChecker((sessionId, query) => {
        if (query?.recoveryOnly) {
          return recovering;
        }
        return (
          (recovering && query?.sessionClockStartedAtOrBefore === undefined) ||
          executionTracker.hasActiveSessionUuidExecutions(sessionId, query)
        );
      });
      sessionManager.setSessionExecutionDeadlineLookup((sessionId, query) =>
        executionTracker.getLatestSessionExecutionDeadlineMs(sessionId, {
          ...query,
          onSessionClock: true,
        }),
      );
      sessionManager.setExpiryReleaseExecutionCanceller((sessionId, cancellation, query) => {
        cancellations.push(sessionId);
        void executionTracker.cancelDeviceSessionExecutions(sessionId, cancellation, {
          excludeExecutionId: query.excludeExecutionId,
        });
      });
      const original = SessionToolBinding.prototype.effectiveSessionUuid;
      bindingLookup = spyOn(
        SessionToolBinding.prototype,
        "effectiveSessionUuid",
      ).mockImplementation(function (this: SessionToolBinding, ...args) {
        binding = this;
        return original.apply(this, args);
      });
      release = spyOn(sessionManager, "releaseSession");
      fixture = new McpTestFixture({ daemonMode: true, sessionContext: { sessionId: connection } });
      const registration = spyOn(Server.prototype, "setRequestHandler");
      try {
        await fixture.setup();
        // The spy types the last (3-arg schema) overload; the 2-arg form registers the handler itself.
        const registered = registration.mock.calls.findLast(
          ([schema]) => schema === "tools/call",
        )![1];
        if (!isIngressHandler(registered)) {
          throw new Error("tools/call handler was not registered");
        }
        ingressHandler = registered;
      } finally {
        registration.mockRestore();
      }
    }

    function arrangedNested2(name: string, fn: () => void | Promise<void>, timeout?: number): void {
      arranged(
        name,
        async () => {
          await arrangeNested2();
          await fn();
        },
        timeout,
      );
    }

    function arrangedNested2Each<T>(table: readonly T[]) {
      return (name: string, fn: (row: T) => void | Promise<void>, timeout?: number): void => {
        arrangedEach(table)(
          name,
          async (row: T) => {
            await arrangeNested2();
            await fn(row);
          },
          timeout,
        );
      };
    }

    afterEach(async () => {
      finishControl?.();
      await pendingControl;
      for (const execution of executions) {
        executionTracker.endExecution(execution.id);
      }
      await sessionManager.waitForSessionRelease(agent);
      await fixture.teardown();
      binding?.unbindSession(agent);
      expect(binding?.boundDeviceSessionUuid(connection)).toBeUndefined();
      bindingLookup.mockRestore();
      release.mockRestore();
      // No getter on the tracker: restore its constructor default (an identity clock).
      executionTracker.setSessionClockOffsetProvider(() => 0);
      expect(executionTracker.getActiveExecutionCount()).toBe(0);
      timer.reset();
    });

    const stamps = () => ({ lastUsedAt: session.lastUsedAt, expiresAt: session.expiresAt });
    const goLate = () => timer.setCurrentTime(stamps().expiresAt + 1);
    function hold(deadline?: number): ActiveExecution {
      const execution = executionTracker.startExecution("controlProbe", undefined, agent);
      const wallDeadline =
        deadline === undefined
          ? undefined
          : execution.startTime + deadline - sessionManager.sessionNow();
      executionTracker.setExecutionDeadline(execution.id, () => wallDeadline);
      executions.push(execution);
      return execution;
    }
    async function readWithoutBinding(): Promise<void> {
      const before = stamps();
      const result = await fixture.client.callTool({
        name: "readProbe",
        arguments: { sessionUuid: agent },
      });
      expect(result.isError ?? false, JSON.stringify(result)).toBe(false);
      expect(result.content).toEqual([
        { type: "text", text: expect.stringContaining('"success":true') },
      ]);
      expect(binding.boundDeviceSessionUuid(connection)).toBeUndefined();
      // Retain the object across teardown: neither read admission nor binding may credit it.
      expect(stamps()).toEqual(before);
    }
    function expectNoRelease(): void {
      expect(release).not.toHaveBeenCalled();
      expect(cancellations).toEqual([]);
      expect(sessionManager.hasSession(agent)).toBe(true);
      expect(sessionManager.getReleasingSession(agent)).toBeNull();
    }

    function controlThroughIngress(signal: AbortSignal) {
      return ingressHandler(
        {
          method: "tools/call",
          params: { name: "controlProbe", arguments: { sessionUuid: agent } },
        },
        fakeServerContext({ signal: signal, id: "control-request" }),
      );
    }

    function startWedgedControl(signal: AbortSignal): Promise<AbortSignal | undefined> {
      const entered = Promise.withResolvers<AbortSignal | undefined>();
      const gate = Promise.withResolvers<void>();
      finishControl = gate.resolve;
      ToolRegistry.registerDeviceAware("controlProbe", "Control probe", probeSchema, async () => {
        entered.resolve(getAbortSignal());
        // Deliberately ignore cancellation: the body remains tracked until the gate opens.
        await gate.promise;
        return { success: true };
      });
      pendingControl = controlThroughIngress(signal);
      return entered.promise;
    }

    arrangedNested2Each(["cancelled", "live"] as const)(
      "a %s timely MCP control admits late control only while live",
      async (state) => {
        const cancelled = state === "cancelled";
        const client = new AbortController();
        const requestSignal = await startWedgedControl(client.signal);
        if (cancelled) {
          client.abort();
        }
        expect(requestSignal?.aborted).toBe(cancelled);
        expect(executionTracker.hasActiveSessionUuidExecutions(agent, { excludeReads: true })).toBe(
          true,
        );
        ToolRegistry.registerDeviceAware(
          "lateControlProbe",
          "Late control probe",
          probeSchema,
          async () => ({ success: true }),
        );
        goLate();
        const result = await fixture.client.callTool({
          name: "lateControlProbe",
          arguments: { sessionUuid: agent },
        });
        expect(result.isError ?? false).toBe(cancelled);
        if (cancelled) {
          expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toMatchObject({
            error: { code: "session_ownership_lost", reason: "cleanup-expired", idle: true },
          });
          await sessionManager.waitForSessionRelease(agent);
          expect(sessionManager.hasSession(agent)).toBe(false);
          expect(sessionManager.getTerminalReleaseSnapshot(agent)?.releaseReason).toBe(
            "cleanup-expired",
          );
        } else {
          expectNoRelease();
          expect(binding.boundDeviceSessionUuid(connection)).toBe(agent);
        }
      },
    );

    arrangedNested2(
      "ended MCP control removes its client abort listener before a later execution",
      async () => {
        const client = new AbortController();
        const listeners = new Set<EventListenerOrEventListenerObject>();
        const add = client.signal.addEventListener.bind(client.signal);
        const remove = client.signal.removeEventListener.bind(client.signal);
        client.signal.addEventListener = (
          type: string,
          listener: EventListenerOrEventListenerObject,
          options?: boolean | AddEventListenerOptions,
        ) => {
          if (type === "abort" && listener) {
            expect(options).toEqual({ once: true });
            listeners.add(listener);
          }
          add(type, listener, options);
        };
        client.signal.removeEventListener = (
          type: string,
          listener: EventListenerOrEventListenerObject,
          options?: boolean | EventListenerOptions,
        ) => {
          if (type === "abort" && listener) {
            expect(listeners.delete(listener)).toBe(true);
          }
          remove(type, listener, options);
        };
        await startWedgedControl(client.signal);
        expect(listeners.size).toBe(1);
        finishControl!();
        await pendingControl;
        expect(listeners.size).toBe(0);
        const later = hold(stamps().expiresAt + 60_000);
        expect(() => client.abort()).not.toThrow();
        expect(later.requestCancelled).toBeUndefined();
        expect(later.abortController.signal.aborted).toBe(false);
      },
    );

    arrangedNested2(
      "with nothing in flight a late read succeeds without binding and starts lazy idle release",
      async () => {
        goLate();
        const before = stamps();
        await readWithoutBinding();
        expect(reads).toEqual([
          { deviceId: held.deviceId, readPath: true, sessionUuid: undefined },
        ]);
        expect(devices.getEnsureDeviceReadyCalls()).toBe(0);
        expect({ lastUsedAt: session.lastUsedAt, expiresAt: session.expiresAt }).toEqual(before);
        expect(release).toHaveBeenCalledTimes(1);
        await sessionManager.cleanupExpiredSessions();
        await sessionManager.waitForSessionRelease(agent);
        expect(sessionManager.hasSession(agent)).toBe(false);
        expect(sessionManager.getTerminalReleaseSnapshot(agent)?.releaseReason).toBe(
          "cleanup-expired",
        );
        expect(cancellations).toEqual([]);
      },
    );

    arrangedNested2(
      "live timely control holds: late read succeeds without binding, release or cancellation",
      async () => {
        const control = hold(stamps().expiresAt + 60_000);
        goLate();
        await readWithoutBinding();
        expectNoRelease();
        expect(control.abortController.signal.aborted).toBe(false);
      },
    );

    arrangedNested2(
      "recovery holds: late read succeeds without a retryable recovery failure or binding",
      async () => {
        recovering = true;
        goLate();
        await readWithoutBinding();
        expectNoRelease();
      },
    );

    for (const kind of ["late", "non-live"] as const) {
      arrangedNested2(
        `${kind} control holds: late read succeeds without binding or cutting the call`,
        async () => {
          const expiry = stamps().expiresAt;
          let control: ActiveExecution;
          if (kind === "non-live") {
            control = hold(expiry);
            goLate();
          } else {
            goLate();
            control = hold(expiry + 60_000);
          }
          await readWithoutBinding();
          expectNoRelease();
          expect(control.abortController.signal.aborted).toBe(false);
        },
      );
    }

    arrangedNested2(
      "a read inside the idle window still binds without moving either stamp",
      async () => {
        const before = stamps();
        timer.advanceTime(1_000);
        const result = await fixture.client.callTool({
          name: "readProbe",
          arguments: { sessionUuid: agent },
        });
        expect(result.isError ?? false).toBe(false);
        expect(binding.boundDeviceSessionUuid(connection)).toBe(agent);
        expect(stamps()).toEqual(before);
        expectNoRelease();
        await fixture.teardown();
      },
    );

    arrangedNested2("a late control call still binds under live timely control work", async () => {
      hold(stamps().expiresAt + 60_000);
      ToolRegistry.registerDeviceAware("controlProbe", "Control probe", probeSchema, async () => ({
        success: true,
      }));
      goLate();
      const result = await fixture.client.callTool({
        name: "controlProbe",
        arguments: { sessionUuid: agent },
      });
      expect(result.isError ?? false).toBe(false);
      expect(binding.boundDeviceSessionUuid(connection)).toBe(agent);
      expectNoRelease();
      await fixture.teardown();
    });
  });

  // #11322 review: nested device-aware calls run under their outer call's execution. A nested read
  // must never reclassify the control call it runs inside as a read, or that call stops vetoing
  // its session's release (#5343).
  describe("which execution counts as a read for the release veto (#11322)", () => {
    const controlOnly = { excludeReads: true };
    let started: string[];

    function arrangeNested3(): void {
      started = [];
      runAuditedHandlers = true;
      ToolRegistry.registerDeviceAware(
        "controlProbe",
        "Control probe",
        probeSchema,
        async (_device: BootedDevice, args: Record<string, unknown>) => {
          if (args.thenRead) {
            // A control tool's own internal read, as a post-action observation makes one.
            await ToolRegistry.callInternal("readProbe", { sessionUuid: agent });
          }
          return { success: true };
        },
      );
    }

    function arrangedNested3(name: string, fn: () => void | Promise<void>, timeout?: number): void {
      arranged(
        name,
        async () => {
          await arrangeNested3();
          await fn();
        },
        timeout,
      );
    }

    afterEach(() => {
      for (const id of started) {
        executionTracker.endExecution(id);
      }
    });

    /** Start a top-level call's execution and run `body` under it, as MCP ingress does. */
    async function underExecution(toolName: string, body: () => Promise<unknown>): Promise<void> {
      const execution = executionTracker.startExecution(toolName, undefined, agent);
      started.push(execution.id);
      await runWithToolSelectionContext(
        { execution: { executionId: execution.id, startTime: execution.startTime } },
        body,
      );
    }

    const countsAsControl = () =>
      executionTracker.hasActiveSessionUuidExecutions(agent, controlOnly);

    arrangedNested3("a plan with a read step stays a control call", async () => {
      await underExecution("executePlan", () =>
        ToolRegistry.callInternal("readProbe", { sessionUuid: agent }, undefined, undefined, {
          forPlan: true,
        }),
      );

      expect(reads).toHaveLength(1);
      expect(countsAsControl()).toBe(true);
    });

    arrangedNested3("a plan's failure observe leaves it a control call", async () => {
      await underExecution("executePlan", async () => {
        await ToolRegistry.callInternal(
          "controlProbe",
          { sessionUuid: agent },
          undefined,
          undefined,
          {
            forPlan: true,
          },
        );
        // PlanStepExecutor's failure observe: an internal read with no plan options.
        await ToolRegistry.callInternal("readProbe", { sessionUuid: agent });
      });

      expect(reads).toHaveLength(1);
      expect(countsAsControl()).toBe(true);
    });

    arrangedNested3("a control tool that reads internally stays a control call", async () => {
      await underExecution("controlProbe", () =>
        call("controlProbe", { sessionUuid: agent, thenRead: true }),
      );

      expect(reads).toHaveLength(1);
      expect(countsAsControl()).toBe(true);
    });

    arrangedNested3("a top-level read is still left out of the veto", async () => {
      await underExecution("readProbe", () => call("readProbe", { sessionUuid: agent }));

      expect(reads).toHaveLength(1);
      expect(executionTracker.hasActiveSessionUuidExecutions(agent)).toBe(true);
      expect(countsAsControl()).toBe(false);
    });

    arrangedNested3(
      "a top-level read that goes on to a control step counts as control",
      async () => {
        await underExecution("readProbe", async () => {
          await call("readProbe", { sessionUuid: agent });
          await ToolRegistry.callInternal("controlProbe", { sessionUuid: agent });
        });

        expect(countsAsControl()).toBe(true);
      },
    );
  });

  describe("registered read tools", () => {
    let disposePrototypeTools: () => void;

    function arrangeNested4(): void {
      serverConfig.setEmbeddedSdkEnabled(true);
      // identifyInteractions is debug-only.
      setDebugModeEnabled(true);
      registerAccessibilityTools();
      registerDeepLinkTools();
      registerInteractionTools();
      registerNavigationTools();
      registerNotificationTools();
      registerObserveTools();
      disposePrototypeTools = registerPrototypeTools();
      registerAppTools();
      registerDatabaseTools();
      registerNetworkTools();
      registerPreferenceTools();
      registerSnapshotOfTools();
      registerStorageTools();
      registerUtilityTools();
    }

    function arrangedNested4(name: string, fn: () => void | Promise<void>, timeout?: number): void {
      arranged(
        name,
        async () => {
          await arrangeNested4();
          await fn();
        },
        timeout,
      );
    }

    afterEach(() => {
      // Drops the listApps override a test configured through the shared harness.
      appTools.clear();
    });

    const readCalls: Array<[string, Record<string, unknown>]> = [
      ["getNetworkGraph", {}],
      ["listApps", {}],
      ["snapshotOf", { rectangle: { left: 0, top: 0, right: 10, bottom: 10 } }],
      ["getDeviceState", {}],
      ["listDataStores", { appId: "com.example" }],
      ["getDataStore", { appId: "com.example", name: "settings" }],
      ["getPreference", { appId: "com.example", key: "k" }],
      ["sqlQuery", { appId: "com.example", databasePath: "app.db", query: "SELECT * FROM t" }],
      // #10965: the owner-listed reads, and the read forms of mixed tools.
      ["getAppPermissions", { appId: "com.example" }],
      ["getNotificationPolicy", { appId: "com.example" }],
      ["getDeepLinks", { appId: "com.example" }],
      ["getNavigationGraph", {}],
      ["hitTest", { x: 10, y: 10 }],
      ["identifyInteractions", {}],
      ["keyboard", { action: "detect" }],
      ["keyboard", { action: "listImes" }],
      ["keyboard", { action: "listProfiles" }],
      ["clipboard", { action: "get" }],
      ["displayConfig", {}],
      ["accessibility", {}],
      ["prototype", { action: "status" }],
      ["prototype", { action: "inspect" }],
    ];

    // The control forms of the same tools, and tools that change visible UI (#10965).
    const controlCalls: Array<[string, Record<string, unknown>]> = [
      ["keyboard", { action: "open" }],
      ["keyboard", { action: "setIme", imeId: "com.example/.Ime" }],
      ["clipboard", { action: "copy", text: "x" }],
      ["clipboard", { action: "clear" }],
      ["displayConfig", { theme: "dark" }],
      ["displayConfig", { reset: true }],
      ["accessibility", { talkback: true }],
      ["prototype", { action: "dismiss", all: true }],
      ["systemTray", { action: "list" }],
      ["systemTray", { action: "find", text: "x" }],
    ];

    afterEach(() => {
      disposePrototypeTools();
      setDebugModeEnabled(false);
    });

    // Authorization is denied so each tool stops at the read-only path's own check, before its real
    // handler would reach a device: that error (not the ownership refusal) shows the path taken.
    for (const [name, args] of readCalls) {
      arrangedNested4(
        `a sessionless ${name} ${JSON.stringify(args)} on a held device takes the read-only path without readiness`,
        async () => {
          authorized = false;
          const error = await outcome(name, {
            ...args,
            platform: "android",
            deviceId: held.deviceId,
          });

          expect(error).not.toBeInstanceOf(InputDeviceOwnedError);
          expect((error as Error).message).toBe("Observation access denied.");
          expect(listed).toBe(1);
          expectNoReadiness();
        },
      );
    }

    for (const [name, args] of readCalls) {
      arrangedNested4(
        `a sessionless ${name} ${JSON.stringify(args)} on a free device runs without a session`,
        async () => {
          const error = await outcome(name, {
            ...args,
            platform: "android",
            deviceId: free.deviceId,
          });

          expect(error).not.toBeInstanceOf(InputDeviceOwnedError);
          expect(audited).toEqual([{ name, deviceId: free.deviceId }]);
          expect(devices.getExplicitDevicePin()).toBeUndefined();
          expect(listed).toBe(0);
        },
      );
    }

    for (const [name, args] of controlCalls) {
      arrangedNested4(
        `a sessionless ${name} ${JSON.stringify(args)} on a held device is refused with the ownership code`,
        async () => {
          const error = await outcome(name, {
            ...args,
            platform: "android",
            deviceId: held.deviceId,
          });

          expect(error).toBeInstanceOf(InputDeviceOwnedError);
          expect((error as InputDeviceOwnedError).code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
          expect(listed).toBe(0);
          expectNoReadiness();
        },
      );
    }

    arrangedNested4(
      "a sessionless listApps on a held device returns the device's apps",
      async () => {
        const queried: string[] = [];
        appTools.configure("listApps", {
          queryInstalledApps: async (options) => {
            queried.push(options.deviceId!);
            const content: AppsQueryResourceContent = {
              query: options,
              observationComplete: true,
              totalCount: 0,
              installedCount: 0,
              deviceCount: 1,
              lastUpdated: "2026-01-01T00:00:00.000Z",
              devices: [],
            };
            return content;
          },
        });
        const response = await call("listApps", { platform: "android", deviceId: held.deviceId });

        expect(queried).toEqual([held.deviceId]);
        expect(JSON.stringify(response)).toContain(`Found 0 app(s) on ${held.deviceId}`);
        expectNoReadiness();
      },
    );

    for (const query of [
      "DELETE FROM t",
      "SELECT 1; DROP TABLE t",
      "PRAGMA journal_mode = DELETE",
      // #10966: a `)` in a literal or comment no longer ends the CTE early.
      "WITH a AS (SELECT ')' UNION SELECT 1) DELETE FROM t",
      "WITH a AS (SELECT 1 /* ) */ UNION SELECT 2) DELETE FROM t",
      'WITH a AS (SELECT ")" UNION SELECT 1) UPDATE t SET b = 1',
    ]) {
      arrangedNested4(
        `a sessionless sqlQuery write on a held device is refused with the ownership code: ${query}`,
        async () => {
          const error = await outcome("sqlQuery", {
            appId: "com.example",
            databasePath: "app.db",
            query,
            platform: "android",
            deviceId: held.deviceId,
          });

          expect(error).toBeInstanceOf(InputDeviceOwnedError);
          expect((error as InputDeviceOwnedError).code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
          expect(listed).toBe(0);
          expectNoReadiness();
        },
      );
    }

    arrangedNested4("the holder's sqlQuery write still runs on its device", async () => {
      await call("sqlQuery", {
        appId: "com.example",
        databasePath: "app.db",
        query: "DELETE FROM t",
        sessionUuid: agent,
        deviceId: held.deviceId,
      });

      expect(audited).toEqual([{ name: "sqlQuery", deviceId: held.deviceId }]);
      expect(listed).toBe(0);
    });
  });
});

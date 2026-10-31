import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { z } from "zod/v4";
import { INTERNAL_MCP_SESSION_PARAM } from "../../src/daemon/wire/constants";
import { DevicePool } from "../../src/daemon/devicePool";
import { DaemonState } from "../../src/daemon/daemonState";
import {
  OWNER_DISCONNECT_GRACE_MS,
  OWNER_DISCONNECTED_RELEASE_REASON,
} from "../../src/daemon/ownerDisconnectRelease";
import { resetDbWriteBarrier } from "../../src/db/dbWriteBarrier";
import { NavigationGraphManager } from "../../src/features/navigation/NavigationGraphManager";
import {
  getToolSelectionContext,
  isSessionlessDeviceRead,
  runWithToolSelectionContext,
} from "../../src/features/toolSelection/toolSelectionContext";
import type { BootedDevice } from "../../src/models";
import { executionTracker } from "../../src/daemon/executionTracker";
import { SessionReleaseBroadcaster } from "../../src/daemon/sessionReleaseBroadcast";
import { ToolRegistry, type ToolRegistryCollaborators } from "../../src/server/toolRegistry";
import type { PlatformDeviceManager } from "../../src/utils/interfaces/DeviceUtils";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionRepository } from "../fakes/FakeDeviceSessionRepository";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { drainMicrotasks, FAKE_TIMER_QUIET_TURNS } from "../helpers/fakeTimerStepping";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";
import { DaemonLifecycleHarness } from "./helpers/DaemonLifecycleHarness";

const HELD: BootedDevice = { name: "Pixel A", deviceId: "emulator-5554", platform: "android" };
const WATCHED: BootedDevice = { name: "Pixel B", deviceId: "emulator-5556", platform: "android" };
const SESSION = "nested-key-session";
const OWNER = "nested-key-owner";
const SEED = "nested-key-released-seed";
const OUTER = "__nested_key_outer__";
const READ = "__nested_key_read__";
const CONTROL = "__nested_key_control__";

type Nesting = "read" | "sessionless-control" | "same-session-control" | "throwing-read";

describe("nested sessionless calls keep the outer control execution's session key (#11680)", () => {
  let previousInjectedManager: PlatformDeviceManager | null;
  let restoreHermeticServer: () => void;
  let restorePipeline: () => void;
  let originalCollaborators: ToolRegistryCollaborators;
  let previousAutolock: string | undefined;
  let fixture: McpTestFixture;
  let timer: FakeTimer;
  let daemon: DaemonLifecycleHarness;
  let session: string;
  let entered: PromiseWithResolvers<void>;
  let outcome: PromiseWithResolvers<{ success: true }>;
  let ends: Array<{ uuids: readonly string[]; admitted: boolean }>;
  let unsubscribeEnds: () => void;
  let releases: Array<{ sessionId: string; reason: string; at: number }>;
  let nestedResolution: { sessionUuid: unknown; readOnlyPath: boolean } | undefined;
  let outerExecutionId: string | undefined;
  let nestedExecutionId: string | undefined;
  let endCalls: () => number;
  let restoreEndSpy: () => void;
  let pendingCall: Promise<unknown> | undefined;

  const settle = (ms: number) =>
    timer.advanceTimeAsync(ms, () => drainMicrotasks(FAKE_TIMER_QUIET_TURNS));

  // Pay cold server imports, registrations and first-call costs once. Every test still creates
  // its own daemon, sessions and MCP call; no per-scenario work is hidden in this warm-up.
  beforeAll(async () => {
    // The helper captures the current manager with getInstance; prime it without constructing
    // the production manager, whose constructor probes the Android toolchain.
    previousInjectedManager = PlatformDeviceManagerFactory.slotsForTesting().injectedManager;
    PlatformDeviceManagerFactory.setInstance(new FakeDeviceManager());
    await arrange("read", true);
    const { call } = await startOuter(true);
    daemon.getDevicePool().releaseMcpSessionBindings(OWNER);
    await settle(OWNER_DISCONNECT_GRACE_MS);
    outcome.resolve({ success: true });
    await call;
    await settle(0);
    await dismantle();
  });
  afterEach(dismantle);
  afterAll(() => {
    PlatformDeviceManagerFactory.setInstance(previousInjectedManager);
  });

  async function arrange(nesting: Nesting = "read", seeded = false): Promise<void> {
    previousAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = seeded ? "1" : "0";
    resetDbWriteBarrier();
    restoreHermeticServer = installHermeticServerFixture();
    // Keep the real target resolver and wrappers, replacing only device work and output I/O.
    restorePipeline = ToolRegistry.setPipelineOverridesForTesting({
      displayInventory: new FakeDisplayInventoryProvider(),
      deviceReadAccess: { listBooted: async () => [HELD, WATCHED], isAuthorized: () => true },
      auditRunner: {
        run: async (input) => input.handler(input.device, input.args, input.progress, input.signal),
      },
      afterToolCall: {
        handle: async (input) => ({ durationMs: 0, finalizedResponse: input.response }),
      },
    });
    originalCollaborators = ToolRegistry.getCollaboratorsForTesting();
    ToolRegistry.setCollaboratorsForTesting({
      navigationToolCallRecorder: { record: () => undefined },
    });
    timer = new FakeTimer();
    const deviceManager = new FakeDeviceManager();
    deviceManager.bootedDevices = [HELD, WATCHED];
    // Inject before construction: replacing the pool's manager afterwards is too late to avoid
    // the production manager's constructor probes. Retain the daemon's real lifecycle callbacks.
    const poolFactory = spyOn(DevicePool, "create").mockImplementation(
      (deps) => new DevicePool({ ...deps, deviceManager }),
    );
    try {
      daemon = new DaemonLifecycleHarness(
        {},
        {
          installedAppsRepository: new FakeInstalledAppsRepository(),
          timer,
          deviceSessionRepository: new FakeDeviceSessionRepository(),
        },
      );
    } finally {
      poolFactory.mockRestore();
    }
    const manager = daemon.getSessionManager();
    manager.stopCleanupTimer();
    releases = [];
    manager.onSessionRelease((sessionId, _deviceId, reason) => {
      releases.push({ sessionId, reason, at: timer.now() });
    });
    daemon.subscribeToolCallEnd();
    ends = [];
    unsubscribeEnds = executionTracker.onSessionExecutionEnded((uuids, { admitted }) =>
      ends.push({ uuids, admitted }),
    );
    const endSpy = spyOn(executionTracker, "endExecution");
    endCalls = () => endSpy.mock.calls.length;
    restoreEndSpy = () => endSpy.mockRestore();
    const pool = daemon.getDevicePool();
    await pool.initializeWithDevices([HELD, WATCHED]);
    const autolocked = seeded
      ? await pool.autolockDevice(HELD.deviceId, "android", OWNER)
      : SESSION;
    if (!autolocked) {
      throw new Error("autolockDevice did not return a session");
    }
    session = autolocked;
    if (!seeded) {
      await pool.bindOrReuseDeviceSession({
        sessionId: session,
        deviceId: HELD.deviceId,
        platform: "android",
        allowSessionRebind: false,
        mcpSessionId: OWNER,
      });
    }
    entered = Promise.withResolvers<void>();
    outcome = Promise.withResolvers<{ success: true }>();
    nestedResolution = undefined;
    outerExecutionId = undefined;
    nestedExecutionId = undefined;
    pendingCall = undefined;
    ToolRegistry.registerDeviceAware(
      READ,
      "nested sessionless read probe",
      z.object({ deviceId: z.string() }),
      {
        handler: async (_device: BootedDevice, args: Record<string, unknown>) => {
          nestedResolution = {
            sessionUuid: args.sessionUuid,
            readOnlyPath: isSessionlessDeviceRead(),
          };
          nestedExecutionId = getToolSelectionContext()?.execution?.executionId;
          if (nesting === "throwing-read") {
            entered.resolve();
            await outcome.promise;
            throw new Error("nested read failed");
          }
          return { success: true };
        },
        deviceReadOnly: true,
      },
    );
    const recordControl = async (args: Record<string, unknown>) => {
      nestedResolution = { sessionUuid: args.sessionUuid, readOnlyPath: isSessionlessDeviceRead() };
      nestedExecutionId = getToolSelectionContext()?.execution?.executionId;
      return { success: true };
    };
    ToolRegistry.registerDeviceAware(CONTROL, "nested control probe", z.object({}), {
      handler: async (_device: BootedDevice, args: Record<string, unknown>) => recordControl(args),
      shouldEnsureDevice: () => nesting !== "sessionless-control",
      nonDeviceHandler: recordControl,
    });
    ToolRegistry.registerDeviceAware(
      OUTER,
      "outer control probe",
      z.object({ deviceId: z.string().optional() }),
      async (_device: BootedDevice, _args: Record<string, unknown>, _progress, signal) => {
        outerExecutionId = getToolSelectionContext()?.execution?.executionId;
        if (nesting === "sessionless-control") {
          // An internal dispatch with no routing identity and no device work (e.g. a conditional
          // control's nonDeviceHandler). Keep the production context merge and target resolver.
          await runWithToolSelectionContext({ routingSessionUuid: "" }, () =>
            ToolRegistry.getTool(CONTROL)!.handler({}, undefined, signal),
          );
        } else {
          const tool = nesting === "same-session-control" ? CONTROL : READ;
          await ToolRegistry.getTool(tool)!.handler(
            tool === READ ? { deviceId: WATCHED.deviceId } : {},
            undefined,
            signal,
          );
        }
        entered.resolve();
        const result = await outcome.promise;
        signal?.throwIfAborted();
        return result;
      },
    );
    fixture = new McpTestFixture({
      daemonMode: true,
      sessionContext: seeded
        ? { sessionId: "nested-key-loopback", initialSessionToolBinding: SEED }
        : undefined,
    });
    await fixture.setup();
    if (seeded) {
      SessionReleaseBroadcaster.emit(SEED, "test");
    }
  }

  async function dismantle(): Promise<void> {
    // Also close a blocked probe after a failed assertion, preventing leaked execution state.
    outcome.resolve({ success: true });
    await pendingCall;
    await fixture.teardown();
    unsubscribeEnds();
    restoreEndSpy();
    daemon.stopTimers();
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
    NavigationGraphManager.resetInstance();
    ToolRegistry.setCollaboratorsForTesting(originalCollaborators);
    restorePipeline();
    restoreHermeticServer();
    resetDbWriteBarrier();
    if (previousAutolock === undefined) {
      delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    } else {
      process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = previousAutolock;
    }
  }

  async function startOuter(seeded = false) {
    const call = fixture.client.callTool({
      name: OUTER,
      arguments: {
        ...(seeded ? {} : { deviceId: HELD.deviceId }),
        [INTERNAL_MCP_SESSION_PARAM]: OWNER,
      },
    });
    pendingCall = call;
    await entered.promise;
    return { call };
  }

  function expectEnded(): void {
    expect(ends).toEqual([{ uuids: [session], admitted: true }]);
    expect(endCalls()).toBe(1);
    expect(executionTracker.getActiveDeviceSessionExecutionCount(session)).toBe(0);
    expect(executionTracker.getActiveExecutionCount()).toBe(0);
    expect(executionTracker.getSessionClockStartTime(outerExecutionId!)).toBeUndefined();
    expect(timer.getSleepCallCount()).toBe(0);
  }

  test.each([
    { name: "holder deviceId-only", seeded: false },
    { name: "released loopback seed", seeded: true },
  ])("nested read preserves the $name outer key through disconnect and end", async ({ seeded }) => {
    await arrange("read", seeded);
    const { call } = await startOuter(seeded);
    expect(nestedResolution).toEqual({ sessionUuid: undefined, readOnlyPath: true });
    expect(nestedExecutionId).toBe(outerExecutionId);
    expect(executionTracker.hasActiveSessionUuidExecutions(session)).toBe(false);
    daemon.getDevicePool().releaseMcpSessionBindings(OWNER);
    await settle(OWNER_DISCONNECT_GRACE_MS);
    expect(releases).toEqual([]);
    expect(daemon.getSessionManager().getSession(session)).not.toBeNull();
    expect(executionTracker.hasActiveAutolockSessionExecutions(session)).toBe(true);
    const endedAt = timer.now();
    outcome.resolve({ success: true });
    expect((await call).isError).not.toBe(true);
    expectEnded();
    await settle(0);
    expect(releases).toEqual([
      { sessionId: session, reason: OWNER_DISCONNECTED_RELEASE_REASON, at: endedAt },
    ]);
    expect(timer.now()).toBe(endedAt);
  });

  test("a finished nested read leaves no hold for a later owner disconnect", async () => {
    await arrange();
    const { call } = await startOuter();
    const idleDeadline = daemon.getSessionManager().getSession(session)?.expiresAt;
    expect(nestedResolution).toEqual({ sessionUuid: undefined, readOnlyPath: true });
    expect(
      daemon.getDevicePool().resolveOwnedDeviceSessionForMcpSession(OWNER, WATCHED.deviceId),
    ).toBeUndefined();
    expect(daemon.getSessionManager().getSession(session)?.expiresAt).toBe(idleDeadline);
    outcome.resolve({ success: true });
    await call;
    expectEnded();
    const disconnectedAt = timer.now();
    daemon.getDevicePool().releaseMcpSessionBindings(OWNER);
    await settle(OWNER_DISCONNECT_GRACE_MS);
    expect(releases).toEqual([
      {
        sessionId: session,
        reason: OWNER_DISCONNECTED_RELEASE_REASON,
        at: disconnectedAt + OWNER_DISCONNECT_GRACE_MS,
      },
    ]);
  });

  test.each(["sessionless-control", "same-session-control"] as const)(
    "nested %s preserves the outer key",
    async (nesting) => {
      await arrange(nesting);
      const { call } = await startOuter();
      expect(nestedResolution?.sessionUuid).toBe(
        nesting === "sessionless-control" ? undefined : session,
      );
      expect(nestedExecutionId).toBe(outerExecutionId);
      expect(executionTracker.hasActiveAutolockSessionExecutions(session)).toBe(true);
      outcome.resolve({ success: true });
      expect((await call).isError).not.toBe(true);
      expectEnded();
    },
  );

  test.each(["throwing-read", "cancelled"] as const)(
    "nested read with outer exit %s ends exactly once without leaking its key",
    async (exit) => {
      await arrange(exit === "throwing-read" ? exit : "read");
      const { call } = await startOuter();
      daemon.getDevicePool().releaseMcpSessionBindings(OWNER);
      await settle(OWNER_DISCONNECT_GRACE_MS);
      if (exit === "cancelled") {
        expect(await executionTracker.cancelToolExecutions(OUTER, "test")).toBe(1);
      }
      outcome.resolve({ success: true });
      expect((await call).isError).toBe(true);
      expectEnded();
      const endedAt = timer.now();
      await settle(0);
      expect(releases).toEqual([
        { sessionId: session, reason: OWNER_DISCONNECTED_RELEASE_REASON, at: endedAt },
      ]);
    },
  );

  test("a top-level sessionless read still clears a seeded execution key", async () => {
    await arrange();
    const tool = ToolRegistry.getTool(READ)!;
    const handler = tool.handler;
    // Seed at real MCP ingress, before the outermost device-aware wrapper resolves its target.
    tool.handler = async (args, progress, signal) => {
      const id = getToolSelectionContext()!.execution!.executionId;
      executionTracker.setResolvedAutolockSessionUuid(id, session);
      expect(executionTracker.hasActiveAutolockSessionExecutions(session)).toBe(true);
      return handler(args, progress, signal);
    };
    const idleDeadline = daemon.getSessionManager().getSession(session)?.expiresAt;
    expect(
      (await fixture.client.callTool({ name: READ, arguments: { deviceId: HELD.deviceId } }))
        .isError,
    ).not.toBe(true);
    expect(nestedResolution).toEqual({ sessionUuid: undefined, readOnlyPath: true });
    expect(executionTracker.hasActiveAutolockSessionExecutions(session)).toBe(false);
    expect(ends).toEqual([]);
    expect(endCalls()).toBe(1);
    expect(daemon.getSessionManager().getSession(session)?.expiresAt).toBe(idleDeadline);
  });
});

import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
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
import type { BootedDevice } from "../../src/models";
import { executionTracker } from "../../src/daemon/executionTracker";
import { SessionReleaseBroadcaster } from "../../src/daemon/sessionReleaseBroadcast";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionRepository } from "../fakes/FakeDeviceSessionRepository";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { drainMicrotasks, FAKE_TIMER_QUIET_TURNS } from "../helpers/fakeTimerStepping";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";
import { DaemonLifecycleHarness } from "./helpers/DaemonLifecycleHarness";

const DEVICE: BootedDevice = {
  name: "Pixel_8_API_35",
  deviceId: "emulator-5554",
  platform: "android",
};
const OWNER = "provisional-key-owner";
const SEED = "provisional-key-released-seed";
const TOOL = "__untargeted_provisional_key_control__";

describe("untargeted calls cannot abandon a different provisional autolock key (#11381)", () => {
  let restoreHermeticServer: () => void;
  let previousAutolock: string | undefined;
  let fixture: McpTestFixture;
  let timer: FakeTimer;
  let daemon: DaemonLifecycleHarness;

  async function autolockOwnerDevice(): Promise<string> {
    const session = await daemon.getDevicePool().autolockDevice(DEVICE.deviceId, "android", OWNER);
    if (!session) {
      throw new Error("autolockDevice did not return a session");
    }
    return session;
  }
  let consulted: Array<{ mcp: string; sessionUuid: string | undefined }>;
  let handlerSession: string | undefined;
  let handlerHasExplicitExecution: boolean;
  let entered: PromiseWithResolvers<void>;
  let outcome: PromiseWithResolvers<{ success: true }>;
  let ends: Array<{ uuids: readonly string[]; admitted: boolean }>;
  let unsubscribeEnds: () => void;
  let releaseReasons: string[];

  const settle = (ms: number) =>
    timer.advanceTimeAsync(ms, () => drainMicrotasks(FAKE_TIMER_QUIET_TURNS));

  // Warm one complete call and release cycle for the server's cold import and first Daemon.
  // Each test still builds and exercises its own world.
  beforeAll(async () => {
    await arrange(true);
    await daemon.getDevicePool().autolockDevice(DEVICE.deviceId, "android", OWNER);
    SessionReleaseBroadcaster.emit(SEED, "test");
    const { call } = await startBlockedCall();
    daemon.getDevicePool().releaseMcpSessionBindings(OWNER);
    await settle(OWNER_DISCONNECT_GRACE_MS);
    outcome.resolve({ success: true });
    await call;
    await settle(0);
    await dismantle();
  });

  afterEach(dismantle);

  async function arrange(seeded = false): Promise<void> {
    previousAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
    resetDbWriteBarrier();
    restoreHermeticServer = installHermeticServerFixture();
    timer = new FakeTimer();
    const deviceManager = new FakeDeviceManager();
    deviceManager.bootedDevices = [DEVICE];
    // Inject before construction: the pool's manager is fixed when the daemon builds the pool.
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
    daemon.getSessionManager().stopCleanupTimer();
    releaseReasons = [];
    daemon.getSessionManager().onSessionRelease((_sessionId, _deviceId, reason) => {
      releaseReasons.push(reason);
    });
    daemon.subscribeToolCallEnd();
    ends = [];
    unsubscribeEnds = executionTracker.onSessionExecutionEnded((uuids, { admitted }) =>
      ends.push({ uuids, admitted }),
    );
    const pool = daemon.getDevicePool();
    await pool.initializeWithDevices([DEVICE]);
    consulted = [];
    executionTracker.setAutolockSessionResolver({
      autolockSessionForMcpSession: (mcp) => {
        const sessionUuid = pool.captureAutolockSessionForMcpSession(mcp);
        consulted.push({ mcp, sessionUuid });
        return sessionUuid;
      },
    });
    entered = Promise.withResolvers<void>();
    outcome = Promise.withResolvers<{ success: true }>();
    handlerSession = undefined;
    handlerHasExplicitExecution = false;
    ToolRegistry.registerDeviceAware(
      TOOL,
      "untargeted provisional key control probe",
      z.object({}),
      async (_device: BootedDevice, args: { sessionUuid?: string }) => {
        handlerSession = args.sessionUuid;
        handlerHasExplicitExecution =
          args.sessionUuid !== undefined &&
          executionTracker.hasActiveSessionUuidExecutions(args.sessionUuid);
        entered.resolve();
        return await outcome.promise;
      },
    );
    fixture = new McpTestFixture({
      daemonMode: true,
      sessionContext: seeded
        ? { sessionId: "provisional-key-loopback", initialSessionToolBinding: SEED }
        : undefined,
    });
    await fixture.setup();
  }

  async function dismantle(): Promise<void> {
    await fixture.teardown();
    ToolRegistry.unregister(TOOL);
    unsubscribeEnds();
    executionTracker.setAutolockSessionResolver({
      autolockSessionForMcpSession: (mcp) =>
        daemon.getDevicePool().captureAutolockSessionForMcpSession(mcp),
    });
    daemon.stopTimers();
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
    NavigationGraphManager.resetInstance();
    restoreHermeticServer();
    resetDbWriteBarrier();
    if (previousAutolock === undefined) {
      delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    } else {
      process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = previousAutolock;
    }
  }

  const callTool = () =>
    fixture.client.callTool({
      name: TOOL,
      arguments: { [INTERNAL_MCP_SESSION_PARAM]: OWNER },
    });

  async function startBlockedCall() {
    const call = callTool();
    await entered.promise;
    // Wrap the promise so this helper does not wait for the blocked call's result.
    return { call };
  }

  test("an ordinary live route starts explicitly under its session without consulting the resolver", async () => {
    await arrange();
    const session = await autolockOwnerDevice();
    const { call } = await startBlockedCall();

    // Ordinary routing picks the execution key before startExecution, so there is no provisional key.
    expect(consulted).toEqual([]);
    expect(handlerSession).toBe(session);
    expect(handlerHasExplicitExecution).toBe(true);
    outcome.resolve({ success: true });
    expect((await call).isError).not.toBe(true);
    expect(ends).toEqual([{ uuids: [session], admitted: true }]);
  });

  test("a missing or released ordinary route leaves no provisional session for the tracker to capture", async () => {
    await arrange();
    const pool = daemon.getDevicePool();
    // Use the real routing and capture methods directly: a sessionless MCP call otherwise enters
    // device discovery before cancellation. No device acquisition is needed to pin this invariant.
    expect(pool.resolveAutolockSessionForMcpSession(OWNER)).toBeUndefined();
    expect(pool.captureAutolockSessionForMcpSession(OWNER)).toBeUndefined();

    const session = await autolockOwnerDevice();
    expect(pool.resolveAutolockSessionForMcpSession(OWNER)).toBe(session);
    expect(pool.captureAutolockSessionForMcpSession(OWNER)).toBe(session);
    await daemon.getSessionManager().releaseSession(session);
    await settle(0);
    expect(pool.resolveAutolockSessionForMcpSession(OWNER)).toBeUndefined();
    expect(pool.captureAutolockSessionForMcpSession(OWNER)).toBeUndefined();
  });

  test("a released loopback seed rekeys to the same autolock id and ends its deferred release exactly once", async () => {
    await arrange(true);
    const session = await autolockOwnerDevice();
    SessionReleaseBroadcaster.emit(SEED, "test");
    const { call } = await startBlockedCall();

    // The seeded path starts provisionally, then resolves the very same route before dispatch.
    expect(consulted).toEqual([{ mcp: OWNER, sessionUuid: session }]);
    expect(handlerSession).toBe(session);
    daemon.getDevicePool().releaseMcpSessionBindings(OWNER);
    const closedAt = timer.now();
    await settle(OWNER_DISCONNECT_GRACE_MS);
    expect(daemon.getSessionManager().getSession(session)).not.toBeNull();

    outcome.resolve({ success: true });
    expect((await call).isError).not.toBe(true);
    await settle(0);

    // Re-keying reports no extra end, and the control call's end retries the release without time passing.
    expect(ends).toEqual([{ uuids: [session], admitted: true }]);
    expect(timer.now()).toBe(closedAt + OWNER_DISCONNECT_GRACE_MS);
    expect(releaseReasons).toEqual([OWNER_DISCONNECTED_RELEASE_REASON]);
    expect(daemon.getDevicePool().getDevice(DEVICE.deviceId)?.sessionId).toBeNull();
  });
});

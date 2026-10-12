import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { INTERNAL_MCP_SESSION_PARAM } from "../../src/daemon/constants";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import {
  OWNER_DISCONNECT_GRACE_MS,
  OWNER_DISCONNECTED_RELEASE_REASON,
} from "../../src/daemon/ownerDisconnectRelease";
import { SessionManager } from "../../src/daemon/sessionManager";
import { SESSION_ACTIVITY_CLOCKS, SESSION_LIVENESS_CLOCKS } from "../../src/daemon/sessionClocks";
import { SessionScopedStreamAuthenticator } from "../../src/daemon/streamSocketAuth";
import type { BootedDevice } from "../../src/models";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { foreignOwnedSessionUuidFromResult } from "../../src/server/routedSessionMeta";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDeviceSessionManager } from "../fakes/FakeDeviceSessionManager";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";
import { drainMicrotasks, FAKE_TIMER_QUIET_TURNS } from "../helpers/fakeTimerStepping";

/**
 * #11348 item 3 (probe P6): the explicit-UUID attach runs after the handler, and the pool's bind
 * claim only opened inside that attach. A connection that closed while its handler was still
 * running had already had its bindings released, so the attach recorded it as the session's owner:
 * a dead owner that cancelled the armed owner-disconnect release and held the device until idle.
 * Driven through the real `tools/call` dispatch of a daemon-mode server.
 */
const DEVICE: BootedDevice = { name: "Pixel 8", platform: "android", deviceId: "emulator-5554" };
const PROBE = "slowProbe";
const FIRST = "first-connection";
const CLOSING = "closing-connection";
const READ_PROBE = "ownerlessReadProbe";
const READER = "reading-connection";
const ELAPSED_MS = 123;

describe("a connection that closed while its explicit-sessionUuid call was in flight (#11348)", () => {
  let restoreHermeticServer: () => void;
  let restoreToolCallRepository: () => void;
  let restoreDeviceSessionManager: () => void;
  let previousAutolock: string | undefined;
  let fixture: McpTestFixture | undefined;
  let timer: FakeTimer;
  let manager: SessionManager;
  let pool: DevicePool;
  let releaseReasons: string[];
  let sessionId: string;
  let entered: PromiseWithResolvers<void>;
  let proceed: PromiseWithResolvers<void>;

  beforeAll(async () => {
    // Pay the server module's cold import and tool registration outside any test's budget.
    const restore = installHermeticServerFixture();
    const warm = new McpTestFixture();
    await warm.setup();
    await warm.teardown();
    restore();
    await setUp();
    try {
      await callRead();
    } finally {
      await tearDown();
    }
  });

  async function setUp() {
    previousAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
    restoreHermeticServer = installHermeticServerFixture();
    const original = Reflect.get(ToolRegistry, "toolCallRepository");
    Reflect.set(ToolRegistry, "toolCallRepository", { async recordToolCall(): Promise<void> {} });
    restoreToolCallRepository = () => Reflect.set(ToolRegistry, "toolCallRepository", original);
    const previousDeviceSessionManager = ToolRegistry.getDeviceSessionManager();
    const deviceSessionManager = new FakeDeviceSessionManager();
    deviceSessionManager.setConnectedDevices([DEVICE]);
    Reflect.set(ToolRegistry, "deviceSessionManager", deviceSessionManager);
    restoreDeviceSessionManager = () =>
      Reflect.set(ToolRegistry, "deviceSessionManager", previousDeviceSessionManager);

    timer = new FakeTimer();
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    manager.stopCleanupTimer();
    releaseReasons = [];
    manager.onSessionRelease((_sessionId, _deviceId, reason) => {
      releaseReasons.push(reason);
    });
    const discovery = new FakeDeviceUtils();
    discovery.setBootedDevices("android", [DEVICE]);
    PlatformDeviceManagerFactory.setInstance(discovery);
    pool = new DevicePool(
      createDevicePoolDependencies(manager, "mid-call-close-daemon", {
        timer,
        deviceManager: discovery,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        deviceSessionRepository: { markAutolockSession: async () => {} },
      }),
    );
    await pool.initializeWithDevices([DEVICE]);
    DaemonState.getInstance().initialize(manager, pool);

    // A's autolock session, with A gone: its owner-disconnect release is armed.
    sessionId = (await pool.autolockDevice(DEVICE.deviceId, "android", FIRST))!;
    pool.releaseMcpSessionBindings(FIRST);

    entered = Promise.withResolvers<void>();
    proceed = Promise.withResolvers<void>();
    ToolRegistry.registerDeviceAware(
      PROBE,
      PROBE,
      z.object({}),
      async () => {
        entered.resolve();
        await proceed.promise;
        return { success: true };
      },
      { deviceReadiness: "booted" },
    );
    ToolRegistry.registerDeviceAware(
      READ_PROBE,
      READ_PROBE,
      z.object({ fail: z.boolean().optional(), wait: z.boolean().optional() }),
      async (device, params) => {
        if (params.wait) {
          entered.resolve();
          await proceed.promise;
        }
        if (params.fail) {
          throw new Error("read probe failure");
        }
        return { content: [{ type: "text", text: device.deviceId }] };
      },
      { deviceReadiness: "booted", deviceReadOnly: true },
    );
    fixture = new McpTestFixture({ daemonMode: true });
    await fixture.setup();
  }
  beforeEach(setUp);

  async function tearDown() {
    await fixture?.teardown();
    fixture = undefined;
    DaemonState.getInstance().reset();
    manager.stopCleanupTimer();
    restoreDeviceSessionManager();
    restoreToolCallRepository();
    restoreHermeticServer();
    if (previousAutolock === undefined) {
      delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    } else {
      process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = previousAutolock;
    }
  }
  afterEach(tearDown);

  function callProbe(connection: string) {
    return fixture!.client.callTool({
      name: PROBE,
      arguments: {
        sessionUuid: sessionId,
        keepScreenAwake: false,
        [INTERNAL_MCP_SESSION_PARAM]: connection,
      },
    });
  }

  function callRead(connection = READER, args: Record<string, unknown> = {}) {
    return fixture!.client.callTool({
      name: READ_PROBE,
      arguments: {
        sessionUuid: sessionId,
        keepScreenAwake: false,
        [INTERNAL_MCP_SESSION_PARAM]: connection,
        ...args,
      },
    });
  }

  function stamps() {
    const session = manager.getSession(sessionId)!;
    return Object.fromEntries(
      [...SESSION_ACTIVITY_CLOCKS, ...SESSION_LIVENESS_CLOCKS, "activityGeneration" as const].map(
        (field) => [field, session[field]],
      ),
    );
  }

  async function expectDisconnectRelease(remainingMs: number) {
    timer.advanceTime(remainingMs - 1);
    await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);
    expect(manager.getSession(sessionId)).not.toBeNull();
    timer.advanceTime(1);
    await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);
    expect(manager.getSession(sessionId)).toBeNull();
    expect(releaseReasons).toEqual([OWNER_DISCONNECTED_RELEASE_REASON]);
  }

  test("a read naming an ownerless session answers without adopting it or moving its release or stamps", async () => {
    timer.advanceTime(ELAPSED_MS);
    const before = stamps();
    const remaining = pool.holderReleaseRemainingMs(sessionId);
    expect(remaining).toBe(OWNER_DISCONNECT_GRACE_MS - ELAPSED_MS);

    const result = await callRead();
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: "text", text: DEVICE.deviceId }]);
    expect(pool.resolveAutolockSessionForMcpSession(READER)).toBeUndefined();
    expect(pool.isSessionOwnedByOtherConnection(sessionId, "an-unrelated-connection")).toBe(false);
    expect(pool.holderReleaseRemainingMs(sessionId)).toBe(remaining);
    expect(stamps()).toEqual(before);
    await expectDisconnectRelease(OWNER_DISCONNECT_GRACE_MS - ELAPSED_MS);
  });

  test.each([false, true])(
    "an ownerless read result tells the proxy not to remember the named session (failure=%s)",
    async (fail) => {
      const result = await callRead(READER, { fail });
      expect(Boolean(result.isError)).toBe(fail);
      expect(foreignOwnedSessionUuidFromResult(result)).toBe(sessionId);
    },
  );

  test("the owner's own read keeps ownership and carries no do-not-remember marker", async () => {
    const reclaim = callProbe(FIRST);
    await entered.promise;
    proceed.resolve();
    await reclaim;
    timer.advanceTime(ELAPSED_MS);
    const before = stamps();
    const result = await callRead(FIRST);
    expect(result.isError).not.toBe(true);
    expect(foreignOwnedSessionUuidFromResult(result)).toBeUndefined();
    expect(pool.resolveAutolockSessionForMcpSession(FIRST)).toBe(sessionId);
    expect(pool.isSessionOwnedByOtherConnection(sessionId, READER)).toBe(true);
    expect(stamps()).toEqual(before);
  });

  test("the ownership query judges restored ownership and derived labels without touching clocks", async () => {
    await pool.restoreOwnedDeviceSessionsForMcpSession([sessionId], FIRST);
    expect(pool.resolveAutolockSessionForMcpSession(FIRST)).toBeUndefined();
    const label = `${sessionId}:phone`;
    manager.setDeviceLabels(sessionId, { phone: label });
    timer.advanceTime(ELAPSED_MS);
    const before = stamps();
    const remaining = pool.holderReleaseRemainingMs(sessionId);
    expect(pool.isSessionOwnedByConnection(sessionId, FIRST)).toBe(true);
    expect(pool.isSessionOwnedByConnection(label, FIRST)).toBe(true);
    expect(pool.isSessionOwnedByConnection(label, READER)).toBe(false);
    expect(pool.isSessionOwnedByConnection(label, undefined)).toBe(false);
    expect(pool.isSessionOwnedByConnection("not-a-device-session", FIRST)).toBe(false);
    const result = await callRead(FIRST);
    expect(result.isError).not.toBe(true);
    expect(foreignOwnedSessionUuidFromResult(result)).toBeUndefined();
    expect(pool.holderReleaseRemainingMs(sessionId)).toBe(remaining);
    expect(stamps()).toEqual(before);
  });

  test("a read naming a cli-idle session carries no do-not-remember marker", async () => {
    expect(manager.adoptCliLivenessPolicy(sessionId)).toBe(true);
    expect(manager.getSession(sessionId)?.livenessPolicy).toBe("cli-idle");
    const result = await callRead();
    expect(result.isError).not.toBe(true);
    expect(foreignOwnedSessionUuidFromResult(result)).toBeUndefined();
  });

  test("a read naming an unknown session carries no do-not-remember marker", async () => {
    const result = await callRead(READER, { sessionUuid: "not-a-device-session" });
    expect(foreignOwnedSessionUuidFromResult(result)).toBeUndefined();
    expect(pool.resolveAutolockSessionForMcpSession(READER)).toBeUndefined();
  });

  test("an in-flight ownerless read does not defer the armed release", async () => {
    const call = callRead(READER, { wait: true });
    await entered.promise;
    await expectDisconnectRelease(OWNER_DISCONNECT_GRACE_MS);
    proceed.resolve();
    const result = await call;
    expect(result.isError).not.toBe(true);
    expect(pool.resolveAutolockSessionForMcpSession(READER)).toBeUndefined();
  });

  test("viewer stream admission naming an ownerless session leaves its release and stamps untouched", async () => {
    timer.advanceTime(ELAPSED_MS);
    const before = stamps();
    const remaining = pool.holderReleaseRemainingMs(sessionId);
    expect(remaining).toBe(OWNER_DISCONNECT_GRACE_MS - ELAPSED_MS);
    const auth = new SessionScopedStreamAuthenticator(() => manager, "webrtcStream", {});
    const input = { sessionUuid: sessionId, deviceId: DEVICE.deviceId, admitViewer: true };
    expect(() => auth.authorize(input)).not.toThrow();
    expect(auth.resolveSubscriptionIdentity(input)).toMatchObject({
      authEnabled: true,
      sessionExists: true,
      ownsDevice: true,
    });
    expect(pool.resolveAutolockSessionForMcpSession(READER)).toBeUndefined();
    expect(pool.isSessionOwnedByOtherConnection(sessionId, READER)).toBe(false);
    expect(pool.holderReleaseRemainingMs(sessionId)).toBe(remaining);
    expect(stamps()).toEqual(before);
    await expectDisconnectRelease(OWNER_DISCONNECT_GRACE_MS - ELAPSED_MS);
  });

  test("is never recorded as the session's owner, and the armed release still fires", async () => {
    const call = callProbe(CLOSING);
    await entered.promise;
    pool.releaseMcpSessionBindings(CLOSING);
    proceed.resolve();
    const result = await call;

    expect(result.isError).not.toBe(true);
    expect(pool.resolveAutolockSessionForMcpSession(CLOSING)).toBeUndefined();
    // No connected owner: the session is foreign to no one, exactly as the close left it.
    expect(pool.isSessionOwnedByOtherConnection(sessionId, "an-unrelated-connection")).toBe(false);

    timer.advanceTime(OWNER_DISCONNECT_GRACE_MS);
    await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);
    expect(manager.getSession(sessionId)).toBeNull();
    expect(releaseReasons).toEqual([OWNER_DISCONNECTED_RELEASE_REASON]);
  });

  test("a connection still open when its call completes is recorded as the owner", async () => {
    const call = callProbe(CLOSING);
    await entered.promise;
    proceed.resolve();
    await call;

    expect(pool.resolveAutolockSessionForMcpSession(CLOSING)).toBe(sessionId);
    expect(pool.isSessionOwnedByOtherConnection(sessionId, "an-unrelated-connection")).toBe(true);

    timer.advanceTime(OWNER_DISCONNECT_GRACE_MS);
    await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);
    expect(manager.getSession(sessionId)).not.toBeNull();
  });
});

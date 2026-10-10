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
import type { BootedDevice } from "../../src/models";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
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

describe("a connection that closed while its explicit-sessionUuid call was in flight (#11348)", () => {
  let restoreHermeticServer: () => void;
  let restoreToolCallRepository: () => void;
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
  });

  beforeEach(async () => {
    previousAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
    restoreHermeticServer = installHermeticServerFixture();
    const original = Reflect.get(ToolRegistry, "toolCallRepository");
    Reflect.set(ToolRegistry, "toolCallRepository", { async recordToolCall(): Promise<void> {} });
    restoreToolCallRepository = () => Reflect.set(ToolRegistry, "toolCallRepository", original);

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
    fixture = new McpTestFixture({ daemonMode: true });
    await fixture.setup();
  });

  afterEach(async () => {
    await fixture?.teardown();
    fixture = undefined;
    DaemonState.getInstance().reset();
    manager.stopCleanupTimer();
    restoreToolCallRepository();
    restoreHermeticServer();
    if (previousAutolock === undefined) {
      delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    } else {
      process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = previousAutolock;
    }
  });

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

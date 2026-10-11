import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { INTERNAL_MCP_SESSION_PARAM } from "../../src/daemon/constants";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import {
  OWNER_DISCONNECT_GRACE_MS,
  OWNER_DISCONNECTED_RELEASE_REASON,
} from "../../src/daemon/ownerDisconnectRelease";
import { resetDbWriteBarrier } from "../../src/db/dbWriteBarrier";
import { NavigationGraphManager } from "../../src/features/navigation/NavigationGraphManager";
import type { BootedDevice } from "../../src/models";
import { executionTracker } from "../../src/server/executionTracker";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionRepository } from "../fakes/FakeDeviceSessionRepository";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { drainMicrotasks, FAKE_TIMER_QUIET_TURNS } from "../helpers/fakeTimerStepping";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";

/**
 * #11381 item 5, through the wiring instead of a copy of it: an inventory read naming a session
 * runs through the real `tools/call` entry (which classifies it as a plain read), under the
 * process execution tracker, against a real `Daemon`'s session manager, pool, owner-disconnect
 * port and tool-call-end subscription. When that read is the session's last call in flight, its
 * end retries the owner-disconnect release it deferred at once, on every way out of the call,
 * and is never use of the session.
 *
 * Whether a read should defer that release at all is an open owner question (#11381 item 1), so
 * nothing here asserts that the session is held while the read runs: only that the release is not
 * left waiting past the read's end.
 */
const DEVICE: BootedDevice = {
  name: "Pixel_8_API_35",
  deviceId: "emulator-5554",
  platform: "android",
};
const SESSION = "read-end-rearm-session";
const OWNER_CONNECTION = "read-end-rearm-owner";
const INVENTORY_READ = "__inventory_read_probe__";

/** The daemon's own subscription and its teardown, which `start()` and `stop()` run. */
interface DaemonToolCallEndWiring {
  subscribeToolCallEndActivity(): void;
  stopSessionTimers(): void;
}

describe("an inventory read is the last call in flight when its owner disconnects (#11381)", () => {
  let restoreHermeticServer: () => void;
  let fixture: McpTestFixture;
  let timer: FakeTimer;
  let daemon: Daemon;
  let releaseReasons: string[];
  let ends: Array<{ uuids: readonly string[]; admitted: boolean }>;
  let unsubscribeEnds: () => void;
  let entered: PromiseWithResolvers<void>;
  let outcome: PromiseWithResolvers<{ success: true }>;

  const settle = (ms: number) =>
    timer.advanceTimeAsync(ms, () => drainMicrotasks(FAKE_TIMER_QUIET_TURNS));

  // One whole cycle up front: the server module's cold import, tool registration and the first
  // Daemon and release are one-time module work, outside any test's budget.
  beforeAll(async () => {
    await arrange();
    const { call } = await readInFlightPastTheDisconnectGrace();
    outcome.resolve({ success: true });
    await call;
    await settle(0);
    await dismantle();
  });

  beforeEach(arrange);
  afterEach(dismantle);

  async function arrange(): Promise<void> {
    resetDbWriteBarrier();
    restoreHermeticServer = installHermeticServerFixture();
    timer = new FakeTimer();
    daemon = new Daemon(
      {},
      new FakeInstalledAppsRepository(),
      timer,
      new FakeDeviceSessionRepository(),
    );
    const sessionManager = daemon.getSessionManager();
    // Only the owner-disconnect release may end the session.
    sessionManager.stopCleanupTimer();
    releaseReasons = [];
    sessionManager.onSessionRelease((_sessionId, _deviceId, reason) => {
      releaseReasons.push(reason);
    });
    (daemon as unknown as DaemonToolCallEndWiring).subscribeToolCallEndActivity();
    ends = [];
    unsubscribeEnds = executionTracker.onSessionExecutionEnded((uuids, { admitted }) =>
      ends.push({ uuids, admitted }),
    );

    const devicePool = daemon.getDevicePool();
    const deviceManager = new FakeDeviceManager();
    deviceManager.bootedDevices = [DEVICE];
    Object.assign(devicePool, { deviceManager });
    await devicePool.initializeWithDevices([DEVICE]);
    await devicePool.bindOrReuseDeviceSession(
      SESSION,
      DEVICE.deviceId,
      "android",
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      OWNER_CONNECTION,
    );

    entered = Promise.withResolvers<void>();
    outcome = Promise.withResolvers<{ success: true }>();
    // A plain (not device-aware) read-only tool, as `listDevices` is registered.
    ToolRegistry.register(
      INVENTORY_READ,
      "inventory read probe",
      z.object({ sessionUuid: z.string().optional() }),
      async () => {
        entered.resolve();
        return await outcome.promise;
      },
      { readOnly: true },
    );
    fixture = new McpTestFixture({ daemonMode: true });
    await fixture.setup();
  }

  async function dismantle(): Promise<void> {
    await fixture.teardown();
    unsubscribeEnds();
    (daemon as unknown as DaemonToolCallEndWiring).stopSessionTimers();
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
    NavigationGraphManager.resetInstance();
    restoreHermeticServer();
    resetDbWriteBarrier();
  }

  /** The owner's inventory read is in flight when its connection closes and the grace runs out. */
  async function readInFlightPastTheDisconnectGrace() {
    const call = fixture.client.callTool({
      name: INVENTORY_READ,
      arguments: { sessionUuid: SESSION, [INTERNAL_MCP_SESSION_PARAM]: OWNER_CONNECTION },
    });
    await entered.promise;
    daemon.getDevicePool().releaseMcpSessionBindings(OWNER_CONNECTION);
    await settle(OWNER_DISCONNECT_GRACE_MS);
    // Wrapped: an async function returning the promise itself would wait for the call to end.
    return { call };
  }

  const exits: Array<[string, () => Promise<void>]> = [
    ["returns", async () => outcome.resolve({ success: true })],
    ["throws", async () => outcome.reject(new Error("inventory read failed"))],
    [
      "is cancelled",
      async () => {
        expect(await executionTracker.cancelToolExecutions(INVENTORY_READ, "test")).toBe(1);
        outcome.reject(new Error("The operation was aborted"));
      },
    ],
  ];

  test.each(exits)(
    "the read %s: the release is retried at once, and the end is not use",
    async (_name, endTheRead) => {
      const { call } = await readInFlightPastTheDisconnectGrace();
      const idleDeadline = daemon.getSessionManager().getSession(SESSION)?.expiresAt;
      const endedAt = timer.now();

      await endTheRead();
      await call;

      // Reported exactly once, and not as an admitted call: a read never extends its session.
      expect(ends).toEqual([{ uuids: [SESSION], admitted: false }]);
      expect(daemon.getSessionManager().getSession(SESSION)?.expiresAt).toBe(idleDeadline);

      // No time passes: the release does not wait for the veto's bound or a heartbeat scan.
      await settle(0);
      expect(timer.now()).toBe(endedAt);
      expect(releaseReasons).toEqual([OWNER_DISCONNECTED_RELEASE_REASON]);
      expect(daemon.getDevicePool().getDevice(DEVICE.deviceId)?.sessionId).toBeNull();
    },
  );
});

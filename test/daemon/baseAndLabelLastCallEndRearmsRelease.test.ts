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
import { buildDeviceLabelMap } from "../../src/server/deviceLabelMapping";
import { executionTracker } from "../../src/server/executionTracker";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionRepository } from "../fakes/FakeDeviceSessionRepository";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { drainMicrotasks, FAKE_TIMER_QUIET_TURNS } from "../helpers/fakeTimerStepping";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";
import { asPlanAllocation } from "../helpers/planLabelAllocation";

const PRIMARY: BootedDevice = { name: "Pixel A", deviceId: "emulator-5554", platform: "android" };
const LABELLED: BootedDevice = { name: "Pixel B", deviceId: "emulator-5556", platform: "android" };
const BASE = "last-call-base";
const DERIVED = `${BASE}:B`;
const OWNER = "last-call-owner";
const TOOL = "__base_and_label_last_control__";

/** Reach the daemon's own end subscription without starting sockets or device discovery. */
interface DaemonToolCallEndWiring {
  subscribeToolCallEndActivity(): void;
  stopSessionTimers(): void;
}

describe("base call ends retry deferred release and all orders finish with nothing waiting (#11381)", () => {
  let restoreHermeticServer: () => void;
  let fixture: McpTestFixture;
  let timer: FakeTimer;
  let daemon: Daemon;
  let releases: Array<{ sessionId: string; reason: string }>;
  let ends: Array<{ uuids: readonly string[]; admitted: boolean }>;
  let unsubscribeEnds: () => void;
  let entered: Map<string, PromiseWithResolvers<void>>;
  let outcomes: Map<string, PromiseWithResolvers<{ success: true }>>;

  const settle = (ms: number) =>
    timer.advanceTimeAsync(ms, () => drainMicrotasks(FAKE_TIMER_QUIET_TURNS));

  // Pay cold module and first-call costs once; each row still creates its own sessions and calls.
  beforeAll(async () => {
    await arrange();
    await endCallsAfterDisconnect([BASE, DERIVED]);
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
    const manager = daemon.getSessionManager();
    manager.stopCleanupTimer();
    releases = [];
    manager.onSessionRelease((sessionId, _deviceId, reason) => {
      releases.push({ sessionId, reason });
    });
    (daemon as unknown as DaemonToolCallEndWiring).subscribeToolCallEndActivity();
    ends = [];
    unsubscribeEnds = executionTracker.onSessionExecutionEnded((uuids, { admitted }) =>
      ends.push({ uuids, admitted }),
    );
    const pool = daemon.getDevicePool();
    const deviceManager = new FakeDeviceManager();
    deviceManager.bootedDevices = [PRIMARY, LABELLED];
    Object.assign(pool, { deviceManager });
    await pool.initializeWithDevices([PRIMARY, LABELLED]);
    await pool.bindOrReuseDeviceSession(
      BASE,
      PRIMARY.deviceId,
      "android",
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      OWNER,
    );
    manager.setDeviceLabels(BASE, buildDeviceLabelMap(["A", "B"], BASE));
    // A label session is minted only by its base's plan allocation (#11602).
    await asPlanAllocation(manager, BASE, [DERIVED], () =>
      pool.assignMultipleDevices([DERIVED], 1_000, "android"),
    );
    entered = new Map([BASE, DERIVED].map((id) => [id, Promise.withResolvers<void>()]));
    outcomes = new Map(
      [BASE, DERIVED].map((id) => [id, Promise.withResolvers<{ success: true }>()]),
    );
    // Plain control calls exercise the real MCP classification, with no read liveness policy.
    ToolRegistry.register(
      TOOL,
      "base and label last control probe",
      z.object({ sessionUuid: z.string() }),
      async (args: { sessionUuid: string }) => {
        entered.get(args.sessionUuid)!.resolve();
        return await outcomes.get(args.sessionUuid)!.promise;
      },
    );
    fixture = new McpTestFixture({ daemonMode: true });
    await fixture.setup();
  }

  async function dismantle(): Promise<void> {
    await fixture.teardown();
    ToolRegistry.unregister(TOOL);
    unsubscribeEnds();
    (daemon as unknown as DaemonToolCallEndWiring).stopSessionTimers();
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
    NavigationGraphManager.resetInstance();
    restoreHermeticServer();
    resetDbWriteBarrier();
  }

  async function startBlockedCall(sessionUuid: string) {
    const call = fixture.client.callTool({
      name: TOOL,
      arguments: { sessionUuid, [INTERNAL_MCP_SESSION_PARAM]: OWNER },
    });
    await entered.get(sessionUuid)!.promise;
    // An async helper must not adopt the promise while its handler is blocked.
    return { call };
  }

  async function endCallsAfterDisconnect(order: readonly string[]): Promise<number> {
    const calls = [];
    for (const sessionUuid of order) {
      calls.push((await startBlockedCall(sessionUuid)).call);
    }
    daemon.getDevicePool().releaseMcpSessionBindings(OWNER);
    const closedAt = timer.now();
    await settle(OWNER_DISCONNECT_GRACE_MS);
    const results = [];
    for (const [index, sessionUuid] of order.entries()) {
      outcomes.get(sessionUuid)!.resolve({ success: true });
      results.push(await calls[index]!);
      await settle(0);
    }
    for (const result of results) {
      expect(result.isError).not.toBe(true);
    }
    return closedAt;
  }

  test.each([
    { name: "label only", order: [DERIVED] },
    { name: "base only", order: [BASE] },
    { name: "base then label", order: [BASE, DERIVED] },
    { name: "label then base", order: [DERIVED, BASE] },
  ])("$name: nothing is left waiting once the last call has ended", async ({ order }) => {
    const closedAt = await endCallsAfterDisconnect(order);
    await settle(0);

    // The deferred owner-disconnect release is pending under the base id. In the three rows
    // with a base call, that call's end retries the release at once. The "label only" row holds
    // without the end event because a label call does not defer the base today. It is kept only
    // so all four orders end with nothing waiting. Whether a label call should defer the base
    // is an owner decision.
    expect(timer.now()).toBe(closedAt + OWNER_DISCONNECT_GRACE_MS);
    expect(releases.filter(({ sessionId }) => sessionId === BASE)).toEqual([
      { sessionId: BASE, reason: OWNER_DISCONNECTED_RELEASE_REASON },
    ]);
    expect(daemon.getSessionManager().getSession(BASE)).toBeNull();
    expect(daemon.getSessionManager().getSession(DERIVED)).toBeNull();
    expect(ends).toEqual(order.map((id) => ({ uuids: [id], admitted: true })));
  });
});

import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { INTERNAL_MCP_SESSION_PARAM } from "../../src/daemon/constants";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { DEVICE_OWNED_BY_OTHER_SESSION_CODE } from "../../src/daemon/inputDeviceOwnership";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import { buildDeviceLabelMap } from "../../src/server/deviceLabelMapping";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { logger } from "../../src/utils/logger";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { drainMicrotasks, FAKE_TIMER_QUIET_TURNS } from "../helpers/fakeTimerStepping";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";
import { asPlanAllocation } from "../helpers/planLabelAllocation";
import { RealToolCallPath } from "../helpers/realToolCallPath";

// #11602: a connection whose MCP server is bound to the base session, or to one of its labels,
// names another live session of the same plan. The server here is built as the daemon builds one for a client that
// speaks streamable HTTP to it directly (`Daemon` passes `sessionContext` with the transport's
// session id and `daemonMode: true`): one server for the whole connection, so the binding its
// first call records is still there for the next. A proxied client never reaches this state: the
// daemon socket gives every explicitly named session its own loopback server, seeded with it.

const primary: BootedDevice = { name: "Pixel A", deviceId: "emulator-5554", platform: "android" };
const labelled: BootedDevice = { name: "Pixel B", deviceId: "emulator-5556", platform: "android" };
const third: BootedDevice = { name: "Pixel C", deviceId: "emulator-5558", platform: "android" };
const BASE = "sess-a";
const DERIVED = `${BASE}:B`;
const OWNER = "conn-1";
const OTHER = "conn-2";
const BOUND_TO_OTHER_SESSION = /MCP connection is bound to device session/;

function wire(result: { content?: unknown }): Record<string, unknown> {
  const content = result.content as { text: string }[];
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

function errorText(result: { content?: unknown }): string {
  return (result.content as { text: string }[])[0].text;
}

describe("a connection bound to the base session naming its own derived label session", () => {
  let timer: FakeTimer;
  let manager: SessionManager;
  let pool: DevicePool;
  let tools: RealToolCallPath;
  let fixtures: McpTestFixture[];
  let spies: Array<ReturnType<typeof spyOn>>;
  let previousAutolock: string | undefined;

  beforeAll(async () => {
    // Pay the server module's cold import outside any test's budget.
    const restore = installHermeticServerFixture();
    const warm = new McpTestFixture({ daemonMode: true });
    await warm.setup();
    await warm.teardown();
    restore();
  });

  /** One connection's server, as the daemon creates it for a direct streamable-HTTP client. */
  async function connection(
    sessionContext: NonNullable<ConstructorParameters<typeof McpTestFixture>[0]>["sessionContext"],
  ): Promise<McpTestFixture> {
    const fixture = new McpTestFixture({ daemonMode: true, sessionContext });
    await fixture.setup();
    fixtures.push(fixture);
    return fixture;
  }

  /** A tool-error result, or the protocol error the ingress answered instead, as its text. */
  const tap = (fixture: McpTestFixture, args: Record<string, unknown>) =>
    fixture.client
      .callTool({
        name: "tapAt",
        arguments: { x: 10, y: 10, [INTERNAL_MCP_SESSION_PARAM]: OWNER, ...args },
      })
      .catch((error: unknown) => ({
        isError: true,
        content: [{ type: "text", text: (error as Error).message }],
      }));

  async function setUp(): Promise<void> {
    previousAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    fixtures = [];
    spies = [
      spyOn(logger, "info").mockImplementation(() => {}),
      spyOn(logger, "warn").mockImplementation(() => {}),
      spyOn(logger, "error").mockImplementation(() => {}),
    ];
    timer = new FakeTimer();
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), () => {
      return new FakeDbWriteBarrier();
    });
    manager.stopCleanupTimer();
    const discovery = new FakeDeviceUtils();
    discovery.setBootedDevices("android", [primary, labelled, third]);
    discovery.setBootedDevices("ios", []);
    PlatformDeviceManagerFactory.setInstance(discovery);
    pool = new DevicePool(
      createDevicePoolDependencies(manager, "own-label-session-daemon", {
        timer,
        deviceManager: discovery,
      }),
    );
    await pool.initializeWithDevices([primary, labelled, third]);
    DaemonState.getInstance().initialize(manager, pool, new DeviceSessionRegistry(timer));
    tools = new RealToolCallPath([primary, labelled, third]).install();
    // OWNER acquires the base, then its plan publishes the label map and allocates label B, as
    // PlanExecutionOrchestrator.allocateDevices does.
    await pool.bindOrReuseDeviceSession(
      BASE,
      primary.deviceId,
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
    manager.setDeviceLabels(BASE, buildDeviceLabelMap(["A", "B", "C"], BASE));
    await asPlanAllocation(manager, BASE, [DERIVED], () =>
      pool.assignMultipleDevices([DERIVED], 1_000, "android"),
    );
  }

  async function tearDown(): Promise<void> {
    for (const fixture of fixtures) {
      await fixture.teardown();
    }
    tools.uninstall();
    PlatformDeviceManagerFactory.setInstance(null);
    DaemonState.getInstance().reset();
    manager.stopCleanupTimer();
    for (const spy of spies) {
      spy.mockRestore();
    }
    if (previousAutolock === undefined) {
      delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    } else {
      process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = previousAutolock;
    }
  }

  /** One daemon per scenario, built and torn down by the scenario itself. */
  const scenario = (body: () => Promise<void>) => async (): Promise<void> => {
    await setUp();
    try {
      await body();
    } finally {
      await tearDown();
    }
  };

  test(
    "its call on the derived session runs on the labelled device",
    scenario(async () => {
      const owner = await connection({ sessionId: "http-owner" });
      // The first call binds this connection's server to the base session.
      expect((await tap(owner, { sessionUuid: BASE })).isError).not.toBe(true);

      const result = await tap(owner, { sessionUuid: DERIVED });

      expect(result.isError).not.toBe(true);
      expect(tools.runs.map((run) => run.deviceId)).toEqual([primary.deviceId, labelled.deviceId]);
      // Like any session a connection has run a call on, the label is now one of its own beside
      // the base: both stay routable, and a session that is neither is still refused.
      expect((await tap(owner, { sessionUuid: BASE })).isError).not.toBe(true);
      expect((await tap(owner, { sessionUuid: DERIVED })).isError).not.toBe(true);
      expect(tools.runs.map((run) => run.deviceId).slice(2)).toEqual([
        primary.deviceId,
        labelled.deviceId,
      ]);
      expect(errorText(await tap(owner, { sessionUuid: "sess-b" }))).toMatch(
        BOUND_TO_OTHER_SESSION,
      );
    }),
  );

  test(
    "its call naming only the label is refused with the end of a base past its idle deadline (#11640)",
    scenario(async () => {
      const released: Array<[string, string]> = [];
      manager.onSessionRelease((sessionId, _deviceId, reason) => {
        released.push([sessionId, reason]);
      });
      const owner = await connection({ sessionId: "http-owner" });
      // The connection's first call binds it to the base and starts the base's idle window.
      await tap(owner, { sessionUuid: BASE });
      const idleMs = manager.peekSession(BASE)!.sessionTimeoutMs;
      // The label is used half way through the base's idle window, so only the base runs out.
      timer.advanceTime(idleMs / 2);
      expect((await tap(owner, { sessionUuid: DERIVED })).isError).not.toBe(true);
      timer.advanceTime(idleMs / 2 + 1);
      expect(manager.peekSession(BASE)).toBeNull();

      // Tool selection and the call's own routing both look the label's base up, and release
      // nothing: the label is simply no live session any more.
      expect(manager.peekSession(DERIVED)).toBeNull();
      expect(released).toEqual([]);
      const ranBefore = tools.runs.length;

      // The base's end ends its labels: the owner's own call is refused as a call naming the
      // ended base would be, and that refused admission is what releases the base.
      const result = await tap(owner, { sessionUuid: DERIVED });
      await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);

      expect(result.isError).toBe(true);
      expect(wire(result).error).toMatchObject({
        code: "session_ownership_lost",
        sessionUuid: DERIVED,
        reason: "cleanup-expired",
        nextAction: "acquire_new_session",
      });
      expect(tools.runs.length).toBe(ranBefore);
      expect(released[0]).toEqual([BASE, "cleanup-expired"]);
    }),
  );

  test(
    "a name that is not one of the base's published labels is still refused",
    scenario(async () => {
      const owner = await connection({ sessionId: "http-owner" });
      await tap(owner, { sessionUuid: BASE });

      for (const sessionUuid of [`${BASE}:Z`, "sess-b", `${BASE}:B:nested`]) {
        const result = await tap(owner, { sessionUuid });

        expect(result.isError).toBe(true);
        expect(errorText(result)).toMatch(BOUND_TO_OTHER_SESSION);
      }
      expect(tools.runs.map((run) => run.deviceId)).toEqual([primary.deviceId]);
    }),
  );

  test(
    "a published label that was never allocated takes no device",
    scenario(async () => {
      const owner = await connection({ sessionId: "http-owner" });
      await tap(owner, { sessionUuid: BASE });

      const result = await tap(owner, { sessionUuid: `${BASE}:C` });

      expect(result.isError).toBe(true);
      expect(manager.getSession(`${BASE}:C`)).toBeNull();
      expect(tools.runs.map((run) => run.deviceId)).toEqual([primary.deviceId]);
    }),
  );

  test(
    "another connection's call on that derived session is refused by the owner rule",
    scenario(async () => {
      const owner = await connection({ sessionId: "http-owner" });
      await tap(owner, { sessionUuid: BASE });

      // The same server forwards a call that carries another connection's identity.
      const result = await tap(owner, {
        sessionUuid: DERIVED,
        [INTERNAL_MCP_SESSION_PARAM]: OTHER,
      });

      expect(result.isError).toBe(true);
      expect(wire(result).code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
      expect(tools.runs.map((run) => run.deviceId)).toEqual([primary.deviceId]);
    }),
  );

  test(
    "once bound to a label it still reaches the plan's other labels and its base",
    scenario(async () => {
      await asPlanAllocation(manager, BASE, [`${BASE}:C`], () =>
        pool.assignMultipleDevices([`${BASE}:C`], 1_000, "android"),
      );
      const owner = await connection({ sessionId: "http-owner" });
      await tap(owner, { sessionUuid: BASE });
      // A successful call moves the connection's binding to the session it named.
      await tap(owner, { sessionUuid: DERIVED });

      const sibling = await tap(owner, { sessionUuid: `${BASE}:C` });
      const base = await tap(owner, { sessionUuid: BASE });

      expect(sibling.isError).not.toBe(true);
      expect(base.isError).not.toBe(true);
      expect(tools.runs.map((run) => run.deviceId).slice(2)).toEqual([
        third.deviceId,
        primary.deviceId,
      ]);
    }),
  );

  test(
    "a connection that first named a label reaches the label's base, and nothing else",
    scenario(async () => {
      const label = await connection({ sessionId: "http-label" });
      await tap(label, { sessionUuid: DERIVED });

      const result = await tap(label, { sessionUuid: BASE });

      expect(result.isError).not.toBe(true);
      expect(tools.runs.map((run) => run.deviceId)).toEqual([labelled.deviceId, primary.deviceId]);
      expect(errorText(await tap(label, { sessionUuid: "sess-b" }))).toMatch(
        BOUND_TO_OTHER_SESSION,
      );
    }),
  );

  test(
    "a label published under a label is reached from the outermost base, and reaches it",
    scenario(async () => {
      const nested = `${DERIVED}:C`;
      manager.setDeviceLabels(DERIVED, { B: DERIVED, C: nested });
      await asPlanAllocation(manager, DERIVED, [nested], () =>
        pool.assignMultipleDevices([nested], 1_000, "android"),
      );
      const owner = await connection({ sessionId: "http-owner" });
      await tap(owner, { sessionUuid: BASE });

      const down = await tap(owner, { sessionUuid: nested });
      const up = await tap(owner, { sessionUuid: BASE });

      expect(down.isError).not.toBe(true);
      expect(up.isError).not.toBe(true);
      expect(tools.runs.map((run) => run.deviceId)).toEqual([
        primary.deviceId,
        third.deviceId,
        primary.deviceId,
      ]);
    }),
  );

  /** `setActiveDevice` naming `sessionUuid` for the idle third device, with or without identity. */
  const select = (fixture: McpTestFixture, sessionUuid: string, identity?: string) =>
    fixture.client
      .callTool({
        name: "setActiveDevice",
        arguments: {
          deviceId: third.deviceId,
          platform: "android",
          sessionUuid,
          ...(identity ? { [INTERNAL_MCP_SESSION_PARAM]: identity } : {}),
        },
      })
      .catch((error: unknown) => ({
        isError: true,
        content: [{ type: "text", text: (error as Error).message }],
      }));

  test.each([
    { name: "a name the base never published", label: "Z" },
    { name: "a published label the plan has not allocated", label: "C" },
  ])(
    "a bind with no connection identity cannot mint a label session of the base: $name",
    ({ label }) =>
      scenario(async () => {
        const anonymous = await connection({});

        const result = await select(anonymous, `${BASE}:${label}`);

        expect(result.isError).toBe(true);
        expect(errorText(result)).toMatch(/cannot be reused/);
        expect(manager.hasSession(`${BASE}:${label}`)).toBe(false);
        expect(pool.getDevice(third.deviceId)?.sessionId).toBeNull();
        // No fence is left behind: the plan's own allocation mints the name afterwards.
        const close = manager.openPlanLabelMints(BASE, { [label]: `${BASE}:${label}` });
        await pool.assignMultipleDevices([`${BASE}:${label}`], 1_000, "android").finally(close);
        expect(pool.getDevice(third.deviceId)?.sessionId).toBe(`${BASE}:${label}`);
      })(),
  );

  test(
    "a caller-chosen session id that contains ':' and names no live base is bound as before",
    scenario(async () => {
      const anonymous = await connection({});

      const result = await select(anonymous, "team:run");

      expect(result.isError).not.toBe(true);
      expect(pool.getDevice(third.deviceId)?.sessionId).toBe("team:run");
    }),
  );

  test(
    "a connection seeded with the base names its plan's live label, and nothing else",
    scenario(async () => {
      const seeded = await connection({ sessionId: "seeded", initialSessionToolBinding: BASE });

      const result = await tap(seeded, { sessionUuid: DERIVED });

      expect(result.isError).not.toBe(true);
      expect(tools.runs.map((run) => run.deviceId)).toEqual([labelled.deviceId]);
      for (const sessionUuid of [`${BASE}:Z`, `${BASE}:C`, "sess-b"]) {
        expect(errorText(await tap(seeded, { sessionUuid }))).toMatch(BOUND_TO_OTHER_SESSION);
      }
      expect(tools.runs).toHaveLength(1);
    }),
  );

  test(
    "the proxied route, a loopback server seeded with the derived session, runs",
    scenario(async () => {
      const loopback = await connection({
        sessionId: "loopback",
        initialSessionToolBinding: DERIVED,
      });

      const result = await tap(loopback, { sessionUuid: DERIVED });

      expect(result.isError).not.toBe(true);
      expect(tools.runs.map((run) => run.deviceId)).toEqual([labelled.deviceId]);
    }),
  );
});

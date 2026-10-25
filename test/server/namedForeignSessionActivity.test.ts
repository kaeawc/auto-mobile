import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  INTERNAL_EXECUTION_ID_PARAM,
  INTERNAL_EXECUTION_START_TIME_PARAM,
  INTERNAL_MCP_SESSION_PARAM,
} from "../../src/daemon/wire/constants";
import { handleDaemonRequest } from "../../src/daemon/daemonRequestHandlers";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { SessionManager } from "../../src/daemon/sessionManager";
import { subscribeToolCallEndActivity } from "../../src/daemon/toolCallActivity";
import type { BootedDevice } from "../../src/models";
import { executionTracker } from "../../src/daemon/executionTracker";
import { ToolRegistry, type RegisteredTool } from "../../src/server/toolRegistry";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { logger } from "../../src/utils/logger";
import { serverConfig } from "../../src/utils/ServerConfig";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";
import { RealToolCallPath } from "../helpers/realToolCallPath";

const held: BootedDevice = { name: "Pixel A", deviceId: "emulator-5554", platform: "android" };
const free: BootedDevice = { name: "Pixel B", deviceId: "emulator-5556", platform: "android" };
/** A device no session holds. */
const spare: BootedDevice = { name: "Pixel C", deviceId: "emulator-5558", platform: "android" };
const HOLDER = "sess-a";
/** A live session no connection owns: its acquiring call carried no connection identity. */
const OWNERLESS = "sess-ownerless";
const OWNER = "conn-1";
const OTHER = "conn-2";

type Args = Record<string, unknown>;

/**
 * One schema-valid call per plain tool (two for a tool classified per call), each naming the
 * session. The first test below fails when the server registers a plain tool this table lacks.
 */
const PLAIN_TOOL_CALLS: Record<string, Args[]> = {
  setActiveDevice: [{ deviceId: free.deviceId, platform: "android" }],
  listDeviceImages: [{ platform: "android" }],
  listDevices: [{}],
  getAndroid: [{ avdName: "Pixel_A" }],
  getApple: [{ udid: "SIM-UDID" }],
  startDevice: [{ platform: "android", name: "Pixel_A" }],
  provisionDevice: [
    {
      device: {
        platform: "android",
        name: "Pixel_A",
        spec: { runtime: "system-images;android-35;google_apis;arm64-v8a", deviceType: "pixel_9" },
      },
    },
  ],
  killDevice: [{ device: free }],
  deleteDevice: [
    {
      target: { platform: "android", isVirtual: true, stableId: "Pixel_B" },
      mode: "destroy",
      verifyAbsence: true,
    },
  ],
  exportPlan: [{}],
  recordToolCalls: [{ action: "status" }, { action: "begin" }, { action: "end" }],
  getIosSimulatorCapabilities: [{ deviceType: "iPhone 16", runtime: "iOS 18.0" }],
  setToolEnabled: [{ toolName: "tapOn", enabled: false }],
};
const PLAIN_TOOL_CASES = Object.entries(PLAIN_TOOL_CALLS).flatMap(([name, calls]) =>
  calls.map((args) => ({ name, args, title: `${name} ${JSON.stringify(args)}` })),
);

/**
 * #11555: naming a session is not use of it. Only the session's own client, or a control call
 * that actually runs on the session, restarts its idle window; while another connected client
 * owns the session, no call from this connection moves its activity clocks, at its start or at
 * its end, and none binds this connection to it. Every plain tool is driven through the real MCP
 * ingress (its handler stubbed at the registry); device reads run the real device pipeline.
 */
describe("what counts as use of a named session (#11555, #11558)", () => {
  let timer: FakeTimer;
  let manager: SessionManager;
  let pool: DevicePool;
  let tools: RealToolCallPath;
  let fixture: McpTestFixture | undefined;
  let unsubscribe: () => void;
  let spies: Array<ReturnType<typeof spyOn>>;
  let previousAutolock: string | undefined;
  /** Stubbed plain handlers that ran. */
  let handled: string[];
  /** What a stubbed plain handler does while it runs, standing in for the tool's work. */
  let onPlainToolBody: (() => void) | undefined;

  const clocks = (sessionUuid = HOLDER) => {
    const session = manager.getSession(sessionUuid)!;
    return {
      lastUsedAt: session.lastUsedAt,
      lastHeartbeat: session.lastHeartbeat,
      expiresAt: session.expiresAt,
      ownership: session.ownership,
    };
  };
  const call = (name: string, args: Args, connection: string | undefined, sessionUuid = HOLDER) =>
    fixture!.client.callTool({
      name,
      arguments: {
        ...args,
        sessionUuid,
        ...(connection ? { [INTERNAL_MCP_SESSION_PARAM]: connection } : {}),
      },
    });
  /** A device-aware tool's registered handler under a tracked execution, as the ingress runs it. */
  const runDeviceTool = async (tool: RegisteredTool, args: Args): Promise<void> => {
    const execution = executionTracker.startExecution(tool.name, OTHER, HOLDER);
    try {
      await tool.handler(
        {
          ...args,
          [INTERNAL_EXECUTION_ID_PARAM]: execution.id,
          [INTERNAL_EXECUTION_START_TIME_PARAM]: execution.startTime,
        },
        undefined,
        execution.abortController.signal,
      );
    } finally {
      executionTracker.endExecution(execution.id);
    }
  };
  const plainTools = (): RegisteredTool[] =>
    ToolRegistry.getEveryRegisteredTool().filter((tool) => !tool.requiresDevice);

  beforeAll(async () => {
    // Pay the server module's cold import outside any test's budget.
    const restore = installHermeticServerFixture();
    const warm = new McpTestFixture({ daemonMode: true });
    await warm.setup();
    await warm.teardown();
    restore();
  });

  async function arrangeHarness(): Promise<void> {
    previousAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    spies = [
      spyOn(logger, "info").mockImplementation(() => {}),
      spyOn(logger, "warn").mockImplementation(() => {}),
      spyOn(logger, "error").mockImplementation(() => {}),
    ];
    timer = new FakeTimer();
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
      barrier: () => {
        return new FakeDbWriteBarrier();
      },
    });
    manager.stopCleanupTimer();
    const discovery = new FakeDeviceUtils();
    discovery.setBootedDevices("android", [held, free, spare]);
    discovery.setBootedDevices("ios", []);
    PlatformDeviceManagerFactory.setInstance(discovery);
    pool = new DevicePool(
      createDevicePoolDependencies(manager, "named-foreign-session-daemon", {
        timer,
        deviceManager: discovery,
      }),
    );
    await pool.initializeWithDevices([held, free, spare]);
    DaemonState.getInstance().initialize(manager, pool, new DeviceSessionRegistry(timer));
    unsubscribe = subscribeToolCallEndActivity(executionTracker, manager, pool);
    tools = new RealToolCallPath([held, free, spare]).install();
    await pool.bindOrReuseDeviceSession({
      sessionId: HOLDER,
      deviceId: held.deviceId,
      platform: "android",
      allowSessionRebind: false,
      mcpSessionId: OWNER,
    });
    manager.setDeviceReadiness(HOLDER, "automationReady");
    await pool.bindOrReuseDeviceSession({
      sessionId: OWNERLESS,
      deviceId: free.deviceId,
      platform: "android",
    });
    fixture = new McpTestFixture({ daemonMode: true });
    await fixture.setup();
    // The server registered its real tools. A plain tool's handler is its device work: stub it,
    // so only the ingress (classification, refusal, admission, the execution's end) is real.
    handled = [];
    onPlainToolBody = undefined;
    for (const tool of plainTools()) {
      tool.handler = async () => {
        handled.push(tool.name);
        onPlainToolBody?.();
        return { content: [{ type: "text", text: JSON.stringify({ success: true }) }] };
      };
    }
  }

  // Builds the DevicePool harness inside each test, so its cost is paid honestly in the test body.
  function arranged(name: string, fn: () => void | Promise<void>, timeout?: number): void {
    test(
      name,
      async () => {
        await arrangeHarness();
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
          await arrangeHarness();
          await fn(row);
        },
        timeout,
      );
    };
  }

  afterEach(async () => {
    await fixture?.teardown();
    fixture = undefined;
    unsubscribe();
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
  });

  arranged(
    "the table covers every plain tool the server registers, with schema-valid calls",
    () => {
      const registered = plainTools();

      expect(Object.keys(PLAIN_TOOL_CALLS).sort()).toEqual(
        registered.map((tool) => tool.name).sort(),
      );
      const invalid = registered.flatMap((tool) =>
        PLAIN_TOOL_CALLS[tool.name]
          .filter((args) => !tool.schema.safeParse(args).success)
          .map((args) => `${tool.name} ${JSON.stringify(args)}`),
      );
      expect(invalid).toEqual([]);
    },
  );

  describe("from a connection that does not own the session", () => {
    arrangedEach(PLAIN_TOOL_CASES)(
      "$title neither extends nor binds it",
      async ({ name, args }) => {
        const before = clocks();
        timer.advanceTime(60_000);

        await call(name, args, OTHER);

        expect(clocks()).toEqual(before);
        expect(pool.isSessionOwnedByOtherConnection(HOLDER, OTHER)).toBe(true);
        expect(pool.isSessionOwnedByOtherConnection(HOLDER, OWNER)).toBe(false);
      },
    );

    arranged(
      "setToolEnabled still runs: editing another session's tool profile is intended",
      async () => {
        const result = await call("setToolEnabled", { toolName: "tapOn", enabled: false }, OTHER);

        expect(result.isError).not.toBe(true);
        expect(handled).toEqual(["setToolEnabled"]);
      },
    );

    arranged("every device read runs and neither extends nor binds it", async () => {
      const reads = ToolRegistry.getEveryRegisteredTool().filter(
        (tool) => tool.requiresDevice && tool.deviceReadOnly === true,
      );
      expect(reads.length).toBeGreaterThan(10);
      const before = clocks();
      timer.advanceTime(60_000);

      const failures: string[] = [];
      for (const tool of reads) {
        await runDeviceTool(tool, {
          sessionUuid: HOLDER,
          platform: "android",
          [INTERNAL_MCP_SESSION_PARAM]: OTHER,
        }).catch((error: unknown) => failures.push(`${tool.name}: ${String(error)}`));
      }

      expect(failures).toEqual([]);
      expect(tools.runs.map((run) => run.name).sort()).toEqual(
        reads.map((tool) => tool.name).sort(),
      );
      expect(clocks()).toEqual(before);
      expect(pool.isSessionOwnedByOtherConnection(HOLDER, OTHER)).toBe(true);
    });
  });

  describe("the session's own use still counts", () => {
    arrangedEach(["setToolEnabled", "killDevice", "exportPlan"])(
      "the owner's %s naming its session restarts the idle window",
      async (name) => {
        const before = clocks();
        timer.advanceTime(60_000);

        await call(name, PLAIN_TOOL_CALLS[name][0], OWNER);

        expect(handled).toEqual([name]);
        expect(clocks().lastUsedAt).toBe(before.lastUsedAt + 60_000);
        expect(clocks().expiresAt).toBe(before.expiresAt + 60_000);
      },
    );

    arranged(
      "a session no connection owns is still used by a call that names it, as before",
      async () => {
        expect(pool.isSessionOwnedByOtherConnection(OWNERLESS, OTHER)).toBe(false);
        const before = clocks(OWNERLESS);
        timer.advanceTime(60_000);

        await call("setToolEnabled", PLAIN_TOOL_CALLS.setToolEnabled[0], OTHER, OWNERLESS);

        expect(clocks(OWNERLESS).lastUsedAt).toBe(before.lastUsedAt + 60_000);
      },
    );

    arranged("a caller with no connection identity is not told apart from the owner", async () => {
      const before = clocks();
      timer.advanceTime(60_000);

      await call("setToolEnabled", PLAIN_TOOL_CALLS.setToolEnabled[0], undefined);

      expect(clocks().lastUsedAt).toBe(before.lastUsedAt + 60_000);
    });
  });

  /**
   * #11558: one rule for what counts as use of a session. A call moves the session's activity
   * clocks only if it is a control call that passed every refusal: it is stamped when it is
   * admitted and again when it ends. A refused call moves nothing, at either point: admission's
   * own refusals (suspect, lapsed, expired) stamp nothing, and every other refusal runs before
   * admission. Each row drives the real MCP ingress and the real device-tool pipeline; only the
   * device boundary is fake.
   */
  describe("only an admitted control call is use; a refused one moves nothing (#11558)", () => {
    interface RefusedCall {
      title: string;
      refusal: RegExp;
      name?: string;
      args?: Args;
      connection?: string;
      /** Puts the daemon in the refusing state; returns how to leave it. */
      arrange?: () => (() => void) | void | Promise<(() => void) | void>;
    }
    const failing = (message: string) => () => {
      throw new Error(message);
    };
    /** The refusals between ingress and the stamp, in the order the call path reaches them. */
    const REFUSED_CALLS: RefusedCall[] = [
      { title: "a tool the server does not have", name: "noSuchTool", refusal: /Unknown tool/ },
      {
        title: "a tool gated off on this daemon",
        name: "sqlQuery",
        arrange: () => {
          serverConfig.setEmbeddedSdkEnabled(false);
          return () => serverConfig.setEmbeddedSdkEnabled(true);
        },
        refusal: /Unknown tool: sqlQuery. embedded SDK mode is disabled/,
      },
      {
        title: "arguments that fail the tool's schema",
        name: "tapOn",
        args: { platform: "android", text: 5 },
        refusal: /Invalid parameters for tool tapOn/,
      },
      {
        title: "a plain control tool whose arguments fail its schema",
        name: "killDevice",
        args: {},
        refusal: /Invalid parameters for tool killDevice/,
      },
      {
        title: "the owner rule: another connected client owns the session",
        connection: OTHER,
        refusal: /owned by another connected client/,
      },
      {
        title: "a daemon restart is pending",
        arrange: () => {
          expect(executionTracker.prepareForDaemonRestart()).toBe("accepted");
          return () => executionTracker.clearDaemonRestartPreparation();
        },
        refusal: /daemon_restart_pending/,
      },
      {
        title: "a device label the session does not have",
        args: { platform: "android", device: "tablet" },
        refusal: /Unknown device label 'tablet'|device label/i,
      },
      {
        title: "a deviceId another session holds",
        args: { platform: "android", deviceId: free.deviceId },
        refusal: /is held by another session/,
      },
      {
        title: "the session's owner missed its heartbeat lease (suspect)",
        arrange: async () => {
          const claim = await handleDaemonRequest(
            {
              id: "heartbeat",
              type: "daemon_request",
              method: "daemon/heartbeat",
              params: {
                sessionId: HOLDER,
                livenessOwnerToken: "owner-token",
                claimLivenessOwnership: true,
              },
            },
            DaemonState.getInstance(),
          );
          expect(claim.success).toBe(true);
          timer.advanceTime(SessionManager.DEFAULT_HEARTBEAT_TIMEOUT_MS + 1);
          expect(manager.getSessionLeaseState(HOLDER)?.phase).toBe("suspect");
        },
        refusal: /missed a liveness heartbeat/,
      },
      {
        title: "a deviceId that is not the session's device (device_outside_bound_session)",
        args: { platform: "android", deviceId: spare.deviceId },
        refusal: /device_outside_bound_session/,
      },
      {
        title: "the session's device is not ready for automation (lost, recovering, shutting down)",
        arrange: () => {
          const gate = spyOn(pool, "assertSessionReadyForAutomation").mockImplementation(
            failing("device is shutting down"),
          );
          return () => gate.mockRestore();
        },
        refusal: /device is shutting down/,
      },
    ];

    /**
     * Not refusals: the call was admitted and the daemon began device work for it, which then
     * failed before the tool body ran. An admitted call that fails still used its session
     * (#10824), and its error still names the session it ran on, which is how a client's proxy
     * binds it. Pinned here so the line between "refused" and "admitted, then failed" is explicit.
     */
    const FAILED_AFTER_ADMISSION: RefusedCall[] = [
      {
        title: "device setup for the call fails",
        arrange: () => {
          const setup = spyOn(manager, "trackSessionSetup").mockImplementation(async () =>
            failing("accessibility service did not start")(),
          );
          return () => setup.mockRestore();
        },
        refusal: /accessibility service did not start/,
      },
      {
        title: "the call is cancelled after device setup, before its tool body",
        arrange: () => {
          const original = manager.trackSessionSetup.bind(manager);
          const setup = spyOn(manager, "trackSessionSetup").mockImplementation(
            async (session, run) => {
              const result = await original(session, run);
              void executionTracker.cancelSessionUuidExecutions(HOLDER);
              return result;
            },
          );
          return () => setup.mockRestore();
        },
        refusal: /cancel|abort/i,
      },
    ];

    /** Whether each tracked call's end was reported as use of its session. */
    let ends: boolean[];
    let stopListening: () => void;

    beforeEach(() => {
      ends = [];
      stopListening = executionTracker.onSessionExecutionEnded((_sessions, end) => {
        ends.push(end.admitted);
      });
    });

    afterEach(() => {
      stopListening();
    });

    /** What the caller was told: the error result's text, or the protocol error's message. */
    const outcomeOf = async (calling: Promise<Awaited<ReturnType<typeof call>>>) => {
      try {
        const result = await calling;
        return { refused: result.isError === true, text: JSON.stringify(result.content) };
      } catch (error) {
        return { refused: true, text: String(error) };
      }
    };

    arrangedEach(REFUSED_CALLS)("refused: $title moves nothing", async (row) => {
      timer.advanceTime(60_000);
      const leave = await row.arrange?.();
      const before = clocks();

      const outcome = await outcomeOf(
        call(
          row.name ?? "homeScreen",
          row.args ?? { platform: "android" },
          "connection" in row ? row.connection : OWNER,
        ),
      );
      leave?.();

      expect(outcome.refused).toBe(true);
      expect(outcome.text).toMatch(row.refusal);
      // No tool body ran, on a device or in a plain handler.
      expect(tools.runs).toEqual([]);
      expect(handled).toEqual([]);
      // Neither stamp point fired. The call arrived 60 s after the last use, so an admission
      // stamp would show in the clocks; and the call's end was not reported as use.
      expect(ends).not.toContain(true);
      expect(clocks()).toEqual(before);
    });

    arrangedEach(FAILED_AFTER_ADMISSION)("admitted, then failed: $title is use", async (row) => {
      const before = clocks();
      timer.advanceTime(60_000);
      const leave = await row.arrange?.();

      const outcome = await outcomeOf(call("homeScreen", { platform: "android" }, OWNER));
      leave?.();

      expect(outcome.refused).toBe(true);
      expect(outcome.text).toMatch(row.refusal);
      expect(tools.runs).toEqual([]);
      expect(ends).toEqual([true]);
      expect(clocks().lastUsedAt).toBe(before.lastUsedAt + 60_000);
    });

    const ADMITTED_CALLS: Array<{ title: string; name: string; args: Args; connection?: string }> =
      [
        {
          title: "a device tool",
          name: "homeScreen",
          args: { platform: "android" },
          connection: OWNER,
        },
        {
          title: "a device tool naming the session's own device",
          name: "homeScreen",
          args: { platform: "android", deviceId: held.deviceId },
          connection: OWNER,
        },
        {
          title: "a device tool from a caller with no connection identity",
          name: "homeScreen",
          args: { platform: "android" },
        },
        {
          title: "a plain control tool",
          name: "killDevice",
          args: PLAIN_TOOL_CALLS.killDevice[0],
          connection: OWNER,
        },
      ];

    arrangedEach(ADMITTED_CALLS)(
      "admitted: $title is stamped when admitted and when it ends",
      async ({ name, args, connection }) => {
        const before = clocks();
        timer.advanceTime(60_000);
        let atBody: ReturnType<typeof clocks> | undefined;
        const body = () => {
          atBody = clocks();
          timer.advanceTime(5_000);
        };
        tools.setBody(async () => {
          body();
          return { content: [{ type: "text", text: JSON.stringify({ success: true }) }] };
        });
        onPlainToolBody = body;

        const result = await call(name, args, connection);

        expect(result.isError).not.toBe(true);
        // Admission: the idle window restarted before the body ran.
        expect(atBody?.lastUsedAt).toBe(before.lastUsedAt + 60_000);
        expect(atBody?.expiresAt).toBe(before.expiresAt + 60_000);
        // End: idleness counts from the end of the call.
        expect(ends).toEqual([true]);
        expect(clocks().lastUsedAt).toBe(before.lastUsedAt + 65_000);
        expect(clocks().expiresAt).toBe(before.expiresAt + 65_000);
      },
    );

    arranged(
      "a nested step is judged alone: a refused one moves nothing, an admitted one stamps",
      async () => {
        const before = clocks();
        timer.advanceTime(60_000);
        let nested = false;
        const steps: Array<{ refusal?: string; lastUsedAt: number }> = [];
        tools.setBody(async () => {
          if (!nested) {
            nested = true;
            for (const deviceId of [spare.deviceId, held.deviceId]) {
              timer.advanceTime(5_000);
              const refusal = await ToolRegistry.callInternal("homeScreen", {
                sessionUuid: HOLDER,
                platform: "android",
                deviceId,
              }).then(
                () => undefined,
                (error: { code?: string }) => error.code ?? String(error),
              );
              steps.push({ refusal, lastUsedAt: clocks().lastUsedAt });
            }
          }
          return { content: [{ type: "text", text: JSON.stringify({ success: true }) }] };
        });

        await call("homeScreen", { platform: "android" }, OWNER);

        const admittedAt = before.lastUsedAt + 60_000;
        expect(steps).toEqual([
          // Refused 5 s into the outer call: still the outer call's admission stamp.
          { refusal: "device_outside_bound_session", lastUsedAt: admittedAt },
          // Admitted 10 s in: stamped then.
          { refusal: undefined, lastUsedAt: admittedAt + 10_000 },
        ]);
        expect(tools.runs.map((run) => run.deviceId)).toEqual([held.deviceId, held.deviceId]);
      },
    );
  });
});

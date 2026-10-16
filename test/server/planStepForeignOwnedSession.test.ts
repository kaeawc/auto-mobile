import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { INTERNAL_MCP_SESSION_PARAM } from "../../src/daemon/constants";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import {
  DEVICE_OWNED_BY_OTHER_SESSION_CODE,
  type InputDeviceOwnedError,
} from "../../src/daemon/inputDeviceOwnership";
import { SessionManager } from "../../src/daemon/sessionManager";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import type { BootedDevice } from "../../src/models";
import type { PlanStep } from "../../src/models/Plan";
import { planCallerContext } from "../../src/server/planCallerIdentity";
import { ToolRegistry, type RegisteredTool } from "../../src/server/toolRegistry";
import { logger } from "../../src/utils/logger";
import {
  DefaultPlanStepExecutor,
  type StepExecutionResult,
} from "../../src/utils/plan/PlanStepExecutor";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { RealToolCallPath } from "../helpers/realToolCallPath";

/**
 * #11469: a plan step runs for the connection that called `executePlan`. A step naming a session
 * another connection owns is judged by the same owner rule as a direct call from that connection,
 * so a sessionless plan cannot drive or move that session by naming its UUID.
 */
describe("a plan step naming a session another connection owns (#11469)", () => {
  const held: BootedDevice = { name: "Pixel A", deviceId: "emulator-5554", platform: "android" };
  const free: BootedDevice = { name: "Pixel B", deviceId: "emulator-5556", platform: "android" };
  const SESSION = "sess-a";
  const OWNER = "conn-1";
  const OTHER = "conn-2";

  let manager: SessionManager;
  let pool: DevicePool;
  let tools: RealToolCallPath;
  let executor: DefaultPlanStepExecutor<RegisteredTool>;
  let spies: Array<ReturnType<typeof spyOn>>;
  let previousAutolock: string | undefined;

  /** One step of a plan with no session of its own, as `executePlan` runs it for `connection`. */
  const runStep = (step: PlanStep, connection: string | undefined): Promise<StepExecutionResult> =>
    runWithToolSelectionContext(
      planCallerContext(connection ? { [INTERNAL_MCP_SESSION_PARAM]: connection } : {}),
      () => executor.executeStep(step, { logPrefix: "[plan]", platform: "android" }),
    );

  const refusalCode = (result: StepExecutionResult): unknown =>
    (result.sourceError as InputDeviceOwnedError | undefined)?.code;

  const move: PlanStep = {
    tool: "setActiveDevice",
    params: { deviceId: free.deviceId, platform: "android", sessionUuid: SESSION },
  };
  const tap: PlanStep = { tool: "tapAt", params: { x: 10, y: 10, sessionUuid: SESSION } };
  const read: PlanStep = { tool: "observe", params: { sessionUuid: SESSION } };

  beforeEach(async () => {
    previousAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    spies = [
      spyOn(logger, "info").mockImplementation(() => {}),
      spyOn(logger, "warn").mockImplementation(() => {}),
      spyOn(logger, "error").mockImplementation(() => {}),
    ];
    const timer = new FakeTimer();
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
      barrier: () => {
        return new FakeDbWriteBarrier();
      },
    });
    manager.stopCleanupTimer();
    const discovery = new FakeDeviceUtils();
    discovery.setBootedDevices("android", [held, free]);
    pool = new DevicePool(
      createDevicePoolDependencies(manager, "plan-step-foreign-session-daemon", {
        timer,
        deviceManager: discovery,
      }),
    );
    await pool.initializeWithDevices([held, free]);
    DaemonState.getInstance().initialize(manager, pool, new DeviceSessionRegistry(timer));
    tools = new RealToolCallPath([held, free]).install();
    executor = new DefaultPlanStepExecutor<RegisteredTool>(ToolRegistry, () => true, timer);
    await pool.bindOrReuseDeviceSession(
      SESSION,
      held.deviceId,
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
  });

  afterEach(() => {
    tools.uninstall();
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

  describe("in a plan another connection started", () => {
    test("setActiveDevice is refused, typed, and moves nothing", async () => {
      const result = await runStep(move, OTHER);

      expect(result.status).toBe("failed");
      expect(refusalCode(result)).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
      expect(manager.getSession(SESSION)?.assignedDevice).toBe(held.deviceId);
      expect(pool.getDevice(held.deviceId)?.sessionId).toBe(SESSION);
      expect(pool.getDevice(free.deviceId)?.sessionId ?? null).toBeNull();
      expect(tools.deviceSessionManager.getEnsureDeviceReadyCalls()).toBe(0);
    });

    test("a control step is refused, typed, before any input reaches the device", async () => {
      const result = await runStep(tap, OTHER);

      expect(result.status).toBe("failed");
      expect(refusalCode(result)).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
      expect(result.error).toContain(`session ${SESSION} is owned by another connected client`);
      expect(tools.runs).toEqual([]);
      expect(pool.isSessionOwnedByOtherConnection(SESSION, OTHER)).toBe(true);
    });

    test("a read step is not refused and binds nothing", async () => {
      const result = await runStep(read, OTHER);

      expect(result.status).toBe("completed");
      expect(pool.isSessionOwnedByOtherConnection(SESSION, OTHER)).toBe(true);
      expect(pool.isSessionOwnedByOtherConnection(SESSION, OWNER)).toBe(false);
    });

    test("a control step is admitted once the owner has disconnected", async () => {
      pool.releaseMcpSessionBindings(OWNER);

      const result = await runStep(tap, OTHER);

      expect(result.status).toBe("completed");
    });
  });

  describe("in a plan the owner started", () => {
    test("a control step naming its own session runs on that session's device", async () => {
      const result = await runStep(tap, OWNER);

      expect(result.status).toBe("completed");
      expect(tools.runs).toEqual([
        { name: "tapAt", deviceId: held.deviceId, sessionUuid: SESSION },
      ]);
    });

    test("setActiveDevice naming its own session is not refused as foreign", async () => {
      const result = await runStep(
        { ...move, params: { ...move.params, deviceId: held.deviceId } },
        OWNER,
      );

      expect(result.status).toBe("completed");
    });
  });

  describe("in a plan with no originating connection", () => {
    test("a control step naming the session keeps today's behaviour", async () => {
      const result = await runStep(tap, undefined);

      expect(result.status).toBe("completed");
      expect(tools.runs).toEqual([
        { name: "tapAt", deviceId: held.deviceId, sessionUuid: SESSION },
      ]);
    });
  });

  describe("owner contracts that must keep working", () => {
    const PLAN_SESSION = "plan-session";

    test("a plan with its own session overrides the step's UUID and is not refused", async () => {
      await pool.bindOrReuseDeviceSession(PLAN_SESSION, free.deviceId, "android");

      const result = await runWithToolSelectionContext(
        planCallerContext({ [INTERNAL_MCP_SESSION_PARAM]: OTHER }),
        () =>
          executor.executeStep(tap, {
            logPrefix: "[plan]",
            platform: "android",
            sessionUuid: PLAN_SESSION,
          }),
      );

      expect(result.status).toBe("completed");
      expect(tools.runs).toEqual([
        { name: "tapAt", deviceId: free.deviceId, sessionUuid: PLAN_SESSION },
      ]);
    });

    test("a UUID no connection holds is foreign to nobody, so it stays re-issuable by name", async () => {
      const result = await runStep(
        { tool: "tapAt", params: { x: 10, y: 10, sessionUuid: "released-plan-session" } },
        OTHER,
      );

      expect(refusalCode(result)).not.toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
    });

    test("a call with no identity never clears the identity it inherited", async () => {
      expect(planCallerContext({})).toEqual({});

      const result = await runWithToolSelectionContext(
        planCallerContext({ [INTERNAL_MCP_SESSION_PARAM]: OTHER }),
        () => runStep(tap, undefined),
      );

      expect(refusalCode(result)).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
    });
  });

  describe("a blank plan session names no session", () => {
    const OWN_SESSION = "sess-b";
    const tapOnHeld: PlanStep = {
      tool: "tapAt",
      params: { x: 10, y: 10, sessionUuid: SESSION, deviceId: held.deviceId },
    };
    const runWithPlanSession = (
      step: PlanStep,
      planSessionUuid: string,
      ambientSessionUuid?: string,
    ): Promise<StepExecutionResult> =>
      runWithToolSelectionContext(
        {
          ...planCallerContext({ [INTERNAL_MCP_SESSION_PARAM]: OTHER }),
          routingSessionUuid: ambientSessionUuid,
        },
        () =>
          executor.executeStep(step, {
            logPrefix: "[plan]",
            platform: "android",
            sessionUuid: planSessionUuid,
          }),
      );

    for (const [name, blank] of [
      ["empty", ""],
      ["whitespace-only", "  \t"],
    ] as const) {
      test(`an ${name} plan session does not exempt a step naming a foreign session`, async () => {
        const result = await runWithPlanSession(tapOnHeld, blank);

        expect(result.status).toBe("failed");
        expect(refusalCode(result)).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
        expect(tools.runs).toEqual([]);
      });

      test(`an ${name} plan session keeps the connection's ambient session override`, async () => {
        await pool.bindOrReuseDeviceSession(OWN_SESSION, free.deviceId, "android");

        const result = await runWithPlanSession(tap, blank, OWN_SESSION);

        expect(result.status).toBe("completed");
        expect(tools.runs).toEqual([
          { name: "tapAt", deviceId: free.deviceId, sessionUuid: OWN_SESSION },
        ]);
      });

      test(`a device-aware call with an ${name} sessionUuid runs on the ambient session`, async () => {
        await pool.bindOrReuseDeviceSession(OWN_SESSION, free.deviceId, "android");

        await runWithToolSelectionContext({ routingSessionUuid: OWN_SESSION }, () =>
          tools.call("tapAt", { x: 10, y: 10, sessionUuid: blank }),
        );

        expect(tools.runs).toEqual([
          { name: "tapAt", deviceId: free.deviceId, sessionUuid: OWN_SESSION },
        ]);
      });
    }
  });

  describe("a step naming only a device", () => {
    const tapOnDevice: PlanStep = {
      tool: "tapAt",
      params: { x: 10, y: 10, deviceId: held.deviceId },
    };

    test("in the holder's own plan runs as the holder's session", async () => {
      const result = await runStep(tapOnDevice, OWNER);

      expect(result.status).toBe("completed");
      expect(tools.runs).toEqual([
        { name: "tapAt", deviceId: held.deviceId, sessionUuid: SESSION },
      ]);
    });

    test("in another connection's plan is refused, typed", async () => {
      const result = await runStep(tapOnDevice, OTHER);

      expect(result.status).toBe("failed");
      expect(refusalCode(result)).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
      expect(tools.runs).toEqual([]);
    });
  });

  /**
   * Explore, NavigateTo and DefaultUIStateSetup replay actions through `ToolRegistry.callInternal`
   * / `callInternalTyped` by tool name, naming the session they were built with. These are those
   * call shapes at the seam; the feature classes themselves are not driven here.
   */
  describe("a nested call made while serving a connection", () => {
    const nested = (run: () => Promise<unknown>, connection: string): Promise<unknown> =>
      runWithToolSelectionContext(
        planCallerContext({ [INTERNAL_MCP_SESSION_PARAM]: connection }),
        run,
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
    const pressBack = () =>
      ToolRegistry.callInternal("pressButton", {
        button: "back",
        platform: "android",
        deviceId: held.deviceId,
        sessionUuid: SESSION,
      });
    const swipe = () =>
      ToolRegistry.callInternalTyped("swipeOn", {
        direction: "up",
        platform: "android",
        sessionUuid: SESSION,
      });

    test("naming a foreign session is refused, by name or typed", async () => {
      for (const call of [pressBack, swipe]) {
        const error = (await nested(call, OTHER)) as InputDeviceOwnedError | undefined;

        expect(error?.code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
      }
      expect(tools.runs).toEqual([]);
    });

    test("naming the connection's own session runs", async () => {
      expect(await nested(pressBack, OWNER)).toBeUndefined();
      expect(tools.runs).toEqual([
        { name: "pressButton", deviceId: held.deviceId, sessionUuid: SESSION },
      ]);
    });

    test("with no originating connection keeps today's behaviour", async () => {
      await pressBack();

      expect(tools.runs).toEqual([
        { name: "pressButton", deviceId: held.deviceId, sessionUuid: SESSION },
      ]);
    });
  });

  test("a step cannot name its own connection: plan content never supplies the identity", async () => {
    const forged: PlanStep = {
      tool: "tapAt",
      params: { ...tap.params, [INTERNAL_MCP_SESSION_PARAM]: OWNER },
    };

    const result = await runStep(forged, OTHER);

    expect(refusalCode(result)).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
    expect(tools.runs).toEqual([]);
  });
});

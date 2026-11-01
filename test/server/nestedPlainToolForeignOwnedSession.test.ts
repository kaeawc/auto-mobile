import { describe, expect, spyOn } from "bun:test";
import { z } from "zod/v4";
import { INTERNAL_MCP_SESSION_PARAM } from "../../src/daemon/wire/constants";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import {
  DEVICE_OWNED_BY_OTHER_SESSION_CODE,
  type InputDeviceOwnedError,
} from "../../src/daemon/inputDeviceOwnership";
import { SessionManager } from "../../src/daemon/sessionManager";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import { SET_TOOL_ENABLED_TOOL_NAME } from "../../src/features/toolSelection/toolSelectionControl";
import type { BootedDevice } from "../../src/models";
import type { PlanStep } from "../../src/models/Plan";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { planCallerContext } from "../../src/server/planCallerIdentity";
import { ToolRegistry, type RegisteredTool } from "../../src/server/toolRegistry";
import {
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
} from "../../src/daemon/videoRecordingManager";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { logger } from "../../src/utils/logger";
import {
  DefaultPlanStepExecutor,
  type StepExecutionResult,
} from "../../src/utils/plan/PlanStepExecutor";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { warmedTests } from "../helpers/warmedTests";

isolateToolRegistry();

/** Records each platform kill and stops there: a recorded kill proves the call got past every gate. */
class RecordingKillDeviceManager extends FakeDeviceUtils {
  readonly killed: string[] = [];

  override async killDevice(device: BootedDevice): Promise<void> {
    this.killed.push(device.deviceId);
    throw new Error("platform kill reached");
  }
}

const held: BootedDevice = { name: "iPhone A", deviceId: "IOS-HELD", platform: "ios" };
const free: BootedDevice = { name: "iPhone B", deviceId: "IOS-FREE", platform: "ios" };
const HOLDER = "holder-session";
const OWNER = "conn-1";
const OTHER = "conn-2";
/** A plain control tool whose schema declares `sessionUuid`, as deleteDevice and exportPlan do. */
const PLAIN_CONTROL = "plainControlProbe";
const PLAIN_READ = "plainReadProbe";

/**
 * #11555: a nested call (a plan step, a tool calling a tool) never passes the MCP ingress, so
 * `ToolRegistry.callInternal` judges the session it names by the same owner rule. That rule covers
 * plain tools (#11542) on both paths: admitted on the session it names, a plain control call would
 * pass the lifecycle holder check as the holder.
 */
describe("a nested plain control call naming a session another connection owns (#11555)", () => {
  let manager: RecordingKillDeviceManager;
  let sessionManager: SessionManager;
  let executor: DefaultPlanStepExecutor<RegisteredTool>;
  let restorePipeline: () => void;
  let spies: Array<ReturnType<typeof spyOn>>;
  let previousAutolock: string | undefined;
  let probeRuns: string[];

  const serving = <T>(connection: string | undefined, run: () => Promise<T>): Promise<T> =>
    runWithToolSelectionContext(
      planCallerContext(connection ? { [INTERNAL_MCP_SESSION_PARAM]: connection } : {}),
      run,
    );
  /** The error a nested call rejects with, or undefined when it ran. */
  const nested = (
    connection: string | undefined,
    name: string,
    args: Record<string, unknown>,
  ): Promise<InputDeviceOwnedError | undefined> =>
    serving(connection, () => ToolRegistry.callInternal(name, args)).then(
      () => undefined,
      (error: InputDeviceOwnedError) => error,
    );
  /** One step of a plan with no session of its own, as `executePlan` runs it for `connection`. */
  const runStep = (
    step: PlanStep,
    connection: string,
    sessionUuid?: string,
  ): Promise<StepExecutionResult> =>
    serving(connection, () =>
      executor.executeStep(step, { logPrefix: "[plan]", platform: "ios", sessionUuid }),
    );
  const refusalCode = (result: StepExecutionResult): unknown =>
    (result.sourceError as InputDeviceOwnedError | undefined)?.code;

  let harnessArranged = false;

  async function arrangeHarness(): Promise<void> {
    harnessArranged = true;
    previousAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    spies = [
      spyOn(logger, "info").mockImplementation(() => {}),
      spyOn(logger, "warn").mockImplementation(() => {}),
      spyOn(logger, "error").mockImplementation(() => {}),
    ];
    ToolRegistry.clearTools();
    restorePipeline = ToolRegistry.setPipelineOverridesForTesting({
      displayInventory: new FakeDisplayInventoryProvider(),
    });
    const timer = new FakeTimer();
    manager = new RecordingKillDeviceManager();
    manager.setBootedDevices("ios", [held, free]);
    manager.setBootedDevices("android", []);
    PlatformDeviceManagerFactory.setInstance(manager);
    await setVideoRecordingManagerDependencies({
      videoRecorderService: {} as never,
      recordingRepository: { listRecordings: async () => [] } as never,
      configRepository: {} as never,
      highlightClient: {} as never,
      timer,
      now: () => new Date(0),
    });
    setDeviceToolsDependencies({
      deviceManagerFactory: () => manager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      timer,
    });
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessionManager.stopCleanupTimer();
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "nested-plain-tool-foreign-session", {
        timer,
        deviceManager: manager,
      }),
    );
    await pool.initializeWithDevices([held, free]);
    DaemonState.getInstance().initialize(sessionManager, pool);
    // OWNER's connection acquires the session that holds the device.
    await pool.bindOrReuseDeviceSession({
      sessionId: HOLDER,
      deviceId: held.deviceId,
      platform: "ios",
      allowSessionRebind: false,
      mcpSessionId: OWNER,
    });
    registerDeviceTools();
    probeRuns = [];
    const probeSchema = z.object({ sessionUuid: z.string().optional() }).strict();
    const probe = (name: string) => async (args: { sessionUuid?: string }) => {
      probeRuns.push(`${name}:${args.sessionUuid ?? "none"}`);
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true }) }] };
    };
    ToolRegistry.register(PLAIN_CONTROL, "probe", probeSchema, probe(PLAIN_CONTROL));
    ToolRegistry.register(PLAIN_READ, "probe", probeSchema, {
      handler: probe(PLAIN_READ),
      readOnly: true,
    });
    ToolRegistry.register(
      SET_TOOL_ENABLED_TOOL_NAME,
      "probe",
      probeSchema,
      probe(SET_TOOL_ENABLED_TOOL_NAME),
    );
    executor = new DefaultPlanStepExecutor<RegisteredTool>(ToolRegistry, () => true, timer);
  }

  function teardownHarness(): void {
    if (!harnessArranged) {
      return;
    }
    harnessArranged = false;
    ToolRegistry.clearTools();
    restorePipeline();
    resetDeviceToolsDependencies();
    resetVideoRecordingManagerDependencies();
    PlatformDeviceManagerFactory.setInstance(null);
    DaemonState.getInstance().reset();
    sessionManager.stopCleanupTimer();
    for (const spy of spies) {
      spy.mockRestore();
    }
    if (previousAutolock === undefined) {
      delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    } else {
      process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = previousAutolock;
    }
  }

  // First-use costs (the tool call path, the refusal) are paid in beforeAll. The harness is still
  // built inside each test, so its cost is paid in the test body.
  const test = warmedTests(teardownHarness);
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

  describe("while serving another connection", () => {
    arranged("killDevice naming the owner's session is refused before the kill", async () => {
      const error = await nested(OTHER, "killDevice", { device: held, sessionUuid: HOLDER });

      expect(manager.killed).toEqual([]);
      expect(error?.code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
      expect(error?.message).toContain(`session ${HOLDER} is owned by another connected client`);
    });

    arranged(
      "force overrides the holder check, not the naming of the owner's session",
      async () => {
        const named = await nested(OTHER, "killDevice", {
          device: held,
          force: true,
          sessionUuid: HOLDER,
        });

        expect(named?.code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
        expect(named?.message).toContain("leave sessionUuid out");
        expect(manager.killed).toEqual([]);

        await nested(OTHER, "killDevice", { device: held, force: true });

        expect(manager.killed).toEqual([held.deviceId]);
      },
    );

    arranged(
      "a plain control step whose schema carries sessionUuid is refused, typed",
      async () => {
        const result = await runStep(
          { tool: PLAIN_CONTROL, params: { sessionUuid: HOLDER } },
          OTHER,
        );

        expect(result.status).toBe("failed");
        expect(refusalCode(result)).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
        expect(probeRuns).toEqual([]);
      },
    );

    arranged("a killDevice step is refused: its undeclared sessionUuid names nothing", async () => {
      const result = await runStep(
        { tool: "killDevice", params: { device: held, sessionUuid: HOLDER } },
        OTHER,
      );

      expect(result.status).toBe("failed");
      expect(refusalCode(result)).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
      expect(manager.killed).toEqual([]);
    });

    arranged(
      "a plain read and setToolEnabled naming the owner's session are not refused",
      async () => {
        expect(await nested(OTHER, PLAIN_READ, { sessionUuid: HOLDER })).toBeUndefined();
        expect(
          await nested(OTHER, SET_TOOL_ENABLED_TOOL_NAME, { sessionUuid: HOLDER }),
        ).toBeUndefined();

        expect(probeRuns).toEqual([
          `${PLAIN_READ}:${HOLDER}`,
          `${SET_TOOL_ENABLED_TOOL_NAME}:${HOLDER}`,
        ]);
      },
    );

    arranged("a plain control step under the plan's own session runs on that session", async () => {
      const result = await runStep(
        { tool: PLAIN_CONTROL, params: { sessionUuid: HOLDER } },
        OTHER,
        "plan-session",
      );

      expect(result.status).toBe("completed");
      expect(probeRuns).toEqual([`${PLAIN_CONTROL}:plan-session`]);
    });

    arranged(
      "once the owner has disconnected the nested killDevice reaches the device",
      async () => {
        DaemonState.getInstance().getDevicePool().releaseMcpSessionBindings(OWNER);

        await nested(OTHER, "killDevice", { device: held, sessionUuid: HOLDER });

        expect(manager.killed).toEqual([held.deviceId]);
      },
    );
  });

  arranged("the owner's own nested killDevice naming its session reaches the device", async () => {
    await nested(OWNER, "killDevice", { device: held, sessionUuid: HOLDER });

    expect(manager.killed).toEqual([held.deviceId]);
  });

  arranged("the owner's own plain control step naming its session runs", async () => {
    const result = await runStep({ tool: PLAIN_CONTROL, params: { sessionUuid: HOLDER } }, OWNER);

    expect(result.status).toBe("completed");
    expect(probeRuns).toEqual([`${PLAIN_CONTROL}:${HOLDER}`]);
  });

  arranged("a nested call with no originating connection is left to the holder check", async () => {
    await nested(undefined, "killDevice", { device: held, sessionUuid: HOLDER });

    expect(manager.killed).toEqual([held.deviceId]);
  });
});

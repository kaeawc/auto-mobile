import { spyOn } from "bun:test";
import { z } from "zod/v4";
import { DaemonState } from "../../../src/daemon/daemonState";
import { registerDerivedLabelSessionReleaseCascade } from "../../../src/daemon/derivedLabelSessionReleaseCascade";
import { DevicePool } from "../../../src/daemon/devicePool";
import { SessionManager } from "../../../src/daemon/sessionManager";
import type { BootedDevice } from "../../../src/models";
import { registerPlanTools } from "../../../src/server/planTools";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import * as videoRecordingManager from "../../../src/server/videoRecordingManager";
import { FakeDeviceSessionManager } from "../../fakes/FakeDeviceSessionManager";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";
import { FakeDisplayInventoryProvider } from "../../fakes/FakeDisplayInventoryProvider";
import { FakePlanVideoRecorder } from "../../fakes/FakePlanVideoRecorder";
import { FakeTimer } from "../../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../../helpers/devicePoolDependencies";

/**
 * Harness for the plan-session hunt (2026-10-10): the real `executePlan` tool (registry wrapper,
 * `PlanExecutionOrchestrator`, `DefaultPlanLifecycleManager`), the real `SessionManager`,
 * `DevicePool` and derived-label release cascade, over fake devices, a fake persistence and a
 * `FakeTimer`. `startDaemon` can be called again over the same persistence to model a restart.
 */

export const BASE = "5e550000-0000-4000-8000-0000000000aa";
export const LABEL_B = `${BASE}:B`;

export const deviceA: BootedDevice = { name: "Sim A", deviceId: "IOS-A", platform: "ios" };
export const deviceB: BootedDevice = { name: "Sim B", deviceId: "IOS-B", platform: "ios" };
export const deviceC: BootedDevice = { name: "Sim C", deviceId: "IOS-C", platform: "ios" };

/** A plan with labels A and B and one probe step per listed label. */
export const twoDevicePlan = (stepLabels: string[]): string =>
  [
    "name: plan-session-hunt",
    "devices:",
    "  - A",
    "  - B",
    "steps:",
    ...stepLabels.flatMap((label) => [
      "  - tool: huntProbe",
      `    device: ${label}`,
      "    params: {}",
    ]),
    "",
  ].join("\n");

export interface PlanRunResult {
  success?: boolean;
  error?: string;
  code?: string;
  retryable?: boolean;
  deviceMapping?: Record<string, string>;
}

export type ProbeStep = (device: BootedDevice, signal?: AbortSignal) => Promise<void>;

export interface HuntDaemon {
  sessionManager: SessionManager;
  pool: DevicePool;
  stop(): void;
}

export interface PlanSessionHunt {
  timer: FakeTimer;
  persistence: FakeDeviceSessionPersistence;
  /** The daemon currently behind `DaemonState`. */
  daemon(): HuntDaemon;
  /** A new session manager and pool over the same persistence and devices: a daemon restart. */
  restartDaemon(): Promise<HuntDaemon>;
  /** The caller acquires `sessionUuid` (default {@link BASE}) on a free device. */
  acquire(sessionUuid?: string): Promise<string>;
  /** What each `huntProbe` plan step does; the default succeeds at once. */
  setProbeStep(step: ProbeStep): void;
  runPlan(planContent: string, signal?: AbortSignal): Promise<PlanRunResult>;
  poolHolder(deviceId: string): string | undefined;
  tearDown(): void;
}

export async function createPlanSessionHunt(devices: BootedDevice[]): Promise<PlanSessionHunt> {
  const restores: Array<() => void> = [];
  const recorder = new FakePlanVideoRecorder();
  const videoSpies = [
    spyOn(videoRecordingManager, "startVideoRecording").mockImplementation(
      recorder.startVideoRecording,
    ),
    spyOn(videoRecordingManager, "stopVideoRecording").mockImplementation(
      recorder.stopVideoRecording,
    ),
    spyOn(videoRecordingManager, "rollbackVideoRecordingStart").mockResolvedValue(undefined),
    spyOn(videoRecordingManager, "getVideoRecordingStatus").mockResolvedValue(null),
    spyOn(videoRecordingManager, "getVideoRecordingMetadata").mockResolvedValue(null),
  ];
  restores.push(() => videoSpies.forEach((spy) => spy.mockRestore()));

  ToolRegistry.clearTools();
  restores.push(
    ToolRegistry.setPipelineOverridesForTesting({
      displayInventory: new FakeDisplayInventoryProvider(),
      deviceReadAccess: { listBooted: async () => devices, isAuthorized: () => true },
      auditRunner: {
        run: (input) => input.handler(input.device, input.args, input.progress, input.signal),
      },
      afterToolCall: {
        async handle(input) {
          return { durationMs: 0, finalizedResponse: input.response };
        },
      },
    }),
  );
  const connected = new FakeDeviceSessionManager();
  connected.setConnectedDevices(devices);
  const overrides: Array<[string, unknown]> = [
    ["deviceSessionManager", connected],
    ["toolCallRepository", { async recordToolCall(): Promise<void> {} }],
    ["navigationToolCallRecorder", { record: () => undefined }],
  ];
  for (const [key, value] of overrides) {
    const original: unknown = Reflect.get(ToolRegistry, key);
    restores.push(() => Reflect.set(ToolRegistry, key, original));
    Reflect.set(ToolRegistry, key, value);
  }

  const timer = new FakeTimer();
  const persistence = new FakeDeviceSessionPersistence();
  const deviceUtils = new FakeDeviceUtils();
  deviceUtils.setBootedDevices("ios", devices);

  let current: HuntDaemon | undefined;
  let daemonCount = 0;
  const startDaemon = async (): Promise<HuntDaemon> => {
    current?.stop();
    const sessionManager = new SessionManager(timer, persistence);
    sessionManager.stopCleanupTimer();
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, `plan-session-hunt-${++daemonCount}`, {
        timer,
        deviceManager: deviceUtils,
      }),
    );
    await pool.initializeWithDevices(devices);
    DaemonState.getInstance().reset();
    DaemonState.getInstance().initialize(sessionManager, pool);
    // daemon.ts: a released base takes its derived label sessions with it (#11091).
    registerDerivedLabelSessionReleaseCascade(sessionManager, pool);
    // Fake devices are ready at once: every session setup records readiness without device I/O.
    const trackSetup = sessionManager.trackSessionSetup.bind(sessionManager);
    const setup = spyOn(sessionManager, "trackSessionSetup").mockImplementation((session) => {
      sessionManager.setDeviceReadiness(session.sessionId, "automationReady");
      return trackSetup(session, async () => undefined);
    });
    current = {
      sessionManager,
      pool,
      stop: () => {
        setup.mockRestore();
        sessionManager.stopCleanupTimer();
      },
    };
    return current;
  };
  await startDaemon();

  registerPlanTools();
  let probeStep: ProbeStep = async () => undefined;
  ToolRegistry.registerDeviceAware(
    "huntProbe",
    "Plan-session hunt probe step",
    z.object({}).passthrough(),
    async (device: BootedDevice, _args: unknown, _progress: unknown, signal?: AbortSignal) => {
      await probeStep(device, signal);
      return { success: true };
    },
  );

  const daemon = (): HuntDaemon => {
    if (!current) {
      throw new Error("the hunt daemon is not started");
    }
    return current;
  };

  return {
    timer,
    persistence,
    daemon,
    restartDaemon: startDaemon,
    acquire: async (sessionUuid = BASE) => {
      const { sessionManager, pool } = daemon();
      const session = await sessionManager.getOrCreateSession(sessionUuid, pool, "ios");
      sessionManager.setDeviceReadiness(sessionUuid, "automationReady");
      return session.assignedDevice;
    },
    setProbeStep: (step) => {
      probeStep = step;
    },
    runPlan: async (planContent, signal) => {
      const response: {
        structuredContent?: PlanRunResult;
        content: Array<{ text: string }>;
      } = await ToolRegistry.getTool("executePlan")!.handler(
        {
          planContent,
          startStep: 0,
          platform: "ios",
          sessionUuid: BASE,
          deviceAllocationTimeoutMs: 1_000,
          abortStrategy: "immediate",
        },
        undefined,
        signal,
      );
      return response.structuredContent ?? JSON.parse(response.content[0].text);
    },
    poolHolder: (deviceId) => daemon().pool.getDevice(deviceId)?.sessionId ?? undefined,
    tearDown: () => {
      current?.stop();
      for (const restore of restores.splice(0).reverse()) {
        restore();
      }
      ToolRegistry.clearTools();
      DaemonState.getInstance().reset();
    },
  };
}

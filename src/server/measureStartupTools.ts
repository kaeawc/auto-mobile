import { z } from "zod/v4";
import { PerformanceAuditRepository } from "../db/performanceAuditRepository";
import {
  AndroidStartupMeasurement,
  MEASURE_STARTUP_DEFAULT_ITERATIONS,
  MEASURE_STARTUP_MAX_ITERATIONS,
  type MeasureStartupResult,
  type StartupDeviceShell,
} from "../features/performance/AndroidStartupMeasurement";
import { ActionableError, type BootedDevice } from "../models";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { defineDeviceTool } from "./defineTool";
import { measureStartupResultSchema } from "./measureStartupToolOutputSchemas";

const measureStartupInput = z.object({
  appId: z
    .string()
    .regex(/^[A-Za-z][\w]*(\.[A-Za-z_][\w]*)+$/, "appId must be an Android package name")
    .describe("Package to launch"),
  activity: z
    .string()
    .regex(/^[\w.$/]+$/, "activity must be a class name or package/class component")
    .optional()
    .describe("Activity or pkg/.Activity component; default launcher activity"),
  mode: z
    .enum(["cold", "warm", "hot"])
    .describe(
      "cold: process killed; warm: process kept, activity recreated; hot: activity resumed",
    ),
  iterations: z
    .number()
    .int()
    .min(1)
    .max(MEASURE_STARTUP_MAX_ITERATIONS)
    .optional()
    .describe(`Launches to measure; default ${MEASURE_STARTUP_DEFAULT_ITERATIONS}`),
  compilation: z
    .enum(["asIs", "speed-profile", "speed", "verify"])
    .optional()
    .describe("Recompile first (cmd package compile -m <mode> -f); default asIs"),
  dropCaches: z
    .boolean()
    .optional()
    .describe("Drop the page cache before each cold launch; needs a root shell"),
  waitForFullyDrawn: z.boolean().optional().describe("Wait for reportFullyDrawn to record TTFD"),
});

type MeasureStartupArgs = z.output<typeof measureStartupInput> & { sessionUuid?: string };

/** What the handler needs, injectable so tests drive it with fakes. */
export interface MeasureStartupDependencies {
  createShell: (device: BootedDevice) => StartupDeviceShell;
  timer: Timer;
  repository: Pick<PerformanceAuditRepository, "recordAudit">;
}

const defaultDependencies = (): MeasureStartupDependencies => ({
  createShell: (device) => defaultAdbClientFactory.create(device),
  timer: defaultTimer,
  repository: new PerformanceAuditRepository(),
});

/** Store a run in `automobile:performance-results`: p50s in the startup columns, the rest as diagnostics. */
async function recordStartupResult(
  repository: MeasureStartupDependencies["repository"],
  device: BootedDevice,
  result: MeasureStartupResult,
  timer: Timer,
  sessionUuid: string | undefined,
): Promise<void> {
  const timestamp = new Date(timer.now()).toISOString();
  await repository.recordAudit({
    deviceId: device.deviceId,
    sessionId: sessionUuid ?? timestamp.split("T")[0],
    packageName: result.appId,
    timestamp,
    passed: true,
    metrics: {
      p50Ms: null,
      p90Ms: null,
      p95Ms: null,
      p99Ms: null,
      jankCount: null,
      missedVsyncCount: null,
      slowUiThreadCount: null,
      frameDeadlineMissedCount: null,
      cpuUsagePercent: null,
      touchLatencyMs: null,
      timeToFirstFrameMs: result.ttid.p50,
      timeToInteractiveMs: result.ttfd?.p50 ?? null,
    },
    diagnostics: JSON.stringify({ kind: "startup", ...result }),
  });
}

export const createMeasureStartupHandler =
  (deps: MeasureStartupDependencies = defaultDependencies()) =>
  async (
    device: BootedDevice,
    args: MeasureStartupArgs,
    _progress?: unknown,
    signal?: AbortSignal,
  ) => {
    if (device.platform !== "android") {
      throw new ActionableError("measureStartup is only supported on Android.");
    }
    const measurement = new AndroidStartupMeasurement(deps.createShell(device), deps.timer);
    const result = await measurement.measure(
      {
        appId: args.appId,
        activity: args.activity,
        mode: args.mode,
        iterations: args.iterations,
        compilation: args.compilation,
        dropCaches: args.dropCaches,
        waitForFullyDrawn: args.waitForFullyDrawn,
      },
      signal,
    );
    await recordStartupResult(deps.repository, device, result, deps.timer, args.sessionUuid);
    const ttfd = result.ttfd ? `, TTFD p50 ${result.ttfd.p50} ms` : "";
    return createStructuredToolResponse({
      success: true as const,
      ...result,
      message: `${result.mode} start of ${result.component} over ${result.iterations} launches: TTID p50 ${result.ttid.p50} ms${ttfd}`,
    });
  };

const measureStartupTool = defineDeviceTool({
  name: "measureStartup",
  description:
    "Android: measure cold/warm/hot app startup over N launches; TTID/TTFD percentiles, stored in performance results.",
  input: measureStartupInput,
  options: { defaultEnabled: false, stopsApp: true, outputSchema: measureStartupResultSchema },
});

export const measureStartupSchema = measureStartupTool.schema;

export function registerMeasureStartupTools(): void {
  measureStartupTool.register(undefined, createMeasureStartupHandler());
}

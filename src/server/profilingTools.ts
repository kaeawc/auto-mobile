import { z } from "zod/v4";
import { AndroidHeapDump } from "../features/profiling/AndroidHeapDump";
import { AndroidTraceCapture } from "../features/profiling/AndroidTraceCapture";
import type { ProfilingArtifactStore } from "../features/profiling/ProfilingArtifactStore";
import {
  defaultProfilingRegistry,
  type ProfilingRegistry,
} from "../features/profiling/ProfilingRegistry";
import {
  TRACE_CATEGORIES,
  TRACE_DEFAULT_BUFFER_MB,
  TRACE_DEFAULT_CATEGORIES,
  TRACE_DEFAULT_MAX_DURATION_MS,
  TRACE_MAX_BUFFER_MB,
  TRACE_MAX_DURATION_MS,
  TRACE_MIN_DURATION_MS,
} from "../features/performanceTrace/perfettoCategoryConfig";
import type { PerfettoAdb } from "../features/performanceTrace/perfettoDevice";
import { ActionableError, type BootedDevice } from "../models";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { ANDROID_PACKAGE_NAME_PATTERN } from "../utils/androidPackageName";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { defineDeviceTool } from "./defineTool";
import { defaultDaemonContext } from "../daemon/daemonContext";
import { runTrackedTraceStart } from "./sessionProfiling";
import type { PowerSessionView, SessionPowerHost } from "./sessionPower";
import { createToolOutputsProfilingStore } from "./profilingArtifactStore";
import { captureTraceResultSchema, heapDumpResultSchema } from "./profilingToolOutputSchemas";

const appIdSchema = z
  .string()
  .regex(ANDROID_PACKAGE_NAME_PATTERN, "appId must be an Android package name");

const captureTraceInput = z.object({
  action: z.enum(["start", "stop"]).describe("start a recorder, or stop one by traceId"),
  traceId: z.string().min(1).optional().describe("stop: the id start returned"),
  appId: appIdSchema
    .optional()
    .describe("start: enables the app's atrace tags (Choreographer, RenderThread, custom slices)"),
  categories: z
    .array(z.enum(TRACE_CATEGORIES))
    .min(1)
    .optional()
    .describe(
      `start: what to record; default ${TRACE_DEFAULT_CATEGORIES.join(", ")}. app needs an appId`,
    ),
  bufferMb: z
    .number()
    .int()
    .min(1)
    .max(TRACE_MAX_BUFFER_MB)
    .optional()
    .describe(`start: ring buffer size; default ${TRACE_DEFAULT_BUFFER_MB}`),
  maxDurationMs: z
    .number()
    .int()
    .min(TRACE_MIN_DURATION_MS)
    .max(TRACE_MAX_DURATION_MS)
    .optional()
    .describe(
      `start: the recorder stops itself after this; default ${TRACE_DEFAULT_MAX_DURATION_MS}`,
    ),
});

const heapDumpInput = z.object({
  appId: appIdSchema.describe("Running debuggable or profileable app to dump"),
  native: z.boolean().optional().describe("Dump the native heap (am dumpheap -n); default Java"),
});

type CaptureTraceArgs = z.output<typeof captureTraceInput> & { sessionUuid?: string };
type HeapDumpArgs = z.output<typeof heapDumpInput> & { sessionUuid?: string };

/** What the handlers need, injectable so tests drive them with fakes. */
export interface ProfilingDependencies {
  adbFor: (device: BootedDevice) => PerfettoAdb;
  timer: Pick<Timer, "sleep" | "now">;
  idGenerator: IdGenerator;
  registry: ProfilingRegistry;
  store: ProfilingArtifactStore;
  /** The session manager, resolved per call; absent outside a daemon. */
  sessionHost: () => SessionPowerHost<PowerSessionView> | undefined;
}

const defaultDependencies = (): ProfilingDependencies => ({
  adbFor: (device) => defaultAdbClientFactory.create(device),
  timer: defaultTimer,
  idGenerator: defaultIdGenerator,
  registry: defaultProfilingRegistry,
  store: createToolOutputsProfilingStore(),
  sessionHost: () => defaultDaemonContext.sessionManager(),
});

function assertAndroid(device: BootedDevice, tool: string): void {
  if (device.platform !== "android") {
    throw new ActionableError(`${tool} is only supported on Android.`);
  }
}

export const createCaptureTraceHandler =
  (deps: ProfilingDependencies = defaultDependencies()) =>
  async (
    device: BootedDevice,
    args: CaptureTraceArgs,
    _progress?: unknown,
    signal?: AbortSignal,
  ) => {
    assertAndroid(device, "captureTrace");
    const capture = new AndroidTraceCapture({ ...deps, adb: deps.adbFor(device) });
    if (args.action === "stop") {
      if (!args.traceId) {
        throw new ActionableError("captureTrace stop requires the traceId start returned.");
      }
      const stopped = await capture.stop(device.deviceId, args.traceId, signal);
      return createStructuredToolResponse({
        success: true as const,
        action: "stop" as const,
        deviceId: device.deviceId,
        ...stopped,
        message: `Trace ${stopped.traceId} saved to ${stopped.path} (${stopped.sizeBytes} bytes, ${stopped.durationMs} ms)`,
      });
    }
    const adb = deps.adbFor(device);
    const started = await runTrackedTraceStart(
      { host: deps.sessionHost(), registry: deps.registry, adb, timer: deps.timer },
      args.sessionUuid,
      device.deviceId,
      () =>
        capture.start({
          deviceId: device.deviceId,
          sessionId: args.sessionUuid,
          appId: args.appId,
          categories: args.categories,
          bufferMb: args.bufferMb,
          maxDurationMs: args.maxDurationMs,
          signal,
        }),
    );
    return createStructuredToolResponse({
      success: true as const,
      action: "start" as const,
      deviceId: device.deviceId,
      traceId: started.traceId,
      startedAt: started.startedAt,
      ...started.config,
      warnings: started.warnings,
      message: `Recording ${started.config.categories.join(", ")} as ${started.traceId}; stop it with captureTrace action=stop`,
    });
  };

export const createHeapDumpHandler =
  (deps: ProfilingDependencies = defaultDependencies()) =>
  async (device: BootedDevice, args: HeapDumpArgs, _progress?: unknown, signal?: AbortSignal) => {
    assertAndroid(device, "heapDump");
    const dump = new AndroidHeapDump({ ...deps, adb: deps.adbFor(device) });
    const result = await dump.dump({
      appId: args.appId,
      deviceId: device.deviceId,
      native: args.native,
      sessionId: args.sessionUuid,
      signal,
    });
    return createStructuredToolResponse({
      success: true as const,
      appId: args.appId,
      ...result,
      message: `${result.native ? "Native" : "Java"} heap of ${args.appId} saved to ${result.path} (${result.sizeBytes} bytes)`,
    });
  };

const captureTraceTool = defineDeviceTool({
  name: "captureTrace",
  description:
    "Android: record a Perfetto trace from typed categories (sched, gfx, view, am, wm, binder_driver, memory, app). " +
    "start returns a traceId; drive the flow; stop pulls the .perfetto-trace to the host. Released sessions stop their trace.",
  input: captureTraceInput,
  options: { defaultEnabled: false, outputSchema: captureTraceResultSchema },
});

const heapDumpTool = defineDeviceTool({
  name: "heapDump",
  description:
    "Android: dump a running debuggable or profileable app's heap (am dumpheap) to a host .hprof; " +
    "refuses other apps with heap_dump_not_debuggable.",
  input: heapDumpInput,
  options: { defaultEnabled: false, outputSchema: heapDumpResultSchema },
});

export const captureTraceSchema = captureTraceTool.schema;
export const heapDumpSchema = heapDumpTool.schema;

export function registerProfilingTools(): void {
  captureTraceTool.register(undefined, createCaptureTraceHandler());
  heapDumpTool.register(undefined, createHeapDumpHandler());
}

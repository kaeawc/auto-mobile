import { z } from "zod/v4";
import { AndroidHeapDump } from "../features/profiling/AndroidHeapDump";
import type { ProfilingArtifactStore } from "../features/profiling/ProfilingArtifactStore";
import {
  defaultProfilingRegistry,
  type ProfilingRegistry,
} from "../features/profiling/ProfilingRegistry";
import type { PerfettoAdb } from "../features/performanceTrace/perfettoDevice";
import { ActionableError, type BootedDevice } from "../models";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { ANDROID_PACKAGE_NAME_PATTERN } from "../utils/androidPackageName";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { defineDeviceTool } from "./defineTool";
import { createToolOutputsProfilingStore } from "./profilingArtifactStore";
import { heapDumpResultSchema } from "./profilingToolOutputSchemas";

const appIdSchema = z
  .string()
  .regex(ANDROID_PACKAGE_NAME_PATTERN, "appId must be an Android package name");

const heapDumpInput = z.object({
  appId: appIdSchema.describe("Running debuggable or profileable app to dump"),
  native: z.boolean().optional().describe("Dump the native heap (am dumpheap -n); default Java"),
});

type HeapDumpArgs = z.output<typeof heapDumpInput> & { sessionUuid?: string };

/** What the handlers need, injectable so tests drive them with fakes. */
export interface ProfilingDependencies {
  adbFor: (device: BootedDevice) => PerfettoAdb;
  timer: Pick<Timer, "sleep">;
  idGenerator: IdGenerator;
  registry: ProfilingRegistry;
  store: ProfilingArtifactStore;
}

const defaultDependencies = (): ProfilingDependencies => ({
  adbFor: (device) => defaultAdbClientFactory.create(device),
  timer: defaultTimer,
  idGenerator: defaultIdGenerator,
  registry: defaultProfilingRegistry,
  store: createToolOutputsProfilingStore(),
});

function assertAndroid(device: BootedDevice, tool: string): void {
  if (device.platform !== "android") {
    throw new ActionableError(`${tool} is only supported on Android.`);
  }
}

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

const heapDumpTool = defineDeviceTool({
  name: "heapDump",
  description:
    "Android: dump a running debuggable or profileable app's heap (am dumpheap) to a host .hprof; " +
    "refuses other apps with heap_dump_not_debuggable.",
  input: heapDumpInput,
  options: { defaultEnabled: false, outputSchema: heapDumpResultSchema },
});

export const heapDumpSchema = heapDumpTool.schema;

export function registerProfilingTools(): void {
  heapDumpTool.register(undefined, createHeapDumpHandler());
}

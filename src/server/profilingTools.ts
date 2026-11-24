import { z } from "zod/v4";
import { AndroidHeapDump } from "../features/profiling/AndroidHeapDump";
import { IosHeapDump, type IosHeapDumpDependencies } from "../features/profiling/IosHeapDump";
import type { ProfilingArtifactStore } from "../features/profiling/ProfilingArtifactStore";
import {
  defaultProfilingRegistry,
  type ProfilingRegistry,
} from "../features/profiling/ProfilingRegistry";
import type { PerfettoAdb } from "../features/performanceTrace/perfettoDevice";
import { resolveIosAppPid } from "../features/performanceTrace/defaultPerformanceTraceManager";
import { ActionableError, type BootedDevice } from "../models";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { ANDROID_PACKAGE_NAME_PATTERN } from "../utils/androidPackageName";
import { DefaultHostCommandExecutor } from "../utils/HostCommandExecutor";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { defineDeviceTool } from "./defineTool";
import { createToolOutputsProfilingStore } from "./profilingArtifactStore";
import { heapDumpResultSchema } from "./profilingToolOutputSchemas";

const appIdSchema = z
  .string()
  .regex(ANDROID_PACKAGE_NAME_PATTERN, "appId must be an Android package name");

const iosBundleIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*$/, "appId must be an iOS bundle ID");

const heapDumpInput = z.object({
  appId: appIdSchema
    .or(iosBundleIdSchema)
    .describe("Package name or bundle ID of the running app to dump"),
  native: z.boolean().optional().describe("Android only: dump the native heap; default Java"),
});

type HeapDumpArgs = z.output<typeof heapDumpInput> & { sessionUuid?: string };

/** What the handlers need, injectable so tests drive them with fakes. */
export interface ProfilingDependencies {
  adbFor: (device: BootedDevice) => PerfettoAdb;
  iosHeapDump: Pick<IosHeapDumpDependencies, "host" | "resolvePid">;
  timer: Pick<Timer, "sleep">;
  idGenerator: IdGenerator;
  registry: ProfilingRegistry;
  store: ProfilingArtifactStore;
}

const defaultDependencies = (): ProfilingDependencies => ({
  adbFor: (device) => defaultAdbClientFactory.create(device),
  iosHeapDump: { host: new DefaultHostCommandExecutor(), resolvePid: resolveIosAppPid },
  timer: defaultTimer,
  idGenerator: defaultIdGenerator,
  registry: defaultProfilingRegistry,
  store: createToolOutputsProfilingStore(),
});

export const createHeapDumpHandler =
  (deps: ProfilingDependencies = defaultDependencies()) =>
  async (device: BootedDevice, args: HeapDumpArgs, _progress?: unknown, signal?: AbortSignal) => {
    if (device.platform !== "android" && device.platform !== "ios") {
      throw new ActionableError("heapDump is only supported on Android or iOS.");
    }
    if (device.platform === "android" && !ANDROID_PACKAGE_NAME_PATTERN.test(args.appId)) {
      throw new ActionableError("appId must be an Android package name");
    }
    const request = { appId: args.appId, native: args.native, signal };
    const result =
      device.platform === "android"
        ? await new AndroidHeapDump({ ...deps, adb: deps.adbFor(device) }).dump({
            ...request,
            deviceId: device.deviceId,
            sessionId: args.sessionUuid,
          })
        : await new IosHeapDump({ ...deps, ...deps.iosHeapDump }).dump({ ...request, device });
    const heap =
      result.format === "memgraph" ? "Memory graph" : result.native ? "Native heap" : "Java heap";
    return createStructuredToolResponse({
      success: true as const,
      appId: args.appId,
      ...result,
      message: `${heap} of ${args.appId} saved to ${result.path} (${result.sizeBytes} bytes)`,
    });
  };

const heapDumpTool = defineDeviceTool({
  name: "heapDump",
  description:
    "Dump a running app's heap to a host file. Android writes .hprof for debuggable or profileable apps. " +
    "iOS Simulator writes .memgraph for processes macOS allows inspecting.",
  input: heapDumpInput,
  options: { defaultEnabled: false, outputSchema: heapDumpResultSchema },
});

export const heapDumpSchema = heapDumpTool.schema;

export function registerProfilingTools(): void {
  heapDumpTool.register(undefined, createHeapDumpHandler());
}

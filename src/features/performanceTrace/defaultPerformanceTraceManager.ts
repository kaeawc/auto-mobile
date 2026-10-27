import { mkdir } from "node:fs/promises";
import { ENV, readEnvTrimmed } from "../../config/env";
import type { BootedDevice, Platform } from "../../models";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { errorMessage } from "../../utils/describeUnknownError";
import {
  DefaultHostCommandExecutor,
  type HostCommandExecutor,
} from "../../utils/HostCommandExecutor";
import { defaultIdGenerator } from "../../utils/IdGenerator";
import { resolveIosDeviceKind } from "../../utils/ios-cmdline-tools/IosDeviceKind";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { logger } from "../../utils/logger";
import { defaultTimer } from "../../utils/SystemTimer";
import { getTempDir, TEMP_SUBDIRS } from "../../utils/tempDir";
import { findIosSimulatorAppProcessId } from "../action/CrashApp";
import { PerfettoRecorder } from "./PerfettoRecorder";
import { TraceProcessorShell, type PerfettoTraceProcessor } from "./perfettoTraceProcessor";
import { PerformanceTraceManager } from "./PerformanceTraceManager";
import type { PerformanceTraceRecorder } from "./PerformanceTraceRecorder";
import { XctraceRecorder } from "./XctraceRecorder";

const PID_LOOKUP_TIMEOUT_MS = 5_000;

/** Simulator apps run under launchd_sim; physical devices have no pid lookup yet. */
async function resolveIosAppPid(
  device: BootedDevice,
  appId: string,
  signal?: AbortSignal,
): Promise<number | undefined> {
  if (resolveIosDeviceKind({ deviceId: device.deviceId }) !== "simulator") {
    return undefined;
  }
  const list = await new SimCtlClient(device).executeCommandArgs(
    ["spawn", device.deviceId, "launchctl", "list"],
    PID_LOOKUP_TIMEOUT_MS,
    signal,
  );
  return findIosSimulatorAppProcessId(list.stdout, appId) ?? undefined;
}

/** Find `trace_processor_shell` once; a missing binary only limits Android summaries. */
export function traceProcessorLocator(
  host: HostCommandExecutor,
  binary: string = readEnvTrimmed(ENV.TRACE_PROCESSOR) ?? "trace_processor_shell",
): () => Promise<PerfettoTraceProcessor | undefined> {
  let located: Promise<PerfettoTraceProcessor | undefined> | undefined;
  return () =>
    (located ??= host
      .executeCommand(binary, ["--version"], { timeoutMs: PID_LOOKUP_TIMEOUT_MS })
      .then(
        () => new TraceProcessorShell(host, binary),
        (error: unknown) => {
          // Optional host tool: without it Android traces are still recorded, just not summarised.
          logger.debug(`[performanceTrace] ${binary} unavailable: ${errorMessage(error)}`);
          return undefined;
        },
      ));
}

export function createDefaultPerformanceTraceManager(): PerformanceTraceManager {
  const host = new DefaultHostCommandExecutor();
  const recorders: Record<Platform, PerformanceTraceRecorder> = {
    android: new PerfettoRecorder({
      adbFor: (device) => defaultAdbClientFactory.create(device),
      traceProcessor: traceProcessorLocator(host),
      timer: defaultTimer,
    }),
    ios: new XctraceRecorder({ host, resolvePid: resolveIosAppPid, timer: defaultTimer }),
  };
  return new PerformanceTraceManager({
    recorderFor: (platform) => recorders[platform],
    artifactDir: async () => {
      const dir = getTempDir(TEMP_SUBDIRS.PERFORMANCE_TRACES);
      await mkdir(dir, { recursive: true });
      return dir;
    },
    idGenerator: defaultIdGenerator,
    timer: defaultTimer,
  });
}

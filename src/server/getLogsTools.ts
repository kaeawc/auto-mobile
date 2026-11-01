import { z } from "zod/v4";
import { defaultDaemonContext } from "../daemon/daemonContext";
import { AndroidLogReader } from "../features/deviceLogs/AndroidLogReader";
import {
  GET_LOGS_MAX_LINES,
  GET_LOGS_MAX_SECONDS,
  GetLogs,
  type GetLogsDependencies,
} from "../features/deviceLogs/GetLogs";
import { LOGCAT_BUFFERS, LOGCAT_PRIORITIES } from "../features/deviceLogs/logcatQuery";
import type { BootedDevice } from "../models";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { SimCtlClient } from "../utils/ios-cmdline-tools/SimCtlClient";
import { defaultTimer } from "../utils/SystemTimer";
import { resourceLinkField } from "../utils/schemaHelpers";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { nodeAppFileFileSystem } from "./appFileSupport";
import { defineDeviceTool, type DeviceToolSchema } from "./defineTool";
import { getLogsResultSchema } from "./getLogsToolOutputSchemas";
import { IosSimulatorSessionLogProvider } from "./IosSimulatorSessionLogProvider";
import { deviceActionClock } from "./pipeline/deviceActionClock";
import { SESSION_LOG_MAX_BYTES_LIMIT } from "./sessionLogContract";
import { UNIFIED_LOG_DEFAULT_TIMEOUT_MS } from "./sessionLogService";
import { PLAN_RELEVANT } from "./toolRegistryTypes";

const getLogsInput = z.object({
  appId: z
    .string()
    .min(1)
    .optional()
    .describe("Package or bundle id; on Android every process of the app, not one pid"),
  since: z
    .union([
      z.enum(["lastAction", "sessionStart"]),
      z.object({ seconds: z.number().int().min(1).max(GET_LOGS_MAX_SECONDS) }).strict(),
    ])
    .optional()
    .describe('Window start: "lastAction", "sessionStart", or {seconds} (default 300s)'),
  tags: z
    .array(z.string().min(1))
    .max(32)
    .optional()
    .describe('Android logcat tag filters, "Tag" or "Tag:P" (other tags are silenced)'),
  minPriority: z.enum(LOGCAT_PRIORITIES).optional().describe("Lowest priority shown (default V)"),
  grep: z.string().min(1).optional().describe("Regular expression applied host-side to each line"),
  buffers: z
    .array(z.enum(LOGCAT_BUFFERS))
    .min(1)
    .optional()
    .describe('Android logcat buffers (default ["main","crash"])'),
  includeSystem: z
    .boolean()
    .optional()
    .describe("Android: add ActivityManager/system lines that name appId (launch, death, ANR)"),
  maxLines: z
    .number()
    .int()
    .min(1)
    .max(GET_LOGS_MAX_LINES)
    .optional()
    .describe("Newest lines kept (default 1000)"),
  resourceLink: resourceLinkField(),
});

export type GetLogsArgs = z.output<DeviceToolSchema<typeof getLogsInput>>;

export type GetLogsDependencyFactory = (
  device: BootedDevice,
  args: GetLogsArgs,
) => GetLogsDependencies;

export const defaultGetLogsDependencies: GetLogsDependencyFactory = (device, args) => ({
  clock: {
    now: () => defaultTimer.now(),
    lastActionStartMs: (deviceId) => deviceActionClock.lastActionStartMs(deviceId),
    sessionStartMs: () =>
      args.sessionUuid
        ? defaultDaemonContext.sessionManager()?.findSession(args.sessionUuid)?.createdAt
        : undefined,
  },
  android: () => new AndroidLogReader(defaultAdbClientFactory.create(device)),
  ios: () => {
    const provider = new IosSimulatorSessionLogProvider(
      (target) => new SimCtlClient(target),
      nodeAppFileFileSystem,
      defaultTimer,
      { unifiedLogTimeoutMs: UNIFIED_LOG_DEFAULT_TIMEOUT_MS },
    );
    return {
      collect: (appId, lastSeconds, level, { signal, processName } = {}) =>
        provider.collectUnifiedLog(
          device,
          appId,
          { lastSeconds, level, processName },
          { maxBytes: SESSION_LOG_MAX_BYTES_LIMIT, signal, retain: "tail" },
        ),
      resolveProcessName: async (appId, signal) => {
        const apps = await new SimCtlClient(device).listAppsOrThrow(device.deviceId, { signal });
        return executableOfApp(apps, appId);
      },
    };
  },
});

export function createGetLogsHandler(
  dependencies: GetLogsDependencyFactory = defaultGetLogsDependencies,
) {
  return async (
    device: BootedDevice,
    args: GetLogsArgs,
    _progress?: unknown,
    signal?: AbortSignal,
  ) => {
    const result = await new GetLogs(dependencies(device, args)).execute(
      device,
      {
        appId: args.appId,
        since: args.since,
        tags: args.tags,
        minPriority: args.minPriority,
        grep: args.grep,
        buffers: args.buffers,
        includeSystem: args.includeSystem,
        maxLines: args.maxLines,
      },
      signal,
    );
    return createStructuredToolResponse({
      message: `${result.lines.length} log line(s) from the last ${result.sinceSeconds}s${result.truncated ? " (older lines dropped)" : ""}`,
      success: true,
      deviceId: device.deviceId,
      ...result,
    });
  };
}

const getLogsTool = defineDeviceTool({
  name: "getLogs",
  description:
    "Read device logs with filters: Android logcat by app (every process, so a crash survives process death), tags, priority, regex, buffers (main, system, crash, events) and since the last action or session start; iOS Simulator unified log by app subsystem. Bounded output.",
  input: getLogsInput,
  options: {
    // A plan step that captures what the app logged around the preceding steps.
    ...PLAN_RELEVANT,
    defaultEnabled: false,
    // Reads only; read-only access never requires a session (#10965).
    deviceReadOnly: true,
    outputSchema: getLogsResultSchema,
  },
});

export function registerGetLogsTools(dependencies?: GetLogsDependencyFactory): void {
  getLogsTool.register(undefined, createGetLogsHandler(dependencies));
}

/** CFBundleExecutable of `appId` from a `simctl listapps` listing. */
export function executableOfApp(
  apps: readonly Record<string, unknown>[],
  appId: string,
): string | undefined {
  const app = apps.find(
    (record) => record.bundleId === appId || record.CFBundleIdentifier === appId,
  );
  const executable = app?.CFBundleExecutable;
  return typeof executable === "string" && executable.length > 0 ? executable : undefined;
}

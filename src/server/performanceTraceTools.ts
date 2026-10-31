import { z } from "zod/v4";
import { SessionReleaseBroadcaster } from "../daemon/sessionReleaseBroadcast";
import { getDaemonStreamDeviceLifecycleEmitter } from "../daemon/streamDeviceLifecycleEvents";
import { createDefaultPerformanceTraceManager } from "../features/performanceTrace/defaultPerformanceTraceManager";
import type { PerformanceTraceManager } from "../features/performanceTrace/PerformanceTraceManager";
import {
  PERFORMANCE_TRACE_DEFAULT_TIME_LIMIT_MS,
  PERFORMANCE_TRACE_MAX_TIME_LIMIT_MS,
  PERFORMANCE_TRACE_MIN_TIME_LIMIT_MS,
  PERFORMANCE_TRACE_TEMPLATES,
} from "../features/performanceTrace/performanceTraceTemplates";
import type { BootedDevice } from "../models";
import { addDeviceTargetingToSchema } from "../utils/schemaHelpers";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { registerPerformanceTraceResources } from "./performanceTraceResources";
import { ToolRegistry } from "./toolRegistry";

const APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const performanceTraceSchema = addDeviceTargetingToSchema(
  z
    .object({
      action: z
        .enum(["start", "stop"])
        .describe(
          "start a recorder, or stop one by traceId. iOS stop waits for finalisation: " +
            "60 seconds without output or artifact growth, at most 180 seconds total; " +
            "a timeout reports an incomplete trace that cannot be summarised. Retry with a shorter timeLimitMs or on a quieter host.",
        ),
      appId: z
        .string()
        .regex(APP_ID_PATTERN, "appId must be a package name or bundle identifier")
        .optional()
        .describe("App to trace (required for appLaunch and allocations)"),
      template: z.enum(PERFORMANCE_TRACE_TEMPLATES).optional().describe("start: what to record"),
      timeLimitMs: z
        .number()
        .int()
        .min(PERFORMANCE_TRACE_MIN_TIME_LIMIT_MS)
        .max(PERFORMANCE_TRACE_MAX_TIME_LIMIT_MS)
        .optional()
        .describe(
          `start: recorder stops itself after this (default ${PERFORMANCE_TRACE_DEFAULT_TIME_LIMIT_MS})`,
        ),
      traceId: z.string().min(1).optional().describe("stop: the id start returned"),
    })
    .strict(),
).superRefine((args, ctx) => {
  if (args.action === "start" && !args.template) {
    ctx.addIssue({ code: "custom", message: "start requires a template", path: ["template"] });
  }
  if (args.action === "stop" && !args.traceId) {
    ctx.addIssue({ code: "custom", message: "stop requires a traceId", path: ["traceId"] });
  }
});

export type PerformanceTraceArgs = z.output<typeof performanceTraceSchema>;

const msItems = z.array(z.object({ name: z.string(), durationMs: z.number() }));

export const performanceTraceResultSchema = z.object({
  success: z.literal(true),
  action: z.enum(["start", "stop"]),
  traceId: z.string(),
  state: z.enum(["recording", "stopped"]),
  deviceId: z.string(),
  platform: z.enum(["android", "ios"]),
  template: z.enum(PERFORMANCE_TRACE_TEMPLATES),
  appId: z.string().optional(),
  startedAt: z.string(),
  timeLimitMs: z.number(),
  artifactPath: z.string(),
  summary: z
    .object({
      durationMs: z.number().optional(),
      endReason: z.string().optional(),
      launch: z.object({ durationMs: z.number(), phases: msItems }).optional(),
      hitches: z
        .object({ count: z.number(), totalDurationMs: z.number(), maxDurationMs: z.number() })
        .optional(),
      hangs: z
        .array(
          z.object({
            durationMs: z.number(),
            startMs: z.number().optional(),
            type: z.string().optional(),
          }),
        )
        .optional(),
      topFunctions: z.array(z.object({ name: z.string(), samples: z.number() })).optional(),
      allocations: z.object({ bytes: z.number(), count: z.number() }).optional(),
    })
    .optional(),
  warnings: z.array(z.string()),
});

/** Releasing a session, or losing its device, stops its recorders so none are orphaned. */
function subscribeTraceCleanup(manager: PerformanceTraceManager): () => void {
  const cleanups = [
    SessionReleaseBroadcaster.subscribe((sessionUuid, _reason, snapshot, extras) => {
      void manager.stopTracesForSession(sessionUuid);
      // An upgrade-only re-announcement's device may belong to its next owner by now (#11206).
      if (snapshot?.deviceId && !extras?.upgradeOnly) {
        void manager.stopTracesOnDevice(snapshot.deviceId);
      }
    }),
    getDaemonStreamDeviceLifecycleEmitter().onDeviceRemoved((deviceId) => {
      void manager.stopTracesOnDevice(deviceId);
    }),
  ];
  return () => cleanups.forEach((cleanup) => cleanup());
}

let unsubscribeTraceCleanup: (() => void) | undefined;

export function createPerformanceTraceHandler(manager: PerformanceTraceManager) {
  return async (
    device: BootedDevice,
    args: PerformanceTraceArgs,
    _progress?: unknown,
    signal?: AbortSignal,
  ) => {
    const result =
      args.action === "start"
        ? await manager.start(device, {
            template: args.template!,
            appId: args.appId,
            timeLimitMs: args.timeLimitMs ?? PERFORMANCE_TRACE_DEFAULT_TIME_LIMIT_MS,
            ownerSessionUuid: args.sessionUuid,
            signal,
          })
        : await manager.stop(args.traceId!, signal);
    return createStructuredToolResponse({ success: true, action: args.action, ...result });
  };
}

/**
 * Register the tool and subscribe its release cleanup; returns the unsubscribe.
 * Re-registering replaces the previous subscription.
 */
export function registerPerformanceTraceTools(
  manager: PerformanceTraceManager = createDefaultPerformanceTraceManager(),
): () => void {
  ToolRegistry.registerDeviceAware(
    "performanceTrace",
    "Record a native performance trace (xctrace on iOS, Perfetto on Android): start with a " +
      "template, drive the flow, then stop for the artifact path and a bounded summary.",
    performanceTraceSchema,
    {
      handler: createPerformanceTraceHandler(manager),
      defaultEnabled: false,
      outputSchema: performanceTraceResultSchema,
    },
  );
  registerPerformanceTraceResources(manager);
  unsubscribeTraceCleanup?.();
  const unsubscribe = subscribeTraceCleanup(manager);
  unsubscribeTraceCleanup = unsubscribe;
  return () => {
    unsubscribe();
    if (unsubscribeTraceCleanup === unsubscribe) {
      unsubscribeTraceCleanup = undefined;
    }
  };
}

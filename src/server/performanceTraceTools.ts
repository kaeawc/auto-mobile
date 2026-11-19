import { z } from "zod/v4";
import { SessionReleaseBroadcaster } from "../daemon/sessionReleaseBroadcast";
import { getDaemonStreamDeviceLifecycleEmitter } from "../daemon/streamDeviceLifecycleEvents";
import { getDefaultPerformanceTraceManager } from "../features/performanceTrace/defaultPerformanceTraceManager";
import type { PerformanceTraceManager } from "../features/performanceTrace/PerformanceTraceManager";
import {
  TRACE_CATEGORIES,
  TRACE_DEFAULT_BUFFER_MB,
  TRACE_MAX_BUFFER_MB,
} from "../features/performanceTrace/perfettoCategoryConfig";
import {
  PERFORMANCE_TRACE_DEFAULT_TIME_LIMIT_MS,
  PERFORMANCE_TRACE_MAX_TIME_LIMIT_MS,
  PERFORMANCE_TRACE_MIN_TIME_LIMIT_MS,
  PERFORMANCE_TRACE_TEMPLATES,
} from "../features/performanceTrace/performanceTraceTemplates";
import type { BootedDevice } from "../models";
import { runOutsideRequestContext } from "../utils/AbortContext";
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
        .describe(
          "App to trace (required for appLaunch, allocations and the app category; adds app to categories)",
        ),
      template: z
        .enum(PERFORMANCE_TRACE_TEMPLATES)
        .optional()
        .describe("start: what to record, with a bounded summary; or set categories"),
      categories: z
        .array(z.enum(TRACE_CATEGORIES))
        .min(1)
        .optional()
        .describe(
          "start, Android only: Perfetto categories to record instead of a template; the trace has no summary",
        ),
      bufferMb: z
        .number()
        .int()
        .min(1)
        .max(TRACE_MAX_BUFFER_MB)
        .optional()
        .describe(`start, with categories: ring buffer size (default ${TRACE_DEFAULT_BUFFER_MB})`),
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
  if (args.action === "start" && args.template && args.categories) {
    ctx.addIssue({
      code: "custom",
      message: "start takes a template or categories, not both",
      path: ["categories"],
    });
  }
  if (args.action === "start" && !args.template && !args.categories) {
    ctx.addIssue({
      code: "custom",
      message: "start requires a template or categories",
      path: ["template"],
    });
  }
  if (args.bufferMb !== undefined && !args.categories) {
    ctx.addIssue({
      code: "custom",
      message: "bufferMb applies only with categories",
      path: ["bufferMb"],
    });
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
  template: z.enum(PERFORMANCE_TRACE_TEMPLATES).optional(),
  categories: z.array(z.enum(TRACE_CATEGORIES)).optional(),
  bufferMb: z.number().optional(),
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
    // Not part of whichever request triggered the release: its abort must not cut the stops short.
    SessionReleaseBroadcaster.subscribe((sessionUuid, _reason, snapshot, extras) =>
      runOutsideRequestContext(() => {
        void manager.stopTracesForSession(sessionUuid);
        // An upgrade-only re-announcement's device may belong to its next owner by now (#11206).
        if (snapshot?.deviceId && !extras?.upgradeOnly) {
          void manager.stopTracesOnDevice(snapshot.deviceId);
        }
      }),
    ),
    getDaemonStreamDeviceLifecycleEmitter().onDeviceRemoved((deviceId) =>
      runOutsideRequestContext(() => void manager.stopTracesOnDevice(deviceId)),
    ),
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
            template: args.template,
            categories: args.categories,
            bufferMb: args.bufferMb,
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
  manager: PerformanceTraceManager = getDefaultPerformanceTraceManager(),
): () => void {
  ToolRegistry.registerDeviceAware(
    "performanceTrace",
    "Record a native performance trace (xctrace on iOS, Perfetto on Android): start with a " +
      "template, drive the flow, then stop for the artifact path and a bounded summary. " +
      "On Android, start with categories (and bufferMb) instead of a template to record chosen " +
      "Perfetto categories; that trace has no summary.",
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

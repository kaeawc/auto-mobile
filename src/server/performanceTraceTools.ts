import { z } from "zod/v4";
import { defaultDaemonContext } from "../daemon/daemonContext";
import type { Session } from "../daemon/sessionManager";
import { SessionReleaseBroadcaster } from "../daemon/sessionReleaseBroadcast";
import { getDaemonStreamDeviceLifecycleEmitter } from "../daemon/streams/streamDeviceLifecycleEvents";
import { getDefaultPerformanceTraceManager } from "../features/performanceTrace/defaultPerformanceTraceManager";
import type {
  PerformanceTraceManager,
  PerformanceTraceResult,
} from "../features/performanceTrace/PerformanceTraceManager";
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
import { ActionableError } from "../models/ActionableError";
import { runOutsideRequestContext } from "../utils/AbortContext";
import { logger } from "../utils/logger";
import { addDeviceTargetingToSchema } from "../utils/schemaHelpers";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { registerPerformanceTraceResources } from "./performanceTraceResources";
import { isLiveOn, type PowerSessionView, type SessionPowerHost } from "./sessionPower";
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

/** Who registers a shutdown-fallback stop as pending device cleanup (`SessionManager` fits). */
type TraceCleanupHost = Pick<SessionPowerHost<PowerSessionView>, "registerPendingDeviceCleanup">;

/**
 * Losing a device stops its recorders, since it has no next owner to wait for them. A release
 * delivered by `SessionManager.onSessionRelease` (it carries a snapshot) is stopped there, as
 * pending device cleanup (`registerPerformanceTraceSessionCleanup`). The daemon-shutdown fallback
 * broadcast has no snapshot and no `onSessionRelease`, so its stops are registered here, as
 * pending device cleanup the shutdown drains (#19316).
 */
function subscribeTraceCleanup(
  manager: PerformanceTraceManager,
  cleanupHost: () => TraceCleanupHost | undefined,
): () => void {
  const cleanups = [
    SessionReleaseBroadcaster.subscribe((sessionUuid, _reason, snapshot) => {
      const host = snapshot ? undefined : cleanupHost();
      if (!host) {
        return;
      }
      manager.sessionTraceDeviceIds(sessionUuid).forEach((deviceId) =>
        host.registerPendingDeviceCleanup(
          deviceId,
          // Not part of whichever request triggered the release: its abort must not cut the stop short.
          runOutsideRequestContext(() => manager.stopSessionTracesOnDevice(sessionUuid, deviceId)),
          {
            name: "stop a performance trace recorder at daemon shutdown",
            leftover: "a perfetto or xctrace recorder the released session started",
          },
        ),
      );
    }),
    getDaemonStreamDeviceLifecycleEmitter().onDeviceRemoved((deviceId) =>
      runOutsideRequestContext(() => void manager.stopTracesOnDevice(deviceId)),
    ),
  ];
  return () => cleanups.forEach((cleanup) => cleanup());
}

let unsubscribeTraceCleanup: (() => void) | undefined;

/** The slice of the session manager a session-owned trace start needs (`SessionManager` fits). */
export type PerformanceTraceSessionHost<S extends PowerSessionView = Session> = SessionPowerHost<S>;

export interface PerformanceTraceToolDependencies<S extends PowerSessionView = Session> {
  /** Resolved per start; defaults to the daemon's session manager. */
  sessionHost?: () => PerformanceTraceSessionHost<S> | undefined;
}

type TraceStart = () => Promise<PerformanceTraceResult>;

/** Who a start is for: the calling session, if any, and the device it targets. */
interface TraceStartOwner {
  sessionUuid?: string;
  deviceId: string;
}

/**
 * Start a session's trace as tracked session setup (#18698): refused on a session that is
 * released, releasing, rebound or replaced, and drained by its release before the release
 * cleanup looks for recorders. The drain is bounded, so a start can still finish after the
 * session ended; that recorder is discarded as pending device cleanup, so the device's next
 * owner waits for it, and the start is refused.
 */
async function startForSession<S extends PowerSessionView>(
  manager: Pick<PerformanceTraceManager, "discard">,
  host: PerformanceTraceSessionHost<S>,
  { sessionUuid, deviceId }: Required<TraceStartOwner>,
  start: TraceStart,
): Promise<PerformanceTraceResult> {
  const session = host.getSession(sessionUuid);
  if (!session || !isLiveOn(host, sessionUuid, session, deviceId)) {
    throw new ActionableError(
      "Cannot start a performance trace: session is released, releasing, rebound, or replaced.",
    );
  }
  let completed = false;
  let started!: PerformanceTraceResult;
  await host.trackSessionSetup(session, async () => {
    started = await start();
    completed = true;
  });
  if (!completed) {
    throw new ActionableError(
      "Session began releasing or rebinding before the trace started; nothing was recorded.",
    );
  }
  if (isLiveOn(host, sessionUuid, session, deviceId)) {
    return started;
  }
  const { traceId } = started;
  logger.warn(
    `[performanceTrace] Session ${sessionUuid} ended while ${traceId} was starting on ${deviceId}; discarding it`,
  );
  // Not part of this request: its abort must not cut the teardown short. Registered at once, so
  // the device's next owner waits for it.
  host.registerPendingDeviceCleanup(
    deviceId,
    runOutsideRequestContext(() => manager.discard(traceId)),
    {
      name: "discard a performance trace that started after its session ended",
      leftover: "a perfetto or xctrace recorder the ended session started",
    },
  );
  throw new ActionableError(
    `The session was released or rebound while the performance trace was starting; ` +
      `${traceId} was discarded. Start it again from a live session.`,
  );
}

/** A sessionless start, or one outside the daemon (stdio), has no session to guard. */
function startOwned<S extends PowerSessionView>(
  manager: PerformanceTraceManager,
  host: PerformanceTraceSessionHost<S> | undefined,
  { sessionUuid, deviceId }: TraceStartOwner,
  start: TraceStart,
): Promise<PerformanceTraceResult> {
  return host && sessionUuid
    ? startForSession(manager, host, { sessionUuid, deviceId }, start)
    : start();
}

export function createPerformanceTraceHandler<S extends PowerSessionView = Session>(
  manager: PerformanceTraceManager,
  deps: PerformanceTraceToolDependencies<S> = {},
) {
  return async (
    device: BootedDevice,
    args: PerformanceTraceArgs,
    _progress?: unknown,
    signal?: AbortSignal,
  ) => {
    if (args.action === "stop") {
      const stopped = await manager.stop(args.traceId!, signal);
      return createStructuredToolResponse({ success: true, action: args.action, ...stopped });
    }
    const start: TraceStart = () =>
      manager.start(device, {
        template: args.template,
        categories: args.categories,
        bufferMb: args.bufferMb,
        appId: args.appId,
        timeLimitMs: args.timeLimitMs ?? PERFORMANCE_TRACE_DEFAULT_TIME_LIMIT_MS,
        ownerSessionUuid: args.sessionUuid,
        signal,
      });
    const owner = { sessionUuid: args.sessionUuid, deviceId: device.deviceId };
    const started = deps.sessionHost
      ? await startOwned(manager, deps.sessionHost(), owner, start)
      : await startOwned(manager, defaultDaemonContext.sessionManager(), owner, start);
    return createStructuredToolResponse({ success: true, action: args.action, ...started });
  };
}

/**
 * Register the tool and subscribe its release cleanup; returns the unsubscribe.
 * Re-registering replaces the previous subscription.
 */
export function registerPerformanceTraceTools(
  manager: PerformanceTraceManager = getDefaultPerformanceTraceManager(),
  cleanupHost: () => TraceCleanupHost | undefined = () => defaultDaemonContext.sessionManager(),
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
  const unsubscribe = subscribeTraceCleanup(manager, cleanupHost);
  unsubscribeTraceCleanup = unsubscribe;
  return () => {
    unsubscribe();
    if (unsubscribeTraceCleanup === unsubscribe) {
      unsubscribeTraceCleanup = undefined;
    }
  };
}

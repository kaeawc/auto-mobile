import {
  parsePrototypeDegradedEffects,
  prototypeDegradedEffectsOutput,
} from "../../features/prototype/prototypeDegradedEffects";
import { performPrototypeSimulate } from "../prototypeSimulateAction";
import { PROTOTYPE_TIMERS_CAPABILITY } from "../../features/observe/android/ctrlProxyProtocol";
import { parsePrototypeFeedbackLog } from "../../features/prototype/prototypeFeedbackLog";
import { parsePrototypeTimerReports } from "../../features/prototype/prototypeTimerSchema";
import { z } from "zod/v4";
import {
  parsePrototypeStacks,
  prototypeInspectUnsupportedMessage,
} from "../../features/observe/android/CtrlProxyPrototypes";
import type {
  PrototypeEvent,
  PrototypeResult,
} from "../../features/observe/android/ctrlProxyProtocol";
import { PROTOTYPE_PERSISTENCE_REPLAY_CAPABILITY } from "../../features/observe/android/ctrlProxyProtocol";
import type { PrototypeEventSource } from "../../features/prototype/PrototypeEventCoordinator";
import { PrototypeEventCoordinator } from "../../features/prototype/PrototypeEventCoordinator";
import {
  type PrototypeScope,
  type PrototypeStatusStore,
} from "../../features/prototype/PrototypeStatusStore";
import { prototypeEventSource } from "../../features/prototype/PrototypeTransport";
import { IOS_PROTOTYPE_INSPECT_CAPABILITY } from "../../features/prototype/ios/iosPrototypeTransport";
import {
  parsePrototypeAppearance,
  withoutCachedDeviceDark,
} from "../../features/prototype/prototypeAppearance";
import { parsePrototypeStorageReport } from "../../features/prototype/prototypeStorage";
import { PROTOTYPE_SUSPENDED_WAIT_WARNING } from "../../features/prototype/prototypeSuspended";
import type { BootedDevice } from "../../models";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import { combineWithAmbientAbort } from "../../utils/AbortContext";
import { logger } from "../../utils/logger";
import { withReverseReport } from "../prototypeReverse";
import { performPrototypeClearStorage } from "../prototypeStorageAction";
import type { ProgressCallback } from "../toolRegistry";
import { dataInput, prototypeSchema, stateInput } from "./schemas";
import type { PrototypeHandlerDependencies, PrototypeOutput, PrototypeTarget } from "./types";

const devicePrototypeEntrySchema = z.object({
  id: z.string().min(1),
  persistent: z.boolean(),
  state: stateInput,
  data: dataInput.optional(),
  pages: z.record(z.string(), z.number().int().nonnegative()).default({}),
  stacks: z.unknown().optional().transform(parsePrototypeStacks),
  lastSequence: z.number().int().nonnegative(),
  hiddenReason: z
    .enum(["app_layer_window_hidden", "device_blocked"])
    .optional()
    .catch(undefined)
    .describe(
      "Android: the prototype exists but is not visible, and why; absent when visible, when suspended, or with an older CtrlProxy",
    ),
  suspended: z.boolean().optional(),
  // Absent from a device without prototype_appearance_v1; a malformed one is dropped, not guessed.
  appearance: z.unknown().optional().transform(parsePrototypeAppearance),
  storage: z.unknown().optional().transform(parsePrototypeStorageReport),
  timers: z.unknown().optional(),
  feedbackLog: z.unknown().optional().transform(parsePrototypeFeedbackLog),
  shaderFailures: z.record(z.string(), z.string()).optional().catch(undefined),
  degradedEffects: z.unknown().optional().transform(parsePrototypeDegradedEffects),
});

function parseReportedPrototypes(
  prototypes: readonly unknown[] | undefined,
): z.infer<typeof devicePrototypeEntrySchema>[] {
  return (prototypes ?? []).flatMap((entry) => {
    const parsed = devicePrototypeEntrySchema.safeParse(entry);
    if (!parsed.success) {
      logger.warn("[prototype] Ignoring malformed prototype in inspect reply", parsed.error);
      return [];
    }
    return [parsed.data];
  });
}

/** Events the device replayed before its reply, grouped by prototype id in wire order. */
function groupByPrototype(events: readonly PrototypeEvent[]): Map<string, PrototypeEvent[]> {
  const grouped = new Map<string, PrototypeEvent[]>();
  for (const event of events) {
    grouped.set(event.id, [...(grouped.get(event.id) ?? []), event]);
  }
  return grouped;
}

/**
 * The report is authoritative for what the device shows: a prototype this host still lists that the
 * device neither reports nor ended with a replayed terminal event is gone (for example CtrlProxy
 * restarted), including when the report is empty.
 */
function dropUnreportedPrototypes(
  store: PrototypeStatusStore,
  events: PrototypeEventCoordinator,
  scope: PrototypeScope,
  reportedIds: ReadonlySet<string>,
): void {
  // Shown ids are device-wide, so stale ids are enumerated across every session: a
  // session that tracked the vanished prototype is not necessarily the one inspecting.
  for (const id of store.shownIds(scope.deviceId)) {
    if (!reportedIds.has(id)) {
      events.dismiss(scope.deviceId, id);
      store.dismissed(scope, id);
    }
  }
}

/** Hands the device's report and the events it replayed to the event buffers and status store. */
function adoptReportedPrototypes(
  store: PrototypeStatusStore,
  events: PrototypeEventCoordinator,
  source: PrototypeEventSource,
  {
    scope,
    report,
  }: {
    scope: PrototypeScope;
    report: {
      prototypes: readonly unknown[] | undefined;
      replayed: readonly PrototypeEvent[];
      timersSupported: boolean;
    };
  },
): void {
  const { prototypes, replayed, timersSupported } = report;
  const reported = parseReportedPrototypes(prototypes);
  const reportedIds = new Set(reported.map((entry) => entry.id));
  const history = groupByPrototype(replayed);
  for (const [id, grouped] of history) {
    // A prototype that ended while no host was connected is not reported, but its terminal event
    // still belongs to whoever awaits it.
    if (reportedIds.has(id) || grouped.some((event) => event.kind === "dismissed")) {
      const entry = reported.find((known) => known.id === id);
      events.adopt(scope, id, source, {
        replayed: grouped,
        lastSequence: entry?.lastSequence ?? 0,
      });
    }
  }
  dropUnreportedPrototypes(store, events, scope, reportedIds);
  for (const entry of reported) {
    if (!history.has(entry.id)) {
      events.adopt(scope, entry.id, source, { replayed: [], lastSequence: entry.lastSequence });
    }
    if (!events.isDismissed(scope, entry.id)) {
      store.adopt(scope, {
        ...entry,
        storage: parsePrototypeStorageReport(entry.storage),
        timers: timersSupported
          ? entry.timers === undefined
            ? []
            : parsePrototypeTimerReports(entry.timers)
          : undefined,
      });
    }
  }
}

/**
 * Asks the device which prototypes it is showing and adopts them into host status and event
 * buffers, so `status` and `awaitEvent` work after a session release or a daemon restart. The
 * device replays events it buffered while no host was connected before it answers, so the capture
 * starts before the request. Refused, before anything is sent, on a CtrlProxy without
 * prototype_persistence_replay_v1.
 */
async function inspectDevice(
  dependencies: Pick<PrototypeHandlerDependencies, "store" | "events">,
  target: PrototypeTarget,
  scope: PrototypeScope,
  { timeoutMs, signal }: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<PrototypeOutput> {
  const { store, events } = dependencies;
  const client = target.android;
  if (!client) {
    if (target.ios) {
      return inspectIosAgent({ store, events }, target, target.ios, scope);
    }
    throw new ActionableError("inspect needs an Android device or an iOS simulator agent.");
  }
  // The device drains its offline ring from onClientConnected, which the capability probe below can
  // trigger by connecting, so the capture must be listening before the first operation.
  const replayed: PrototypeEvent[] = [];
  const stopCapture = client.onEvent((event) => replayed.push(event));
  let result: PrototypeResult;
  try {
    const supported = await client.supportsCommand(PROTOTYPE_PERSISTENCE_REPLAY_CAPABILITY);
    // A cancelled inspect must not send its request after the capability lookup.
    signal?.throwIfAborted();
    if (!supported) {
      return {
        success: false,
        error: new ActionableError(prototypeInspectUnsupportedMessage()).message,
      };
    }
    result = await client.inspect(timeoutMs);
  } catch (error) {
    signal?.throwIfAborted();
    logger.warn("[prototype] Inspect request failed", error);
    return { success: false, error: toActionableError(error, "Prototype inspect failed").message };
  } finally {
    stopCapture();
  }
  if (!result.success) {
    return { success: false, error: result.error ?? "Prototype inspect failed" };
  }
  adoptReportedPrototypes(store, events, prototypeEventSource(target.transport), {
    scope,
    report: {
      prototypes: result.prototypes,
      replayed,
      timersSupported: await client.supportsCommand(PROTOTYPE_TIMERS_CAPABILITY),
    },
  });
  return {
    success: true,
    ...statusOutput(store, events, scope, { deviceDark: "fresh" }),
    deviceDroppedEvents: result.droppedEvents ?? 0,
  };
}

/** inspect and clearStorage: one request to the resolved target, with no spec or assets. */
export function isDeviceRequestAction(
  action: string,
): action is "inspect" | "clearStorage" | "simulate" {
  return action === "inspect" || action === "clearStorage" || action === "simulate";
}

export async function deviceRequestAction(
  args: z.infer<typeof prototypeSchema>,
  host: Pick<PrototypeHandlerDependencies, "store" | "events" | "reverses">,
  device: BootedDevice,
  {
    target,
    scope,
    signal,
  }: { target: PrototypeTarget; scope: PrototypeScope; signal: AbortSignal | undefined },
): Promise<PrototypeOutput> {
  if (args.action === "simulate") {
    return performPrototypeSimulate(target, args);
  }
  if (args.action === "clearStorage") {
    return performPrototypeClearStorage(target, args, host.store, device.deviceId);
  }
  const inspected = await inspectDevice(host, target, scope, { timeoutMs: args.timeoutMs, signal });
  return withReverseReport(inspected, host.reverses.report(device.deviceId));
}

const iosAgentStatusSchema = z.object({
  shown: z.boolean(),
  id: z.string().min(1).nullable(),
  pages: z.record(z.string(), z.number().int().nonnegative()).default({}),
  stacks: z.unknown().optional().transform(parsePrototypeStacks),
  state: stateInput,
  data: dataInput.optional(),
  lastSequence: z.number().int().nonnegative(),
  // Flat on the status (the agent holds one prototype); absent when nothing is shown and from an
  // agent without prototype_appearance_v1.
  appearance: z.unknown().optional().transform(parsePrototypeAppearance),
  storage: z.unknown().optional().transform(parsePrototypeStorageReport),
  timers: z.unknown().optional(),
  feedbackLog: z.unknown().optional().transform(parsePrototypeFeedbackLog),
  degradedEffects: z.unknown().optional().transform(parsePrototypeDegradedEffects),
});

/**
 * iOS inspect: the injected agent holds at most one prototype and dies with the app, so its status
 * is the whole report. There is no offline event buffer to replay, no persistence and no
 * foreground suspension, so the reported prototype carries no `suspended` and the result no
 * `deviceDroppedEvents`. An agent without prototype_inspect_v1 reports no sequence; it is refused
 * with a relaunch hint rather than adopted with a guessed one.
 */
async function inspectIosAgent(
  dependencies: Pick<PrototypeHandlerDependencies, "store" | "events">,
  target: PrototypeTarget,
  ios: NonNullable<PrototypeTarget["ios"]>,
  scope: PrototypeScope,
): Promise<PrototypeOutput> {
  const { store, events } = dependencies;
  if (!ios.supportsCapability(IOS_PROTOTYPE_INSPECT_CAPABILITY)) {
    return {
      success: false,
      error: new ActionableError(
        `inspect: the connected prototype agent does not advertise ${IOS_PROTOTYPE_INSPECT_CAPABILITY}; relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version.`,
      ).message,
    };
  }
  let reply: Awaited<ReturnType<typeof ios.status>>;
  try {
    reply = await ios.status();
  } catch (error) {
    logger.warn("[prototype] iOS inspect request failed", error);
    return { success: false, error: toActionableError(error, "Prototype inspect failed").message };
  }
  if (!reply.success) {
    return { success: false, error: reply.error ?? "Prototype inspect failed" };
  }
  const status = iosAgentStatusSchema.safeParse(reply.status);
  if (!status.success) {
    logger.warn("[prototype] Malformed iOS agent status in inspect reply", status.error);
    return {
      success: false,
      error: "Prototype inspect failed: the agent returned a malformed status.",
    };
  }
  const {
    shown,
    id,
    pages,
    stacks,
    state,
    data,
    lastSequence,
    appearance,
    storage,
    timers,
    feedbackLog,
    degradedEffects,
  } = status.data;
  const reported =
    shown && id !== null
      ? [
          {
            id,
            persistent: false,
            state,
            data,
            pages,
            stacks,
            lastSequence,
            appearance,
            storage,
            timers,
            feedbackLog,
            degradedEffects,
          },
        ]
      : [];
  adoptReportedPrototypes(store, events, prototypeEventSource(target.transport), {
    scope,
    report: {
      prototypes: reported,
      replayed: [],
      timersSupported: ios.supportsCapability(PROTOTYPE_TIMERS_CAPABILITY),
    },
  });
  return { success: true, ...statusOutput(store, events, scope, { deviceDark: "fresh" }) };
}

/**
 * `fresh` is for an inspect that has just adopted the device's answer: its entries may carry the
 * device-reported `deviceDark`. The host-local `status` action passes `cached` and never reports it,
 * and neither does any `lastResult` here: that is the record of an earlier request (#11416).
 */
export function statusOutput(
  store: PrototypeStatusStore,
  events: PrototypeEventCoordinator,
  scope: PrototypeScope,
  options: { deviceDark: "fresh" | "cached" },
): Pick<PrototypeOutput, "prototypes" | "lastResult"> {
  const status = store.status(scope);
  return {
    ...status,
    prototypes: status.prototypes.map((shown) => {
      const cached = options.deviceDark === "fresh" ? shown : withoutCachedDeviceDark(shown);
      const entry = { ...cached, ...prototypeDegradedEffectsOutput(cached.degradedEffects) };
      const counts = entry.id ? events.counts(scope, entry.id) : undefined;
      return counts?.lastSequence === undefined ? entry : { ...entry, ...counts };
    }),
    ...(status.lastResult ? { lastResult: withoutCachedDeviceDark(status.lastResult) } : {}),
  };
}

/** A timed-out wait on a prototype the device last reported hidden explains why nothing came. */
export function suspendedWaitWarning(
  store: PrototypeStatusStore,
  scope: PrototypeScope,
  id: string | undefined,
  waited: { timedOut?: true },
): { warning?: string } {
  const suspended = store
    .status(scope)
    .prototypes.some((entry) => entry.id === id && entry.suspended === true);
  return suspended && waited.timedOut ? { warning: PROTOTYPE_SUSPENDED_WAIT_WARNING } : {};
}

function notifyPrototypeWaitProgress(
  progress: ProgressCallback | undefined,
  completed: boolean,
): void {
  if (!progress) {
    return;
  }
  // Transport notifications are best-effort and must not extend the bounded wait.
  void Promise.resolve()
    .then(() =>
      progress(
        completed ? 1 : 0,
        1,
        completed ? "Prototype event wait finished" : "Waiting for a prototype event",
      ),
    )
    .catch((error) => {
      logger.warn("[prototype] Wait progress notification failed", error);
    });
}

/** The coordinator's wait: timeout, cancel, release, removal and dismissal all settle it. */
export async function waitForPrototypeEvent(
  events: PrototypeEventCoordinator,
  scope: PrototypeScope,
  source: PrototypeEventSource,
  {
    query,
    context,
  }: {
    query: Pick<
      z.infer<typeof prototypeSchema>,
      "id" | "eventName" | "kind" | "afterSequence" | "timeoutMs"
    >;
    context: { progress?: ProgressCallback; signal?: AbortSignal };
  },
) {
  const waiting = events.awaitEvent(scope, query.id!, source, {
    eventName: query.eventName,
    kind: query.kind,
    afterSequence: query.afterSequence,
    timeoutMs: query.timeoutMs,
    signal: combineWithAmbientAbort(context.signal),
  });
  notifyPrototypeWaitProgress(context.progress, false);
  try {
    return await waiting;
  } finally {
    notifyPrototypeWaitProgress(context.progress, true);
  }
}

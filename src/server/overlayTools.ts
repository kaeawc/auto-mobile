import { z } from "zod/v4";
import { z as specZ, type ZodTypeAny } from "zod";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { SessionReleaseBroadcaster } from "./sessionReleaseBroadcast";
import { getDaemonStreamDeviceLifecycleEmitter } from "../daemon/streamDeviceLifecycleEvents";
import { OverlayEventCoordinator } from "../features/overlay/OverlayEventCoordinator";
import {
  DEFAULT_OVERLAY_EVENT_TIMEOUT_MS,
  MAX_OVERLAY_EVENT_TIMEOUT_MS,
} from "../features/overlay/overlayEventTimeout";
import { DaemonState } from "../daemon/daemonState";
import type { OverlayMutation } from "../features/overlay/OverlayStatusStore";
import { defaultTimer } from "../utils/SystemTimer";
import { combineWithAmbientAbort } from "../utils/AbortContext";
import type { ProgressCallback } from "./toolRegistry";
import { ToolRegistry } from "./toolRegistry";
import { addDeviceTargetingToSchema, withJsonSchemaOverride } from "./toolSchemaHelpers";
import { ActionableError, toActionableError } from "../models/ActionableError";
import type { BootedDevice } from "../models";
import { AndroidCtrlProxyClient } from "../features/observe/android/AndroidCtrlProxyClient";
import { overlayDisplayUnsupportedMessage } from "../features/observe/android/CtrlProxyOverlays";
import { OVERLAY_DISPLAY_CAPABILITY } from "../features/observe/android/ctrlProxyProtocol";
import type {
  OverlayDismiss,
  OverlayResult,
  OverlayUpdate,
} from "../features/observe/android/ctrlProxyProtocol";
import { overlaySpecSchema, type OverlaySpec } from "../features/overlay/overlaySpec";
import { validateOverlaySpec } from "../features/overlay/overlayValidation";
import {
  resolveOverlayDisplayId,
  type OverlayDisplayDependencies,
} from "../features/overlay/overlayDisplay";
import {
  InMemoryOverlayStatusStore,
  type OverlayStatusStore,
  type OverlayScope,
} from "../features/overlay/OverlayStatusStore";
import type { Timer } from "../utils/SystemTimer";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../utils/android-cmdline-tools/AdbClientFactory";
import { getToolSelectionContext } from "../features/toolSelection/toolSelectionContext";
import { createStructuredToolResponse, withIsErrorOnFailure } from "../utils/toolUtils";
import { logger } from "../utils/logger";
import { deleteInternalToolParams } from "../daemon/constants";

// The settled spec is Zod 3; registry/device targeting use Zod 4. The installed
// MCP SDK converts the original schema, avoiding a second authored spec schema.
// The SDK union of Zod 3/4 schemas exceeds TS instantiation depth; this call accepts only Zod 3.
// oxlint-disable-next-line auto-mobile/no-unknown-cast -- Narrow the SDK converter at the Zod 3/4 boundary.
const convertSpec = toJsonSchemaCompat as unknown as (
  schema: ZodTypeAny,
) => Record<string, unknown>;
const advertisedSpec = convertSpec(overlaySpecSchema);
function rehomeSpecReferences(value: unknown): void {
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref" && typeof child === "string" && child.startsWith("#")) {
      (value as Record<string, unknown>)[key] = `#/properties/spec${child.slice(1)}`;
    } else {
      rehomeSpecReferences(child);
    }
  }
}
rehomeSpecReferences(advertisedSpec);
delete advertisedSpec.$schema;
const specDetailsSchema = specZ.object({ spec: overlaySpecSchema });
const stateDetailsSchema = overlaySpecSchema.pick({ state: true });

function specError(spec: unknown): string | undefined {
  const validated = validateOverlaySpec(spec);
  if (validated.success) {
    return undefined;
  }
  const { path, message } = validated.error;
  // Nested authored values are not tool metadata. Strip only the envelope so
  // reserved names inside state remain valid user keys.
  const external = { spec };
  deleteInternalToolParams(external);
  // The contract supplies deterministic paths/limits; Zod supplies allowed enum
  // values and numeric bounds. Avoid recursing into inputs that exceed limits.
  const details = /limit|depth|budget/i.test(message)
    ? undefined
    : specDetailsSchema.safeParse(external);
  return `Invalid overlay at spec.${path}: ${message}${details && !details.success ? `; ${details.error.message}` : ""}`;
}

const specInput = withJsonSchemaOverride(
  z.unknown().superRefine((value, ctx) => {
    const error = specError(value);
    if (error) {
      ctx.addIssue({ code: "custom", message: error });
    }
  }),
  (jsonSchema) => Object.assign(jsonSchema, advertisedSpec),
);
const stateInput = z
  .record(z.string(), z.union([z.string(), z.number().finite(), z.boolean()]))
  .superRefine((value, ctx) => {
    const external = { state: value };
    deleteInternalToolParams(external);
    if (!stateDetailsSchema.safeParse(external).success) {
      ctx.addIssue({
        code: "custom",
        message:
          "Invalid overlay at state: use flat string, number or boolean values and keys matching [A-Za-z_][A-Za-z0-9_]{0,63}",
      });
    }
  });

export const overlaySchema = addDeviceTargetingToSchema(
  z
    .object({
      action: z.enum(["show", "update", "dismiss", "status", "awaitEvent"]),
      spec: specInput
        .optional()
        .describe(
          "Full overlay spec: id, window, optional state, root. window.opacity is 0-100, default 100.",
        ),
      display: z
        .string()
        .optional()
        .describe(
          "show only: panel key, role, or active to show the overlay on. Precedence: explicit display, then the session display pin, then the default display. Needs a CtrlProxy advertising overlay_display_id_v1; a disconnected panel is refused.",
        ),
      id: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Overlay id required for update, dismiss or awaitEvent; must equal spec.id on update",
        ),
      state: stateInput
        .optional()
        .describe("Flat state patch for update; use either spec or state"),
      all: z.literal(true).optional().describe("Dismiss all overlays on the targeted device"),
      eventName: z.string().min(1).optional().describe("awaitEvent only: filter event name"),
      kind: z
        .enum(["emit", "page_changed", "dismissed"])
        .optional()
        .describe("awaitEvent only: filter event kind"),
      afterSequence: z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER)
        .optional()
        .describe("awaitEvent only: return a sequence strictly above this cursor"),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          `Device request timeout; awaitEvent defaults to ${DEFAULT_OVERLAY_EVENT_TIMEOUT_MS} ms, maximum ${MAX_OVERLAY_EVENT_TIMEOUT_MS} ms; timeout is a successful empty result`,
        ),
    })
    .strict(),
).superRefine((value, ctx) => {
  const fields = [
    "spec",
    "id",
    "state",
    "all",
    "display",
    "eventName",
    "kind",
    "afterSequence",
  ] as const;
  const allowed: Record<typeof value.action, readonly string[]> = {
    show: ["spec", "display"],
    update: ["id", "spec", "state"],
    dismiss: ["id", "all"],
    status: [],
    awaitEvent: ["id", "eventName", "kind", "afterSequence"],
  };
  for (const field of fields) {
    if (value[field] !== undefined && !allowed[value.action].includes(field)) {
      ctx.addIssue({
        code: "custom",
        path: [field],
        message: `${value.action} allows ${allowed[value.action].join(", ") || "no mutation fields"}`,
      });
    }
  }
  if (value.action === "awaitEvent") {
    validateAwaitEventInput(value, ctx);
  }
  if (value.action === "show" && value.spec === undefined) {
    ctx.addIssue({ code: "custom", path: ["spec"], message: "show requires spec" });
  }
  if (value.action === "update") {
    validateUpdateInput(value, ctx);
  }
  if (value.action === "dismiss" && (value.id === undefined) === (value.all === undefined)) {
    ctx.addIssue({
      code: "custom",
      path: ["id"],
      message: "dismiss requires exactly one of id or all: true",
    });
  }
});

function validateAwaitEventInput(value: z.infer<typeof overlaySchema>, ctx: z.RefinementCtx): void {
  if (value.id === undefined) {
    ctx.addIssue({ code: "custom", path: ["id"], message: "awaitEvent requires id" });
  }
  if (value.timeoutMs !== undefined && value.timeoutMs > MAX_OVERLAY_EVENT_TIMEOUT_MS) {
    ctx.addIssue({
      code: "custom",
      path: ["timeoutMs"],
      message: `awaitEvent timeoutMs must not exceed ${MAX_OVERLAY_EVENT_TIMEOUT_MS}`,
    });
  }
}

function validateUpdateInput(value: z.infer<typeof overlaySchema>, ctx: z.RefinementCtx): void {
  if (!value.id || (value.spec === undefined) === (value.state === undefined)) {
    ctx.addIssue({
      code: "custom",
      path: ["id"],
      message: "update requires id and exactly one of spec or state",
    });
  }
  if (value.spec === undefined) {
    return;
  }
  const validated = validateOverlaySpec(value.spec);
  if (validated.success && validated.data.id !== value.id) {
    ctx.addIssue({ code: "custom", path: ["spec", "id"], message: "spec.id must equal update id" });
  }
}

function overlayScope(device: BootedDevice, args: z.infer<typeof overlaySchema>): OverlayScope {
  const context = getToolSelectionContext();
  return {
    sessionUuid:
      args.sessionUuid ?? context?.routingSessionUuid ?? context?.toolSelectionProfileUuid,
    deviceId: device.deviceId,
  };
}

const lastResultSchema = z.object({
  id: z.string().optional(),
  all: z.literal(true).optional(),
  lastAction: z.enum(["show", "update", "dismiss"]),
  displayId: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Android logical display the overlay was shown on; absent for the default display"),
  success: z.boolean(),
  error: z.string().optional(),
  totalTimeMs: z.number().optional(),
  timestamp: z.number().describe("Host clock milliseconds when the request completed"),
});
const eventCountsSchema = z.object({
  pendingCount: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Unconsumed events, including events excluded by filters or cursor"),
  lastSequence: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Highest sequence accepted for this overlay"),
  droppedCount: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Cumulative events dropped by buffer overflow in this scope"),
});
const overlayEventOutputSchema = z.object({
  id: z.string(),
  sequence: z.number().int().nonnegative(),
  kind: z.enum(["emit", "page_changed", "dismissed"]),
  name: z.string().nullable(),
  payload: z.json(),
  state: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  pages: z.record(z.string(), z.number().int().nonnegative()),
  timestamp: z.number(),
});
export const overlayOutputSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  overlays: z.array(lastResultSchema.extend(eventCountsSchema.shape)).optional(),
  lastResult: lastResultSchema.optional(),
  event: overlayEventOutputSchema.optional(),
  timedOut: z
    .literal(true)
    .optional()
    .describe("awaitEvent reached its timeout without a matching event; success remains true"),
  reason: z
    .literal("dismissed")
    .optional()
    .describe("The overlay scope ended without a matching event"),
  ...eventCountsSchema.shape,
});

export interface OverlayEventLifecycle {
  /** `releasedDeviceId` is the device named by the release snapshot, when one exists. */
  subscribeSessionRelease(
    listener: (sessionUuid: string, releasedDeviceId?: string) => void,
  ): () => void;
  subscribeDeviceRemoval(listener: (deviceId: string) => void): () => void;
  subscribeDeviceUnbound(listener: (deviceId: string) => void): () => void;
}
type OverlayClient = Pick<
  AndroidCtrlProxyClient,
  | "requestShowOverlay"
  | "requestUpdateOverlay"
  | "requestDismissOverlay"
  | "onOverlayEvent"
  | "supportsCommand"
>;
export interface OverlayToolDependencies {
  clientFactory?: (device: BootedDevice) => OverlayClient;
  adbFactory?: AdbClientFactory;
  lastRenderedObservation?: OverlayDisplayDependencies["lastRenderedObservation"];
  store?: OverlayStatusStore;
  clock?: Pick<Timer, "now">;
  timer?: Timer;
  lifecycle?: OverlayEventLifecycle;
}
const responseFor = (payload: z.infer<typeof overlayOutputSchema>) =>
  withIsErrorOnFailure(createStructuredToolResponse(payload), payload.success);
let unsubscribeOverlayLifecycle: (() => void) | undefined;

// Validation has already succeeded. Forward authored specs unchanged; omitted
// defaults (including opacity=100) remain the wire contract's defaults.
async function mutate(
  client: OverlayClient,
  args: z.infer<typeof overlaySchema>,
  displayId?: number,
): Promise<OverlayResult> {
  if (args.action === "show") {
    return client.requestShowOverlay(
      args.spec as OverlaySpec,
      args.timeoutMs,
      undefined,
      displayId,
    );
  }
  if (args.action === "update") {
    const update: OverlayUpdate =
      args.spec !== undefined
        ? { id: args.id!, spec: args.spec as OverlaySpec }
        : { id: args.id!, state: args.state! };
    return client.requestUpdateOverlay(update, args.timeoutMs);
  }
  const target: OverlayDismiss = args.all ? { all: true } : { id: args.id! };
  return client.requestDismissOverlay(target, args.timeoutMs);
}

/**
 * Resolves `display` (already explicit-or-pinned) to a logical display id and refuses, before
 * anything is sent, when the device cannot honour it. Only show carries a display.
 */
async function showDisplayId(
  client: OverlayClient,
  device: BootedDevice,
  args: z.infer<typeof overlaySchema>,
  dependencies: Pick<OverlayToolDependencies, "adbFactory" | "lastRenderedObservation">,
): Promise<number | undefined> {
  if (args.action !== "show" || args.display === undefined) {
    return undefined;
  }
  const displayId = await resolveOverlayDisplayId(device, args.display, {
    adb: (dependencies.adbFactory ?? defaultAdbClientFactory).create(device),
    lastRenderedObservation: dependencies.lastRenderedObservation,
  });
  // Id 0 is the default display: it needs neither the wire field nor the capability, and the
  // result schema leaves displayId absent for it, so it is never carried forward as 0.
  if (!displayId) {
    return undefined;
  }
  if (!(await client.supportsCommand(OVERLAY_DISPLAY_CAPABILITY))) {
    throw new ActionableError(overlayDisplayUnsupportedMessage(displayId));
  }
  return displayId;
}

function clearMutationEvents(
  events: OverlayEventCoordinator,
  scope: OverlayScope,
  target: { id?: string; all?: true },
  action: OverlayMutation,
  success: boolean,
  previouslyShown: boolean,
): void {
  if ((action === "dismiss" && success) || (action === "show" && !success && !previouslyShown)) {
    events.dismiss(scope.deviceId, target.id);
  }
}

function subscribeOverlayDeviceUnbound(listener: (deviceId: string) => void): () => void {
  const state = DaemonState.getInstance();
  if (!state.isInitialized()) {
    return () => {};
  }
  const manager = state.getSessionManager();
  // This removable hook observes the same rebind as onSessionDeviceUnbound,
  // including a forced same-serial replacement, without retaining callbacks.
  return manager.onDeviceOwnershipChange((deviceId, invalidation) => {
    if (invalidation === "full" || manager.getSessionForDevice(deviceId) === null) {
      listener(deviceId);
    }
  });
}

async function performMutation(
  dependencies: {
    store: OverlayStatusStore;
    events: OverlayEventCoordinator;
    clientFactory: (device: BootedDevice) => OverlayClient;
  } & Pick<OverlayToolDependencies, "adbFactory" | "lastRenderedObservation">,
  device: BootedDevice,
  args: Omit<z.infer<typeof overlaySchema>, "action"> & { action: OverlayMutation },
  scope: OverlayScope,
) {
  const { store, events, clientFactory } = dependencies;
  const target = args.all
    ? { all: true as const }
    : { id: args.action === "show" ? (args.spec as OverlaySpec).id : args.id };
  const client = clientFactory(device);
  const previouslyShown = store.status(scope).overlays.some((entry) => entry.id === target.id);
  if (args.action === "show") {
    events.show(scope, target.id!, client);
  }
  let result: OverlayResult;
  let displayId: number | undefined;
  try {
    displayId = await showDisplayId(client, device, args, dependencies);
    result = await mutate(client, args, displayId);
  } catch (error) {
    logger.warn("[overlay] Request failed", error);
    result = {
      success: false,
      error: toActionableError(error, "Overlay request failed").message,
    };
  }
  clearMutationEvents(events, scope, target, args.action, result.success, previouslyShown);
  if (args.action === "show" && result.success && target.id) {
    events.replaceShown(scope.deviceId, target.id);
  }
  const lastResult = store.record(scope, args.action, target, result, displayId);
  if (target.id && events.isDismissed(scope, target.id)) {
    store.dismissed(scope, target.id);
  }
  return responseFor({
    success: result.success,
    ...(result.error ? { error: result.error } : {}),
    lastResult,
  });
}

function notifyOverlayWaitProgress(
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
        completed ? "Overlay event wait finished" : "Waiting for an overlay event",
      ),
    )
    .catch((error) => {
      logger.warn("[overlay] Wait progress notification failed", error);
    });
}

function defaultOverlayLifecycle(): OverlayEventLifecycle {
  return {
    subscribeSessionRelease: (listener) =>
      SessionReleaseBroadcaster.subscribe((sessionUuid, _reason, snapshot) =>
        listener(sessionUuid, snapshot?.deviceId),
      ),
    subscribeDeviceRemoval: (listener) =>
      getDaemonStreamDeviceLifecycleEmitter().onDeviceRemoved(listener),
    subscribeDeviceUnbound: subscribeOverlayDeviceUnbound,
  };
}

/**
 * The single lifecycle mechanism: a released session (and the device its snapshot names),
 * a removed device and an unbound device all clear host status and event buffers.
 */
function subscribeOverlayCleanup(
  lifecycle: OverlayEventLifecycle,
  events: OverlayEventCoordinator,
): () => void {
  const cleanups = [
    lifecycle.subscribeSessionRelease((sessionUuid, releasedDeviceId) => {
      events.releaseSession(sessionUuid);
      if (releasedDeviceId) {
        events.releaseDevice(releasedDeviceId);
      }
    }),
    lifecycle.subscribeDeviceRemoval((deviceId) => events.releaseDevice(deviceId)),
    lifecycle.subscribeDeviceUnbound((deviceId) => events.releaseDevice(deviceId)),
  ];
  return () => {
    for (const cleanup of cleanups) {
      cleanup();
    }
  };
}

export function registerOverlayTools(dependencies: OverlayToolDependencies = {}): () => void {
  // Registry replacement makes the previous handler, store and event buffers obsolete.
  unsubscribeOverlayLifecycle?.();
  const store =
    dependencies.store ?? new InMemoryOverlayStatusStore(dependencies.clock ?? dependencies.timer);
  const clientFactory =
    dependencies.clientFactory ??
    ((device: BootedDevice) => AndroidCtrlProxyClient.getInstance(device));
  const events = new OverlayEventCoordinator(dependencies.timer ?? defaultTimer, store);
  const handler = async (
    device: BootedDevice,
    input: unknown,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    const external: Record<string, unknown> =
      input && typeof input === "object" && !Array.isArray(input) ? { ...input } : {};
    deleteInternalToolParams(external);
    const parsed = overlaySchema.safeParse(external);
    if (!parsed.success) {
      return responseFor({
        success: false,
        error: `Invalid overlay input: ${parsed.error.message}`,
      });
    }
    const args = parsed.data;
    if (device.platform !== "android") {
      const error = new ActionableError(
        "Overlays are Android only. Target an Android device with deviceId or sessionUuid.",
      );
      return responseFor({ success: false, error: error.message });
    }
    const scope = overlayScope(device, args);
    if (args.action === "status") {
      const status = store.status(scope);
      return responseFor({
        success: true,
        ...status,
        overlays: status.overlays.map((entry) => {
          const counts = entry.id ? events.counts(scope, entry.id) : undefined;
          return counts?.lastSequence === undefined ? entry : { ...entry, ...counts };
        }),
      });
    }
    if (args.action === "awaitEvent") {
      const waiting = events.awaitEvent(scope, args.id!, clientFactory(device), {
        eventName: args.eventName,
        kind: args.kind,
        afterSequence: args.afterSequence,
        timeoutMs: args.timeoutMs,
        signal: combineWithAmbientAbort(signal),
      });
      notifyOverlayWaitProgress(progress, false);
      try {
        return responseFor({ success: true, ...(await waiting) });
      } finally {
        notifyOverlayWaitProgress(progress, true);
      }
    }
    return performMutation(
      {
        store,
        events,
        clientFactory,
        adbFactory: dependencies.adbFactory,
        lastRenderedObservation: dependencies.lastRenderedObservation,
      },
      device,
      { ...args, action: args.action },
      scope,
    );
  };
  ToolRegistry.registerDeviceAware(
    "overlay",
    'Show, update (spec or flat state), dismiss (id or all:true), inspect host-local status, or awaitEvent for an overlay id on Android. awaitEvent returns one buffered event, supports eventName/kind and afterSequence, and times out successfully (timedOut:true); default 30000 ms, maximum 60000 ms. Buffer: 64 events per session/device/id; overflow drops oldest and reports droppedCount. Lower-or-equal sequences are ignored, including late arrivals and reconnect replays. Nodes: box/row/column, text/image/icon/spacer/textField, scroll/pager/tabBar/bottomNav/bottomSheet; actions: emit/setPage/setState/dismiss. Sizes and anchors use dp; window placement: fullscreen/sheet/floating, window.opacity: 0-100 (default 100). Example: {action:"show",spec:{id:"demo",window:{placement:{type:"fullscreen"},opacity:80},root:{type:"text",text:"Hello"}}}. Verify with observe; no screenshot is returned. Status makes no device request and includes pendingCount/lastSequence/droppedCount after events arrive. Device dismissed events remove shown status; the terminal event remains available until consumed or explicit show/dismiss. Awaiting consumes events; unmatched events remain buffered. Optional MCP progress reports wait start/finish without delaying the wait. Session release, device removal and unbinding clear buffers. A disconnect alone is not observed.',
    overlaySchema,
    handler,
    { defaultEnabled: false, outputSchema: overlayOutputSchema },
  );
  const unsubscribeCleanup = subscribeOverlayCleanup(
    dependencies.lifecycle ?? defaultOverlayLifecycle(),
    events,
  );
  const unsubscribe = () => {
    unsubscribeCleanup();
    events.dispose();
    if (unsubscribeOverlayLifecycle === unsubscribe) {
      unsubscribeOverlayLifecycle = undefined;
    }
  };
  unsubscribeOverlayLifecycle = unsubscribe;
  return unsubscribe;
}

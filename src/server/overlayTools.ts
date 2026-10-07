import { TelemetryRecorder } from "../features/telemetry/TelemetryRecorder";
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
import type { OverlayDismiss, OverlayResult } from "../features/observe/android/ctrlProxyProtocol";
import { overlaySpecSchema, type OverlaySpec } from "../features/overlay/overlaySpec";
import { validateOverlaySpec } from "../features/overlay/overlayValidation";
import {
  resolveOverlayDisplayId,
  type OverlayDisplayDependencies,
} from "../features/overlay/overlayDisplay";
import {
  InMemoryOverlayStatusStore,
  type OverlayLastResult,
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
import { getRemovedToolActionHint } from "../models/removedTools";
import {
  nodeOverlayAssetFileReader,
  prepareOverlayAssets,
  uploadOverlayAssets,
  type OverlayAssetFileReader,
  type OverlayObservationScreenshotReader,
  type UploadedOverlayAsset,
} from "../features/overlay/overlayAssetUploader";
import type { OverlayAssetUpload } from "../features/overlay/overlayAssets";
import {
  missingAssetsWarning,
  type MissingAssetRepair,
} from "../features/overlay/overlayMissingAssets";
import { readObservationScreenshotBytes } from "./observationResources";
import {
  MAX_OVERLAY_ASSET_COUNT,
  MAX_OVERLAY_ASSET_ID_LENGTH,
} from "../features/overlay/overlayAssets";

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

const assetsInput = z
  .array(
    z
      .object({
        id: z
          .string()
          .min(1)
          .max(MAX_OVERLAY_ASSET_ID_LENGTH)
          .describe("Opaque asset id that spec image nodes reference (image.asset)"),
        path: z
          .string()
          .min(1)
          .optional()
          .describe("Absolute path of a PNG, JPEG or WebP file the daemon can read"),
        observation: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Instead of path: an observation screenshot URI, automobile:observation/{deviceId}/{observationId}/screenshot (the observationScreenshotResourceUri that observe returns); it must still be that device's current observation",
          ),
      })
      .strict()
      .refine((entry) => (entry.path === undefined) !== (entry.observation === undefined), {
        message: "each asset needs exactly one of path or observation",
      }),
  )
  .min(1)
  .max(MAX_OVERLAY_ASSET_COUNT);

export const overlaySchema = addDeviceTargetingToSchema(
  z
    .object({
      action: z.enum(["show", "dismiss", "status", "awaitEvent"], {
        error: (issue) =>
          getRemovedToolActionHint("overlay", issue.input) ??
          "action must be one of show, dismiss, status or awaitEvent",
      }),
      spec: specInput
        .optional()
        .describe(
          "Full overlay spec: id, window, optional state, root. window.opacity is 0-100, default 100. show always renders the whole spec; spec.state is authoritative.",
        ),
      display: z
        .string()
        .optional()
        .describe(
          "show only: panel key, role, or active to show the overlay on. Precedence: explicit display, then the session display pin, then the default display. Needs a CtrlProxy advertising overlay_display_id_v1; a disconnected panel is refused. Ignored, with a warning, by a same-id show without reset, which keeps the display the overlay is on.",
        ),
      reset: z
        .boolean()
        .optional()
        .describe(
          "show only: when the overlay with spec.id is already shown, start it fresh (pager pages from the spec, display re-resolved) instead of replacing it in place",
        ),
      id: z
        .string()
        .min(1)
        .optional()
        .describe("Overlay id required for dismiss (unless all: true) and awaitEvent"),
      assets: assetsInput
        .optional()
        .describe(
          "show only: images to upload before the overlay is sent, as {id, path} with an absolute local file path or {id, observation} with an observation screenshot URI (PNG, JPEG or WebP, up to 4 MiB each, 16 MiB total, 32 assets). Reference each id from image nodes. Uploads are sequential; any failure fails the call before the overlay changes and names the assets already stored. If the device reports a supplied asset missing after the overlay is sent, it is re-uploaded and the overlay re-sent once.",
        ),
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
          `Device request timeout; awaitEvent defaults to ${DEFAULT_OVERLAY_EVENT_TIMEOUT_MS} ms, maximum ${MAX_OVERLAY_EVENT_TIMEOUT_MS} ms; timeout is a successful empty result.`,
        ),
    })
    .strict(),
).superRefine((value, ctx) => {
  const fields = [
    "spec",
    "id",
    "all",
    "display",
    "reset",
    "eventName",
    "kind",
    "afterSequence",
    "assets",
  ] as const;
  const allowed: Record<typeof value.action, readonly string[]> = {
    show: ["spec", "display", "reset", "assets"],
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
  lastAction: z.enum(["show", "dismiss"]),
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
  overlays: z
    .array(
      lastResultSchema.extend(eventCountsSchema.shape).extend({
        pages: z.record(z.string(), z.number().int().nonnegative()).optional(),
        state: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
        lastKnown: z
          .literal(true)
          .optional()
          .describe(
            "Pages and state are the last accepted overlay_event snapshot, not a live device query",
          ),
      }),
    )
    .optional(),
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
  uploadedAssets: z
    .array(z.object({ id: z.string(), mimeType: z.string(), bytes: z.number().int().positive() }))
    .optional()
    .describe(
      "show with assets: assets the device confirmed, also present on failure. They stay on the device until the overlay session ends.",
    ),
  missingAssets: z
    .array(z.string())
    .optional()
    .describe(
      "show: asset ids the overlay references that the device has no copy of; the overlay is shown with placeholders. Absent when none. Upload them with assets on a show.",
    ),
  warning: z
    .string()
    .optional()
    .describe(
      "show succeeded but needs attention: names what to do about missingAssets, or that display was ignored by a same-id show",
    ),
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
  | "requestDismissOverlay"
  | "requestPutOverlayAsset"
  | "onOverlayEvent"
  | "supportsCommand"
>;
export interface OverlayToolDependencies {
  /** Reads local files named by `assets`; tests inject an in-memory reader. */
  assetFileReader?: OverlayAssetFileReader;
  /** Resolves `assets[].observation` URIs; defaults to the observation screenshot resource. */
  observationScreenshotReader?: OverlayObservationScreenshotReader;
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
      args.reset,
    );
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

interface AssetStage {
  uploaded: UploadedOverlayAsset[];
  /** The validated uploads, kept so a missing asset can be re-sent without re-reading its source. */
  prepared: OverlayAssetUpload[];
  failure?: OverlayResult;
}

interface AssetReaders {
  assetFileReader: OverlayAssetFileReader;
  observationScreenshotReader: OverlayObservationScreenshotReader;
}

/** Upload every `assets` entry before the overlay is sent; a failure ends the call. */
async function stageAssets(
  client: OverlayClient,
  args: z.infer<typeof overlaySchema>,
  readers: AssetReaders,
  signal: AbortSignal | undefined,
): Promise<AssetStage> {
  if (args.assets === undefined) {
    return { uploaded: [], prepared: [] };
  }
  const prepared = await prepareOverlayAssets(
    args.assets,
    readers.assetFileReader,
    readers.observationScreenshotReader,
  );
  if ("error" in prepared) {
    return { uploaded: [], prepared: [], failure: { success: false, error: prepared.error } };
  }
  const outcome = await uploadOverlayAssets(client, prepared.assets, { signal, action: "show" });
  return {
    uploaded: outcome.uploaded,
    prepared: prepared.assets,
    ...(outcome.success ? {} : { failure: { success: false, error: outcome.error } }),
  };
}

async function runMutation(
  client: OverlayClient,
  args: z.infer<typeof overlaySchema>,
  displayId: number | undefined,
): Promise<OverlayResult> {
  try {
    return await mutate(client, args, displayId);
  } catch (error) {
    logger.warn("[overlay] Request failed", error);
    return { success: false, error: toActionableError(error, "Overlay request failed").message };
  }
}

interface MissingAssetRetry {
  result: OverlayResult;
  repair: MissingAssetRepair;
}

/**
 * The upload-then-cleared race: the device finished the show but lists assets this same
 * call uploaded as missing. Re-uploads those once and re-sends once. Bounded: never loops, honours
 * the abort signal, and keeps the first (successful) result when the repair cannot complete.
 */
async function retryMissingAssets(
  client: OverlayClient,
  args: z.infer<typeof overlaySchema>,
  stage: AssetStage,
  first: OverlayResult,
  signal: AbortSignal | undefined,
  displayId: number | undefined,
): Promise<MissingAssetRetry | undefined> {
  const missing = new Set(first.missingAssets);
  const again = stage.prepared.filter((asset) => missing.has(asset.id));
  if (again.length === 0) {
    return undefined;
  }
  const fail = (reason: string): MissingAssetRetry => ({
    result: first,
    repair: { kind: "retry-failed", reason },
  });
  if (signal?.aborted) {
    return fail("the request was cancelled");
  }
  const upload = await uploadOverlayAssets(client, again, { signal, action: "resend" });
  if (!upload.success) {
    return fail(upload.error ?? "upload failed");
  }
  if (signal?.aborted) {
    return fail("the request was cancelled before the overlay was re-sent");
  }
  // The re-send targets the display the first send resolved, never a re-resolved one.
  const second = await runMutation(client, args, displayId);
  return second.success
    ? { result: second, repair: { kind: "still-missing" } }
    : fail(second.error ?? "re-sending the overlay failed");
}

interface MutationOutcome {
  result: OverlayResult;
  warning?: string;
}

async function sendOverlay(
  client: OverlayClient,
  args: z.infer<typeof overlaySchema>,
  stage: AssetStage,
  signal: AbortSignal | undefined,
  displayId: number | undefined,
): Promise<MutationOutcome> {
  if (stage.failure) {
    return { result: stage.failure };
  }
  const first = await runMutation(client, args, displayId);
  if (!first.success || !first.missingAssets?.length) {
    return { result: first };
  }
  const retry = await retryMissingAssets(client, args, stage, first, signal, displayId);
  const result = retry?.result ?? first;
  if (!result.missingAssets?.length) {
    return { result };
  }
  return {
    result,
    warning: missingAssetsWarning({
      missing: result.missingAssets,
      supplied: new Set(stage.prepared.map((asset) => asset.id)),
      repair: retry?.repair,
    }),
  };
}

/** A refused display ends the call before any asset is uploaded or anything is sent. */
async function resolveShowDisplay(
  client: OverlayClient,
  device: BootedDevice,
  args: z.infer<typeof overlaySchema>,
  dependencies: Pick<OverlayToolDependencies, "adbFactory" | "lastRenderedObservation">,
): Promise<{ displayId?: number; failure?: OverlayResult }> {
  try {
    return { displayId: await showDisplayId(client, device, args, dependencies) };
  } catch (error) {
    logger.warn("[overlay] Request failed", error);
    return {
      failure: {
        success: false,
        error: toActionableError(error, "Overlay request failed").message,
      },
    };
  }
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

type OverlayHandlerDependencies = {
  store: OverlayStatusStore;
  events: OverlayEventCoordinator;
  clientFactory: (device: BootedDevice) => OverlayClient;
  assetReaders: AssetReaders;
} & Pick<OverlayToolDependencies, "adbFactory" | "lastRenderedObservation">;
type OverlayOutput = z.infer<typeof overlayOutputSchema>;

async function performMutation(
  dependencies: OverlayHandlerDependencies,
  device: BootedDevice,
  args: Omit<z.infer<typeof overlaySchema>, "action"> & { action: OverlayMutation },
  scope: OverlayScope,
  signal?: AbortSignal,
): Promise<OverlayOutput> {
  const { store, events, clientFactory, assetReaders } = dependencies;
  const target = args.all
    ? { all: true as const }
    : { id: args.action === "show" ? (args.spec as OverlaySpec).id : args.id };
  const client = clientFactory(device);
  const shown = store.status(scope).overlays.find((entry) => entry.id === target.id);
  const previouslyShown = shown !== undefined;
  if (args.action === "show") {
    events.show(scope, target.id!, client);
  }
  const resolved = await resolveShowDisplay(client, device, args, dependencies);
  const { displayId } = resolved;
  const stage: AssetStage = resolved.failure
    ? { uploaded: [], prepared: [], failure: resolved.failure }
    : await stageAssets(client, args, assetReaders, signal);
  const { result, warning } = await sendOverlay(client, args, stage, signal, displayId);
  clearMutationEvents(events, scope, target, args.action, result.success, previouslyShown);
  if (args.action === "show" && result.success && target.id) {
    events.replaceShown(scope.deviceId, target.id);
  }
  const placed = placedDisplay(args, shown, displayId, result.success);
  const lastResult = store.record(scope, args.action, target, result, placed.displayId);
  if (target.id && events.isDismissed(scope, target.id)) {
    store.dismissed(scope, target.id);
  }
  return {
    success: result.success,
    ...(result.error ? { error: result.error } : {}),
    lastResult,
    ...(stage.uploaded.length > 0 ? { uploadedAssets: stage.uploaded } : {}),
    ...missingAssetsOutput(result, [warning, placed.warning]),
  };
}

/**
 * The display an accepted mutation leaves the overlay on. A same-id show without reset is replaced
 * in place on the device, on the display it is already on, so a different requested display is
 * ignored and the caller is told so.
 */
function placedDisplay(
  args: Pick<z.infer<typeof overlaySchema>, "action" | "reset" | "display">,
  shown: OverlayLastResult | undefined,
  displayId: number | undefined,
  success: boolean,
): { displayId?: number; warning?: string } {
  if (args.action !== "show" || shown?.id === undefined || args.reset === true) {
    return { displayId };
  }
  if (!success || args.display === undefined || displayId === shown.displayId) {
    return { displayId: shown.displayId };
  }
  const where =
    shown.displayId === undefined ? "the default display" : `logical display ${shown.displayId}`;
  return {
    displayId: shown.displayId,
    warning: `display was ignored: overlay ${shown.id} is already shown on ${where}, and a show with the same id replaces it in place there. Pass reset: true to show it fresh on the requested display.`,
  };
}

function missingAssetsOutput(
  result: OverlayResult,
  warnings: readonly (string | undefined)[],
): { missingAssets?: string[]; warning?: string } {
  const warning = warnings.filter((entry) => entry !== undefined).join(" ");
  return {
    ...(result.success && result.missingAssets?.length
      ? { missingAssets: result.missingAssets }
      : {}),
    ...(warning ? { warning } : {}),
  };
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

/** The coordinator's wait: timeout, cancel, release, removal and dismissal all settle it. */
async function waitForOverlayEvent(
  events: OverlayEventCoordinator,
  scope: OverlayScope,
  client: OverlayClient,
  query: Pick<
    z.infer<typeof overlaySchema>,
    "id" | "eventName" | "kind" | "afterSequence" | "timeoutMs"
  >,
  context: { progress?: ProgressCallback; signal?: AbortSignal },
) {
  const waiting = events.awaitEvent(scope, query.id!, client, {
    eventName: query.eventName,
    kind: query.kind,
    afterSequence: query.afterSequence,
    timeoutMs: query.timeoutMs,
    signal: combineWithAmbientAbort(context.signal),
  });
  notifyOverlayWaitProgress(context.progress, false);
  try {
    return await waiting;
  } finally {
    notifyOverlayWaitProgress(context.progress, true);
  }
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
  const events = new OverlayEventCoordinator(
    dependencies.timer ?? defaultTimer,
    store,
    TelemetryRecorder.getInstance(),
  );
  const assetReaders: AssetReaders = {
    assetFileReader: dependencies.assetFileReader ?? nodeOverlayAssetFileReader,
    observationScreenshotReader:
      dependencies.observationScreenshotReader ?? readObservationScreenshotBytes,
  };
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
      const waited = await waitForOverlayEvent(events, scope, clientFactory(device), args, {
        progress,
        signal,
      });
      return responseFor({ success: true, ...waited });
    }
    const handlerDependencies: OverlayHandlerDependencies = {
      store,
      events,
      clientFactory,
      assetReaders,
      adbFactory: dependencies.adbFactory,
      lastRenderedObservation: dependencies.lastRenderedObservation,
    };
    return responseFor(
      await performMutation(
        handlerDependencies,
        device,
        { ...args, action: args.action },
        scope,
        combineWithAmbientAbort(signal),
      ),
    );
  };
  ToolRegistry.registerDeviceAware(
    "overlay",
    'Show (always a full spec), dismiss (id or all:true), inspect host-local status, or awaitEvent for an overlay id on Android. A show with the id of the overlay already on screen replaces it in place: it keeps the display and each pager\'s page (clamped), while the new spec\'s state is authoritative (values the user changed by tapping are not carried over unless the spec includes them); reset:true starts fresh instead. To present alternatives, show one design, describe it and the others in chat (what each is, what changed, which you recommend), and show the next on request; or show one spec whose pager holds every design with a visible label per page. Ask the user in chat which they prefer; never wait on the device for a choice. awaitEvent returns one buffered event, supports eventName/kind and afterSequence, and times out successfully (timedOut:true); default 30000 ms, maximum 60000 ms. Buffer: 64 events per session/device/id; overflow drops oldest and reports droppedCount. Lower-or-equal sequences are ignored, including late arrivals and reconnect replays. Nodes: box/row/column, text/image/icon/spacer/textField, scroll/pager/tabBar/bottomNav/bottomSheet; actions: emit/setPage/setState/dismiss. Sizes and anchors use dp; window placement: fullscreen/sheet/floating, window.opacity: 0-100 (default 100). Example: {action:"show",spec:{id:"demo",window:{placement:{type:"fullscreen"},opacity:80},root:{type:"text",text:"Hello"}}}. show also accepts assets:[{id,path}] (absolute local PNG/JPEG/WebP file path) or [{id,observation}] (an observation screenshot URI) uploaded before the overlay is sent; image nodes reference the id. If the device reports supplied assets missing, they are re-uploaded and the overlay re-sent once; missingAssets and warning report what is still missing. Verify with observe; no screenshot is returned. Status makes no device request and includes pendingCount/lastSequence/droppedCount after events arrive. Device dismissed events remove shown status; the terminal event remains available until consumed or explicit show/dismiss. Awaiting consumes events; unmatched events remain buffered. Optional MCP progress reports wait start/finish without delaying the wait. Session release, device removal and unbinding clear buffers. A disconnect alone is not observed.',
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

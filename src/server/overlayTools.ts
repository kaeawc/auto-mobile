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
import {
  overlayDisplayUnsupportedMessage,
  overlayInspectUnsupportedMessage,
} from "../features/observe/android/CtrlProxyOverlays";
import {
  OVERLAY_DISPLAY_CAPABILITY,
  OVERLAY_PERSISTENCE_REPLAY_CAPABILITY,
  OVERLAY_WINDOW_OPTIONS_CAPABILITY,
} from "../features/observe/android/ctrlProxyProtocol";
import type {
  OverlayDismiss,
  OverlayEvent,
  OverlayResult,
  OverlayStatusEntry,
  OverlayUpdate,
} from "../features/observe/android/ctrlProxyProtocol";
import {
  overlaySpecSchema,
  placementSchema,
  type OverlaySpec,
} from "../features/overlay/overlaySpec";
import {
  composeVariantCarousel,
  parseVariantSelection,
  variantListSchema,
  MAX_VARIANTS,
  MAX_VARIANT_LABEL_LENGTH,
} from "../features/overlay/overlayVariants";
import { validateOverlaySpec } from "../features/overlay/overlayValidation";
import {
  grantOverlayAppLayer,
  overlayWindowOptionsUnsupportedMessage,
  requestedOverlayWindowOptions,
} from "../features/overlay/overlayWindowOptions";
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
/**
 * The contract and validator reject `theme: {}` and `theme.colors: {}`, but a Zod refinement has no
 * JSON Schema form, so state it on the advertised schema for schema-driven clients.
 */
function requireNonEmptyThemeObjects(spec: Record<string, unknown>): void {
  const theme = (spec.properties as Record<string, Record<string, unknown>> | undefined)?.theme;
  if (!theme) {
    return;
  }
  theme.minProperties = 1;
  const colors = (theme.properties as Record<string, Record<string, unknown>> | undefined)?.colors;
  if (colors) {
    colors.minProperties = 1;
  }
}
function rehomeSpecReferences(value: unknown, property = "spec"): void {
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref" && typeof child === "string" && child.startsWith("#")) {
      (value as Record<string, unknown>)[key] = `#/properties/${property}${child.slice(1)}`;
    } else {
      rehomeSpecReferences(child, property);
    }
  }
}
rehomeSpecReferences(advertisedSpec);
delete advertisedSpec.$schema;
requireNonEmptyThemeObjects(advertisedSpec);
const advertisedVariants = convertSpec(variantListSchema);
rehomeSpecReferences(advertisedVariants, "variants");
delete advertisedVariants.$schema;
// Advertise the public variant vocabulary; composeVariantCarousel validates in context.
const variantsInput = withJsonSchemaOverride(z.unknown(), (jsonSchema) =>
  Object.assign(jsonSchema, advertisedVariants),
);
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
      action: z.enum([
        "show",
        "update",
        "dismiss",
        "status",
        "inspect",
        "awaitEvent",
        "showVariants",
      ]),
      spec: specInput
        .optional()
        .describe(
          'Full overlay spec: id, window, optional theme (mode light|dark|system, colors.seed hex or colors.source "device", typography.scale 0.75-1.5 and fontFamily sans|serif|mono, shapes.corner none|small|medium|large|full; text style.textStyle names a Material type role such as titleLarge), optional state, root. window.opacity is 0-100, default 100. window.layer "app" and window.persistence "device" need a CtrlProxy advertising overlay_window_options_v1.',
        ),
      display: z
        .string()
        .optional()
        .describe(
          "show or showVariants: panel key, role, or active to show the overlay on. Precedence: explicit display, then the session display pin, then the default display. Needs a CtrlProxy advertising overlay_display_id_v1; a disconnected panel is refused.",
        ),
      id: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Overlay id required for update, dismiss, awaitEvent or showVariants; must equal spec.id on update",
        ),
      variants: variantsInput
        .optional()
        .describe(
          `showVariants only: 1-${MAX_VARIANTS} alternatives, each {label?, image:{asset,contentScale?}} or {label?, spec:OverlayNode}. Image assets are ids uploaded in the same call through assets, or already on the device.`,
        ),
      presentation: z
        .enum(["fullscreen", "floating"])
        .optional()
        .describe("showVariants only: fullscreen (default) or floating controls over the live app"),
      opacity: z
        .number()
        .int()
        .min(0)
        .max(100)
        .optional()
        .describe("showVariants only: window opacity percentage; omitted uses the spec default"),
      layer: z
        .enum(["app", "system"])
        .optional()
        .describe(
          "showVariants only: window.layer for the carousel; omitted uses the system layer",
        ),
      persistence: z
        .enum(["session", "device"])
        .optional()
        .describe(
          "showVariants only: window.persistence for the carousel; omitted is session-scoped",
        ),
      gravity: z
        .enum(placementSchema.options[2].shape.gravity.options)
        .optional()
        .describe("showVariants floating only: default bottomCenter"),
      offset: z
        .object({ x: z.number().finite(), y: z.number().finite() })
        .strict()
        .optional()
        .describe("showVariants floating only: offset in dp, default {x:0,y:0}"),
      waitForSelection: z
        .boolean()
        .optional()
        .describe(
          `showVariants only: after a successful show, wait for the user's pick and return selection {index, label?}; the wait is ${DEFAULT_OVERLAY_EVENT_TIMEOUT_MS} ms (timedOut:true on expiry), independent of the show timeoutMs`,
        ),
      state: stateInput
        .optional()
        .describe("Flat state patch for update; use either spec or state"),
      assets: assetsInput
        .optional()
        .describe(
          "show, showVariants, or update with spec: images to upload before the overlay is sent, as {id, path} with an absolute local file path or {id, observation} with an observation screenshot URI (PNG, JPEG or WebP, up to 4 MiB each, 16 MiB total, 32 assets). Reference each id from image nodes. Uploads are sequential; any failure fails the call before the overlay changes and names the assets already stored. If the device reports a supplied asset missing after the overlay is sent, it is re-uploaded and the overlay re-sent once.",
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
          `Device request timeout; awaitEvent defaults to ${DEFAULT_OVERLAY_EVENT_TIMEOUT_MS} ms, maximum ${MAX_OVERLAY_EVENT_TIMEOUT_MS} ms; timeout is a successful empty result. showVariants timeoutMs bounds only the show; waitForSelection uses the default event wait`,
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
    "assets",
    "variants",
    "presentation",
    "opacity",
    "layer",
    "persistence",
    "gravity",
    "offset",
    "waitForSelection",
  ] as const;
  const allowed: Record<typeof value.action, readonly string[]> = {
    show: ["spec", "display", "assets"],
    showVariants: [
      "id",
      "display",
      "assets",
      "variants",
      "presentation",
      "opacity",
      "layer",
      "persistence",
      "gravity",
      "offset",
      "waitForSelection",
    ],
    update: ["id", "spec", "state", "assets"],
    dismiss: ["id", "all"],
    status: [],
    inspect: [],
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
  if (value.action === "showVariants") {
    validateShowVariantsInput(value, ctx);
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

function validateShowVariantsInput(
  value: z.infer<typeof overlaySchema>,
  ctx: z.RefinementCtx,
): void {
  if (value.id === undefined) {
    ctx.addIssue({ code: "custom", path: ["id"], message: "showVariants requires id" });
  }
  if (value.variants === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["variants"],
      message: "showVariants requires variants",
    });
  }
  if (
    value.presentation !== "floating" &&
    (value.gravity !== undefined || value.offset !== undefined)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["presentation"],
      message: "gravity and offset require showVariants presentation: floating",
    });
  }
}

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
  if (value.assets !== undefined && value.spec === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["assets"],
      message: "update accepts assets only together with spec",
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
  adopted: z
    .literal(true)
    .optional()
    .describe("The device reported this overlay through inspect; this host did not show it"),
  persistent: z
    .boolean()
    .optional()
    .describe(
      "Adopted overlays only: true when the device keeps the overlay after the host disconnects (window.persistence: device), false when it ends with the session",
    ),
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
const selectionOutputSchema = z.object({
  index: z
    .number()
    .int()
    .nonnegative()
    .max(MAX_VARIANTS - 1),
  label: z.string().max(MAX_VARIANT_LABEL_LENGTH).optional(),
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
  selection: selectionOutputSchema
    .optional()
    .describe(
      "showVariants waitForSelection only: the picked zero-based index and the label it was shown with, if any",
    ),
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
      "show/update with assets: assets the device confirmed, also present on failure. They stay on the device until the overlay session ends.",
    ),
  missingAssets: z
    .array(z.string())
    .optional()
    .describe(
      "show/update: asset ids the overlay references that the device has no copy of; the overlay is shown with placeholders. Absent when none. Upload them with assets on a show or update with spec.",
    ),
  warning: z
    .string()
    .optional()
    .describe("show/update succeeded but needs attention; names what to do about missingAssets"),
  deviceDroppedEvents: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "inspect only: events the device dropped from its offline buffer (200 per device) since CtrlProxy started; a gap in sequences shows which",
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
  | "requestInspectOverlays"
  | "requestUpdateOverlay"
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
/** MCP name of the on-device prototype tool; `overlay` is its deprecated alias (#10495). */
export const PROTOTYPE_TOOL_NAME = "prototype";
export const DEPRECATED_OVERLAY_TOOL_NAME = "overlay";
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

/**
 * Refuses, before anything is sent, a spec whose window options the device would silently ignore,
 * and grants CtrlProxy SYSTEM_ALERT_WINDOW for an app-layer window (the device re-checks it and
 * fails with the appop command when the grant did not take).
 */
async function prepareWindowOptions(
  client: OverlayClient,
  device: BootedDevice,
  args: z.infer<typeof overlaySchema>,
  dependencies: Pick<OverlayToolDependencies, "adbFactory">,
  signal: AbortSignal | undefined,
): Promise<OverlayResult | undefined> {
  if ((args.action !== "show" && args.action !== "update") || args.spec === undefined) {
    return undefined;
  }
  const options = requestedOverlayWindowOptions(args.spec as OverlaySpec);
  if (!options.appLayer && !options.devicePersistence) {
    return undefined;
  }
  if (!(await client.supportsCommand(OVERLAY_WINDOW_OPTIONS_CAPABILITY))) {
    return {
      success: false,
      error: new ActionableError(overlayWindowOptionsUnsupportedMessage(options)).message,
    };
  }
  if (options.appLayer) {
    await grantOverlayAppLayer(
      (dependencies.adbFactory ?? defaultAdbClientFactory).create(device),
      signal,
    );
    // An abort that landed after the grant completed must still stop the mutation.
    signal?.throwIfAborted();
  }
  return undefined;
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
  const outcome = await uploadOverlayAssets(client, prepared.assets, {
    signal,
    action: args.action === "show" ? "show" : "update",
  });
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
 * The upload-then-cleared race: the device finished the show/update but lists assets this same
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

/** Display resolution, then window-option support: either refusal ends the call unsent. */
async function preflightMutation(
  client: OverlayClient,
  device: BootedDevice,
  args: z.infer<typeof overlaySchema>,
  dependencies: Pick<OverlayToolDependencies, "adbFactory" | "lastRenderedObservation">,
  signal: AbortSignal | undefined,
): Promise<{ displayId?: number; failure?: OverlayResult }> {
  const resolved = await resolveShowDisplay(client, device, args, dependencies);
  if (resolved.failure) {
    return resolved;
  }
  const failure = await prepareWindowOptions(client, device, args, dependencies, signal);
  return failure ? { displayId: resolved.displayId, failure } : resolved;
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
  const previouslyShown = store.status(scope).overlays.some((entry) => entry.id === target.id);
  if (args.action === "show") {
    events.show(scope, target.id!, client);
  }
  const { displayId, failure } = await preflightMutation(
    client,
    device,
    args,
    dependencies,
    signal,
  );
  const stage: AssetStage = failure
    ? { uploaded: [], prepared: [], failure }
    : await stageAssets(client, args, assetReaders, signal);
  const { result, warning } = await sendOverlay(client, args, stage, signal, displayId);
  clearMutationEvents(events, scope, target, args.action, result.success, previouslyShown);
  if (args.action === "show" && result.success && target.id) {
    events.replaceShown(scope.deviceId, target.id);
  }
  const lastResult = store.record(scope, args.action, target, result, displayId);
  if (target.id && events.isDismissed(scope, target.id)) {
    store.dismissed(scope, target.id);
  }
  return {
    success: result.success,
    ...(result.error ? { error: result.error } : {}),
    lastResult,
    ...(stage.uploaded.length > 0 ? { uploadedAssets: stage.uploaded } : {}),
    ...missingAssetsOutput(result, warning),
  };
}

function missingAssetsOutput(
  result: OverlayResult,
  warning: string | undefined,
): { missingAssets?: string[]; warning?: string } {
  return {
    ...(result.success && result.missingAssets?.length
      ? { missingAssets: result.missingAssets }
      : {}),
    ...(warning ? { warning } : {}),
  };
}

const deviceOverlayEntrySchema = z.object({
  id: z.string().min(1),
  persistent: z.boolean(),
  state: stateInput,
  pages: z.record(z.string(), z.number().int().nonnegative()).default({}),
  lastSequence: z.number().int().nonnegative(),
});

function parseReportedOverlays(overlays: readonly unknown[] | undefined): OverlayStatusEntry[] {
  return (overlays ?? []).flatMap((entry) => {
    const parsed = deviceOverlayEntrySchema.safeParse(entry);
    if (!parsed.success) {
      logger.warn("[overlay] Ignoring malformed overlay in inspect reply", parsed.error);
      return [];
    }
    return [parsed.data];
  });
}

/** Events the device replayed before its reply, grouped by overlay id in wire order. */
function groupByOverlay(events: readonly OverlayEvent[]): Map<string, OverlayEvent[]> {
  const grouped = new Map<string, OverlayEvent[]>();
  for (const event of events) {
    grouped.set(event.id, [...(grouped.get(event.id) ?? []), event]);
  }
  return grouped;
}

/**
 * The report is authoritative for what the device shows: an overlay this host still lists that the
 * device neither reports nor ended with a replayed terminal event is gone (for example CtrlProxy
 * restarted), including when the report is empty.
 */
function dropUnreportedOverlays(
  store: OverlayStatusStore,
  events: OverlayEventCoordinator,
  scope: OverlayScope,
  reportedIds: ReadonlySet<string>,
): void {
  for (const entry of store.status(scope).overlays) {
    if (entry.id !== undefined && !reportedIds.has(entry.id)) {
      events.dismiss(scope.deviceId, entry.id);
      store.dismissed(scope, entry.id);
    }
  }
}

/** Hands the device's report and the events it replayed to the event buffers and status store. */
function adoptReportedOverlays(
  store: OverlayStatusStore,
  events: OverlayEventCoordinator,
  client: OverlayClient,
  scope: OverlayScope,
  overlays: readonly unknown[] | undefined,
  replayed: readonly OverlayEvent[],
): void {
  const reported = parseReportedOverlays(overlays);
  const reportedIds = new Set(reported.map((entry) => entry.id));
  const history = groupByOverlay(replayed);
  for (const [id, grouped] of history) {
    // An overlay that ended while no host was connected is not reported, but its terminal event
    // still belongs to whoever awaits it.
    if (reportedIds.has(id) || grouped.some((event) => event.kind === "dismissed")) {
      const entry = reported.find((known) => known.id === id);
      events.adopt(scope, id, client, grouped, entry?.lastSequence ?? 0);
    }
  }
  dropUnreportedOverlays(store, events, scope, reportedIds);
  for (const entry of reported) {
    if (!history.has(entry.id)) {
      events.adopt(scope, entry.id, client, [], entry.lastSequence);
    }
    if (!events.isDismissed(scope, entry.id)) {
      store.adopt(scope, entry);
      events.replaceShown(scope.deviceId, entry.id);
    }
  }
}

/**
 * Asks the device which overlays it is showing and adopts them into host status and event
 * buffers, so `status` and `awaitEvent` work after a session release or a daemon restart. The
 * device replays events it buffered while no host was connected before it answers, so the capture
 * starts before the request. Refused, before anything is sent, on a CtrlProxy without
 * overlay_persistence_replay_v1.
 */
async function inspectDevice(
  dependencies: Pick<OverlayHandlerDependencies, "store" | "events" | "clientFactory">,
  device: BootedDevice,
  scope: OverlayScope,
  timeoutMs: number | undefined,
): Promise<OverlayOutput> {
  const { store, events, clientFactory } = dependencies;
  const client = clientFactory(device);
  // The device drains its offline ring from onClientConnected, which the capability probe below can
  // trigger by connecting, so the capture must be listening before the first operation.
  const replayed: OverlayEvent[] = [];
  const stopCapture = client.onOverlayEvent((event) => replayed.push(event));
  let result: OverlayResult;
  try {
    if (!(await client.supportsCommand(OVERLAY_PERSISTENCE_REPLAY_CAPABILITY))) {
      return {
        success: false,
        error: new ActionableError(overlayInspectUnsupportedMessage()).message,
      };
    }
    result = await client.requestInspectOverlays(timeoutMs);
  } catch (error) {
    logger.warn("[overlay] Inspect request failed", error);
    return { success: false, error: toActionableError(error, "Overlay inspect failed").message };
  } finally {
    stopCapture();
  }
  if (!result.success) {
    return { success: false, error: result.error ?? "Overlay inspect failed" };
  }
  adoptReportedOverlays(store, events, client, scope, result.overlays, replayed);
  return {
    success: true,
    ...statusOutput(store, events, scope),
    deviceDroppedEvents: result.droppedEvents ?? 0,
  };
}

function statusOutput(
  store: OverlayStatusStore,
  events: OverlayEventCoordinator,
  scope: OverlayScope,
): Pick<OverlayOutput, "overlays" | "lastResult"> {
  const status = store.status(scope);
  return {
    ...status,
    overlays: status.overlays.map((entry) => {
      const counts = entry.id ? events.counts(scope, entry.id) : undefined;
      return counts?.lastSequence === undefined ? entry : { ...entry, ...counts };
    }),
  };
}

type StatusAction = "status" | "inspect";
const isStatusAction = (action: string): action is StatusAction =>
  action === "status" || action === "inspect";

/** `status` reads host memory; `inspect` asks the device and adopts what it reports. */
async function statusOrInspect(
  action: StatusAction,
  dependencies: Pick<OverlayHandlerDependencies, "store" | "events" | "clientFactory">,
  device: BootedDevice,
  scope: OverlayScope,
  args: Pick<z.infer<typeof overlaySchema>, "timeoutMs">,
): Promise<OverlayOutput> {
  if (action === "inspect") {
    return inspectDevice(dependencies, device, scope, args.timeoutMs);
  }
  return { success: true, ...statusOutput(dependencies.store, dependencies.events, scope) };
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

async function showVariants(
  dependencies: OverlayHandlerDependencies,
  device: BootedDevice,
  args: z.infer<typeof overlaySchema>,
  scope: OverlayScope,
  context: { progress?: ProgressCallback; signal?: AbortSignal },
): Promise<OverlayOutput> {
  let spec: OverlaySpec;
  try {
    const composed = composeVariantCarousel({
      id: args.id,
      variants: args.variants,
      presentation: args.presentation,
      opacity: args.opacity,
      gravity: args.gravity,
      offset: args.offset,
    });
    // Window options are not part of the carousel's content: set them on the composed window.
    spec = {
      ...composed,
      window: {
        ...composed.window,
        ...(args.layer !== undefined ? { layer: args.layer } : {}),
        ...(args.persistence !== undefined ? { persistence: args.persistence } : {}),
      },
    };
  } catch (error) {
    logger.warn("[overlay] showVariants input rejected", error);
    return {
      success: false,
      error: toActionableError(error, "Invalid showVariants input").message,
    };
  }
  // The carousel goes through the normal show path so the event subscription, sequence epoch,
  // shown-overlay replacement, display resolution, asset upload and the missing-asset retry
  // behave exactly as for `show`.
  const shown = await performMutation(
    dependencies,
    device,
    { ...args, action: "show", spec },
    scope,
    combineWithAmbientAbort(context.signal),
  );
  if (!shown.success || !args.waitForSelection) {
    return shown;
  }
  // The wait is the default event wait, deliberately not the show request's timeoutMs.
  const waited = await waitForOverlayEvent(
    dependencies.events,
    scope,
    dependencies.clientFactory(device),
    { id: args.id, eventName: "selected", kind: "emit" },
    context,
  );
  if (!waited.event) {
    return { ...shown, ...waited };
  }
  const picked = parseVariantSelection(spec, waited.event.payload);
  return "selection" in picked
    ? { ...shown, ...waited, selection: picked.selection }
    : { ...shown, ...waited, success: false, error: picked.error };
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
    if (isStatusAction(args.action)) {
      return responseFor(
        await statusOrInspect(args.action, { store, events, clientFactory }, device, scope, args),
      );
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
    if (args.action === "showVariants") {
      return responseFor(
        await showVariants(handlerDependencies, device, args, scope, { progress, signal }),
      );
    }
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
    PROTOTYPE_TOOL_NAME,
    'Show, showVariants (1-12 image or spec alternatives composed into one swipeable carousel, fullscreen or floating; accepts display and assets like show, so image variants may reference ids uploaded in the same call; optional waitForSelection returns the picked selection {index, label?}), update (spec or flat state), dismiss (id or all:true), status (host-local, no device request), inspect (asks the device which overlays it is showing and adopts them into status and awaitEvent; use it after a session release or reconnect), or awaitEvent for an overlay id on Android. awaitEvent returns one buffered event, supports eventName/kind and afterSequence, and times out successfully (timedOut:true); default 30000 ms, maximum 60000 ms. Buffer: 64 events per session/device/id; overflow drops oldest and reports droppedCount. Lower-or-equal sequences are ignored, including late arrivals and reconnect replays. Nodes: box/row/column, text/image/icon/spacer/textField, scroll/pager/tabBar/bottomNav/bottomSheet; actions: emit/setPage/setState/dismiss. Sizes and anchors use dp; window placement: fullscreen/sheet/floating, window.opacity: 0-100 (default 100). Example: {action:"show",spec:{id:"demo",window:{placement:{type:"fullscreen"},opacity:80},root:{type:"text",text:"Hello"}}}. show/showVariants/update(spec) also accept assets:[{id,path}] (absolute local PNG/JPEG/WebP file path) or [{id,observation}] (an observation screenshot URI) uploaded before the overlay is sent; image nodes reference the id. If the device reports supplied assets missing, they are re-uploaded and the overlay re-sent once; missingAssets and warning report what is still missing. Verify with observe; no screenshot is returned. Status makes no device request and includes pendingCount/lastSequence/droppedCount after events arrive. Device dismissed events remove shown status; the terminal event remains available until consumed or explicit show/dismiss. Awaiting consumes events; unmatched events remain buffered. Optional MCP progress reports wait start/finish without delaying the wait. Session release, device removal and unbinding clear buffers. A disconnect alone is not observed. window.layer: system (default, above system UI) or app (above apps only, so the shade, keyboard and screenshot preview draw over it; the daemon grants CtrlProxy SYSTEM_ALERT_WINDOW with appops first). window.persistence: session (default) or device: the overlay stays interactive after USB/adb disconnect and session end with no idle timeout, keeps its assets, and carries a visible Close control; remove it with that control, dismiss, or a new show. Both need a CtrlProxy advertising overlay_window_options_v1. A device-persistent overlay keeps emitting taps, page changes and text input while no host is connected: the device buffers the last 200 events (oldest dropped, counted) and delivers them when a host connects or on inspect, with sequences continuing and no rewind; inspect returns deviceDroppedEvents. inspect needs a CtrlProxy advertising overlay_persistence_replay_v1 and is refused otherwise.',
    overlaySchema,
    handler,
    { defaultEnabled: false, outputSchema: overlayOutputSchema },
  );
  // Deprecated alias for one release (#10495): same schema and handler, hidden from discovery.
  ToolRegistry.registerDeviceAware(
    DEPRECATED_OVERLAY_TOOL_NAME,
    `Deprecated alias of ${PROTOTYPE_TOOL_NAME}; use ${PROTOTYPE_TOOL_NAME}.`,
    overlaySchema,
    async (...args: Parameters<typeof handler>) => {
      logger.warn(
        `[overlayTools] tool "${DEPRECATED_OVERLAY_TOOL_NAME}" is deprecated; use "${PROTOTYPE_TOOL_NAME}"`,
      );
      return handler(...args);
    },
    { defaultEnabled: false, hidden: true, outputSchema: overlayOutputSchema },
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

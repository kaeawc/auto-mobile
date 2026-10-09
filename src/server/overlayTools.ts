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
  AndroidOverlayTransport,
  type AndroidOverlayClient,
} from "../features/overlay/androidOverlayTransport";
import {
  overlayAssetPutClient,
  overlayEventSource,
  type OverlayTransport,
} from "../features/overlay/OverlayTransport";
import type { OverlayEventSource } from "../features/overlay/OverlayEventCoordinator";
import {
  IosOverlayTransport,
  noOverlayAgentConnections,
  overlayAgentNotConnectedMessage,
  type OverlayAgentConnections,
} from "../features/overlay/ios/iosOverlayTransport";
import type { OverlayAgentClient } from "../features/overlay/ios/overlayAgentClient";
import {
  overlayDisplayUnsupportedMessage,
  overlayInspectUnsupportedMessage,
} from "../features/observe/android/CtrlProxyOverlays";
import {
  OVERLAY_ANCHOR_CAPABILITY,
  OVERLAY_DISPLAY_CAPABILITY,
  OVERLAY_PERSISTENCE_REPLAY_CAPABILITY,
  OVERLAY_WINDOW_OPTIONS_CAPABILITY,
  OVERLAY_SHOW_IN_PLACE_CAPABILITY,
} from "../features/observe/android/ctrlProxyProtocol";
import type {
  OverlayDismiss,
  OverlayEvent,
  OverlayResult,
  OverlayStatusEntry,
} from "../features/observe/android/ctrlProxyProtocol";
import { overlaySpecSchema, type OverlaySpec } from "../features/overlay/overlaySpec";
import { validateOverlaySpec } from "../features/overlay/overlayValidation";
import {
  hasElementAnchors,
  hasOverlayAnchors,
  overlayAnchorPlacementError,
  resolveOverlayAnchors,
  type ResolvedOverlayAnchor,
} from "../features/overlay/overlayAnchors";
import type { HierarchyCapture } from "../features/observe/HierarchyCapture";
import { createDeviceHierarchyCapture } from "../features/observe/DeviceHierarchyCapture";
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
  type OverlayLastResult,
  type OverlayStatusStore,
  type OverlayScope,
} from "../features/overlay/OverlayStatusStore";
import { OverlayCommitGenerations } from "../features/overlay/OverlayCommitGenerations";
import type { Timer } from "../utils/SystemTimer";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../utils/android-cmdline-tools/AdbClientFactory";
import { getToolSelectionContext } from "../features/toolSelection/toolSelectionContext";
import { createStructuredToolResponse, withIsErrorOnFailure } from "../utils/toolUtils";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";
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
  DefaultDeviceWindowCacheInvalidator,
  type DeviceWindowCacheInvalidator,
} from "../features/observe/DeviceWindowCacheInvalidator";
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
requireNonEmptyThemeObjects(advertisedSpec);
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
          .describe(
            "Opaque asset id that spec image nodes reference (image.asset, or style.fontFamily {asset})",
          ),
        path: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Absolute path of a PNG, JPEG or WebP image, or a TTF/OTF font (up to 2 MiB), the daemon can read",
          ),
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
      action: z.enum(["show", "dismiss", "status", "inspect", "awaitEvent"], {
        error: (issue) =>
          getRemovedToolActionHint(PROTOTYPE_TOOL_NAME, issue.input) ??
          "action must be one of show, dismiss, status, inspect or awaitEvent",
      }),
      spec: specInput
        .optional()
        .describe(
          'Full overlay spec: id, window, optional theme (mode light|dark|system, colors.seed hex or colors.source "device", plus optional per-role hex overrides in colors such as colors.primary or colors.surface applied over that scheme in light and dark, typography.scale 0.75-1.5 and fontFamily sans|serif|mono, shapes.corner none|small|medium|large|full; text style.textStyle names a Material type role such as titleLarge; style color, background and border.color take hex or a Material colour role such as primary, onSurface, surfaceContainer; style.cornerRadius takes dp, none|extraSmall|small|medium|large|extraLarge|full, or per-corner {topStart,topEnd,bottomEnd,bottomStart} dp), optional state, root. window.opacity is 0-100, default 100. show always renders the whole spec; spec.state is authoritative. window.layer "app" and window.persistence "device" need a CtrlProxy advertising overlay_window_options_v1.',
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
          "show only: images to upload before the overlay is sent, as {id, path} with an absolute local file path or {id, observation} with an observation screenshot URI (PNG, JPEG or WebP, up to 4 MiB each, 16 MiB total, 32 assets). Reference each id from image nodes, or from style.fontFamily as {asset} for a TTF/OTF font file (path only, up to 2 MiB). Uploads are sequential; any failure fails the call before the overlay changes and names the assets already stored. If the device reports a supplied asset missing after the overlay is sent, it is re-uploaded and the overlay re-sent once.",
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
  anchors: z
    .array(
      z.object({
        path: z.string(),
        alignment: z.enum(["cover", "top", "bottom", "start", "end"]),
        boundsPx: z.object({
          left: z.number(),
          top: z.number(),
          right: z.number(),
          bottom: z.number(),
        }),
        bounds: z.object({
          x: z.number(),
          y: z.number(),
          width: z.number(),
          height: z.number(),
        }),
      }),
    )
    .optional()
    .describe(
      "show with element anchors: each anchored node's path and the app element bounds it was resolved to, as observe reports them (boundsPx: px on Android, points on iOS) and in spec units (bounds: dp on Android, points on iOS). Resolved once at show; the overlay does not follow later scrolling or layout, so show again to re-anchor.",
    ),
  hierarchyUpdatedAt: z
    .number()
    .optional()
    .describe(
      "show with element anchors: device timestamp of the hierarchy they were resolved against",
    ),
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
  /**
   * Returns `undefined` while unbinding cannot be observed yet (the daemon state is not
   * initialised); the host retries on its next registration or call until it subscribes.
   */
  subscribeDeviceUnbound(listener: (deviceId: string) => void): (() => void) | undefined;
  /**
   * What an unbound subscription is bound to (the daemon's current session manager), or
   * `undefined` while unbinding cannot be observed. When it changes (DaemonState reset and
   * re-initialised), the host drops its subscription to the old source and subscribes again.
   * Omitted: the source never changes.
   */
  deviceUnboundSource?(): object | undefined;
}
type OverlayClient = AndroidOverlayClient;
/**
 * The transport for one call; `android` carries the CtrlProxy-only display gate and inspect, `ios`
 * the injected agent's advertised capabilities.
 */
interface OverlayTarget {
  transport: OverlayTransport;
  android?: AndroidOverlayTransport;
  ios?: Pick<IosOverlayTransport, "supportsCapability">;
}
export interface OverlayToolDependencies {
  /** Reads local files named by `assets`; tests inject an in-memory reader. */
  assetFileReader?: OverlayAssetFileReader;
  /** Resolves `assets[].observation` URIs; defaults to the observation screenshot resource. */
  observationScreenshotReader?: OverlayObservationScreenshotReader;
  clientFactory?: (device: BootedDevice) => OverlayClient;
  /** Injected iOS simulator agent connections, recorded by `launchApp {overlay: true}` (#10567). */
  agentConnections?: OverlayAgentConnections;
  adbFactory?: AdbClientFactory;
  lastRenderedObservation?: OverlayDisplayDependencies["lastRenderedObservation"];
  store?: OverlayStatusStore;
  clock?: Pick<Timer, "now">;
  timer?: Timer;
  lifecycle?: OverlayEventLifecycle;
  /** Retires the device's cached observation after a show or dismiss lands; tests inject a fake. */
  cacheInvalidator?: DeviceWindowCacheInvalidator;
  /** Captures the hierarchy element anchors resolve against; tests inject captured hierarchies. */
  anchorHierarchyCaptureFactory?: (device: BootedDevice) => HierarchyCapture;
}
/** MCP name of the on-device prototype tool; `overlay` is its deprecated alias (#10495). */
export const PROTOTYPE_TOOL_NAME = "prototype";
export const DEPRECATED_OVERLAY_TOOL_NAME = "overlay";
const responseFor = (payload: z.infer<typeof overlayOutputSchema>) =>
  withIsErrorOnFailure(createStructuredToolResponse(payload), payload.success);

// Validation has already succeeded. Forward authored specs unchanged; omitted
// defaults (including opacity=100) remain the wire contract's defaults.
async function mutate(
  target: OverlayTarget,
  args: z.infer<typeof overlaySchema>,
  displayId?: number,
): Promise<OverlayResult> {
  if (args.action === "show") {
    return target.transport.show(args.spec as OverlaySpec, {
      timeoutMs: args.timeoutMs,
      displayId,
      reset: args.reset,
    });
  }
  const dismissal: OverlayDismiss = args.all ? { all: true } : { id: args.id! };
  return target.transport.dismiss(dismissal, args.timeoutMs);
}

/**
 * Resolves `display` (already explicit-or-pinned) to a logical display id and refuses, before
 * anything is sent, when the device cannot honour it. Only show carries a display.
 */
async function showDisplayId(
  target: OverlayTarget,
  device: BootedDevice,
  args: z.infer<typeof overlaySchema>,
  dependencies: Pick<OverlayToolDependencies, "adbFactory" | "lastRenderedObservation">,
): Promise<number | undefined> {
  // overlayPlatformError refuses display off Android, so only Android reaches the resolver.
  if (args.action !== "show" || args.display === undefined || !target.android) {
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
  if (!(await target.android.supportsCommand(OVERLAY_DISPLAY_CAPABILITY))) {
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
  target: OverlayTarget,
  device: BootedDevice,
  args: z.infer<typeof overlaySchema>,
  dependencies: Pick<OverlayToolDependencies, "adbFactory">,
  signal: AbortSignal | undefined,
): Promise<OverlayResult | undefined> {
  if (args.action !== "show" || args.spec === undefined) {
    return undefined;
  }
  const options = requestedOverlayWindowOptions(args.spec as OverlaySpec);
  if (!options.appLayer && !options.devicePersistence) {
    return undefined;
  }
  // overlayPlatformError refuses window options off Android, so only Android reaches here.
  if (!target.android) {
    return undefined;
  }
  const supported = await target.android.supportsCommand(OVERLAY_WINDOW_OPTIONS_CAPABILITY);
  // The lookup waits for connection and handshake; an abort during it must stop every variant.
  signal?.throwIfAborted();
  if (!supported) {
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

interface AnchorStage {
  /** The spec to send, element anchors replaced by bounds anchors; absent when unchanged. */
  spec?: OverlaySpec;
  anchors?: ResolvedOverlayAnchor[];
  hierarchyUpdatedAt?: number;
  failure?: OverlayResult;
}

const ANCHOR_UNSUPPORTED_MESSAGE = `The connected CtrlProxy does not advertise ${OVERLAY_ANCHOR_CAPABILITY}, so it would ignore anchor and draw the node at its normal position. Nothing was shown. Update the connected CtrlProxy, or remove anchor.`;
const IOS_ANCHOR_UNSUPPORTED_MESSAGE = `The connected iOS overlay agent does not advertise ${OVERLAY_ANCHOR_CAPABILITY}, so it would ignore anchor and draw the node at its normal position. Nothing was shown. Relaunch the app with launchApp overlay: true to load the agent built for this AutoMobile version, or remove anchor.`;
const ANCHOR_DISPLAY_MESSAGE =
  "Element anchors resolve against the default display's app hierarchy, so they cannot be shown on another display. Nothing was shown. Omit display, or use a bounds anchor in dp.";

/** Throws when the connected CtrlProxy or iOS overlay agent would ignore the spec's anchors. */
async function assertAnchorCapability(target: OverlayTarget): Promise<void> {
  if (target.android) {
    if (!(await target.android.supportsCommand(OVERLAY_ANCHOR_CAPABILITY))) {
      throw new ActionableError(ANCHOR_UNSUPPORTED_MESSAGE);
    }
    return;
  }
  if (!target.ios?.supportsCapability(OVERLAY_ANCHOR_CAPABILITY)) {
    throw new ActionableError(IOS_ANCHOR_UNSUPPORTED_MESSAGE);
  }
}

/** Throws when the device would ignore the spec's anchors or its placement would clip them. */
async function assertAnchorsShowable(
  target: OverlayTarget,
  spec: OverlaySpec,
  displayId: number | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  await assertAnchorCapability(target);
  signal?.throwIfAborted();
  const placementError = overlayAnchorPlacementError(spec);
  if (placementError) {
    throw new ActionableError(placementError);
  }
  if (displayId && hasElementAnchors(spec)) {
    throw new ActionableError(ANCHOR_DISPLAY_MESSAGE);
  }
}

/** Resolves element anchors against a fresh app hierarchy; bounds anchors pass through. */
async function resolveElementAnchors(
  device: BootedDevice,
  spec: OverlaySpec,
  request: { timeoutMs?: number; signal?: AbortSignal },
  dependencies: Pick<OverlayToolDependencies, "anchorHierarchyCaptureFactory">,
): Promise<AnchorStage> {
  if (!hasElementAnchors(spec)) {
    return {};
  }
  const capture = (
    dependencies.anchorHierarchyCaptureFactory ?? ((d) => createDeviceHierarchyCapture(d))
  )(device);
  const snapshot = await capture.capture({ freshness: "fresh", ...request });
  // iOS hierarchies are in points, the unit iOS spec sizes use; Android's px convert to dp.
  const resolution = resolveOverlayAnchors(spec, {
    ...snapshot,
    boundsUnit: device.platform === "ios" ? "points" : "px",
  });
  return {
    spec: resolution.spec,
    anchors: resolution.anchors,
    ...(resolution.hierarchyUpdatedAt === undefined
      ? {}
      : { hierarchyUpdatedAt: resolution.hierarchyUpdatedAt }),
  };
}

/**
 * Refuses, before anything is shown, an anchored spec the device would silently mis-place, and
 * resolves each element anchor against a fresh app hierarchy (the overlay excluded), converting
 * Android px bounds to dp once with the display density; iOS bounds are points already (#9316). A
 * missing, ambiguous or off-screen element fails the show.
 */
async function resolveShowAnchors(
  target: OverlayTarget,
  device: BootedDevice,
  args: z.infer<typeof overlaySchema>,
  context: { displayId?: number; signal?: AbortSignal },
  dependencies: Pick<OverlayToolDependencies, "anchorHierarchyCaptureFactory">,
): Promise<AnchorStage> {
  const { displayId, signal } = context;
  const spec = args.action === "show" ? (args.spec as OverlaySpec | undefined) : undefined;
  if (!spec || !hasOverlayAnchors(spec)) {
    return {};
  }
  try {
    await assertAnchorsShowable(target, spec, displayId, signal);
    return await resolveElementAnchors(
      device,
      spec,
      { timeoutMs: args.timeoutMs, signal },
      dependencies,
    );
  } catch (error) {
    signal?.throwIfAborted();
    logger.warn(`[overlay] anchor resolution refused the show: ${errorMessage(error)}`);
    return {
      failure: { success: false, error: toActionableError(error, "Overlay anchor failed").message },
    };
  }
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
  target: OverlayTarget,
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
  const outcome = await uploadOverlayAssets(
    overlayAssetPutClient(target.transport),
    prepared.assets,
    { signal, action: "show" },
  );
  return {
    uploaded: outcome.uploaded,
    prepared: prepared.assets,
    ...(outcome.success ? {} : { failure: { success: false, error: outcome.error } }),
  };
}

async function runMutation(
  target: OverlayTarget,
  args: z.infer<typeof overlaySchema>,
  displayId: number | undefined,
): Promise<OverlayResult> {
  try {
    return await mutate(target, args, displayId);
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
  target: OverlayTarget,
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
  const upload = await uploadOverlayAssets(overlayAssetPutClient(target.transport), again, {
    signal,
    action: "resend",
  });
  if (!upload.success) {
    return fail(upload.error ?? "upload failed");
  }
  if (signal?.aborted) {
    return fail("the request was cancelled before the overlay was re-sent");
  }
  // The re-send targets the display the first send resolved, never a re-resolved one.
  const second = await runMutation(target, args, displayId);
  return second.success
    ? { result: second, repair: { kind: "still-missing" } }
    : fail(second.error ?? "re-sending the overlay failed");
}

interface MutationOutcome {
  result: OverlayResult;
  warning?: string;
}

/**
 * A newer show of the same id on this device started while this one resolved its display or
 * staged assets (#10641). Sending now would put this older spec on screen, possibly on another
 * display, while host status records the newer one, so the older show is never sent.
 */
function supersededBeforeSend(args: { spec?: unknown }): OverlayResult {
  const id = (args.spec as OverlaySpec | undefined)?.id;
  return {
    success: false,
    error: `Overlay ${id ?? ""} was not sent: a newer show of the same id on this device started first and is the one on screen.`,
  };
}

/** A re-send after a newer same-id show landed would replace it with this older spec. */
function needsAssetResend(first: OverlayResult, superseded: () => boolean): boolean {
  return first.success && (first.missingAssets?.length ?? 0) > 0 && !superseded();
}

async function sendOverlay(
  target: OverlayTarget,
  args: z.infer<typeof overlaySchema>,
  stage: AssetStage,
  signal: AbortSignal | undefined,
  displayId: number | undefined,
  superseded: () => boolean = () => false,
): Promise<MutationOutcome> {
  if (stage.failure) {
    return { result: stage.failure };
  }
  if (superseded()) {
    return { result: supersededBeforeSend(args) };
  }
  const first = await runMutation(target, args, displayId);
  if (!needsAssetResend(first, superseded)) {
    return { result: first };
  }
  const retry = await retryMissingAssets(target, args, stage, first, signal, displayId);
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
  target: OverlayTarget,
  device: BootedDevice,
  args: z.infer<typeof overlaySchema>,
  dependencies: Pick<OverlayToolDependencies, "adbFactory" | "lastRenderedObservation">,
): Promise<{ displayId?: number; failure?: OverlayResult }> {
  try {
    return { displayId: await showDisplayId(target, device, args, dependencies) };
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

/**
 * Display resolution, then window-option support, then anchor resolution: any refusal ends the call
 * unsent. An in-place show stays on [show.shownDisplayId], so anchors are checked against that.
 */
async function preflightMutation(
  show: { inPlace: boolean; shownDisplayId?: number },
  target: OverlayTarget,
  device: BootedDevice,
  args: z.infer<typeof overlaySchema>,
  dependencies: Pick<
    OverlayToolDependencies,
    "adbFactory" | "lastRenderedObservation" | "anchorHierarchyCaptureFactory"
  >,
  signal: AbortSignal | undefined,
): Promise<AnchorStage & { displayId?: number }> {
  const resolved = await resolveMutationDisplay(show.inPlace, target, device, args, dependencies);
  if (resolved.failure) {
    return resolved;
  }
  const failure = await prepareWindowOptions(target, device, args, dependencies, signal);
  if (failure) {
    return { displayId: resolved.displayId, failure };
  }
  const anchorDisplayId = show.inPlace ? show.shownDisplayId : resolved.displayId;
  const anchors = await resolveShowAnchors(
    target,
    device,
    args,
    { displayId: anchorDisplayId, signal },
    dependencies,
  );
  return { ...resolved, ...anchors };
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

/**
 * A fresh show starts its event epoch before dispatch. An in-place show waits until the
 * replacement lands: a failed one leaves the old overlay on screen, so its buffered events and
 * sequence high-water mark must survive.
 */
function startFreshShowEvents(
  events: OverlayEventCoordinator,
  scope: OverlayScope,
  source: OverlayEventSource,
  show: { target: { id?: string }; args: { action: OverlayMutation }; inPlace: boolean },
): void {
  if (show.args.action === "show" && !show.inPlace) {
    events.show(scope, show.target.id!, source);
  }
}

function settleShowEvents(
  events: OverlayEventCoordinator,
  scope: OverlayScope,
  source: OverlayEventSource,
  outcome: { target: { id?: string }; inPlace: boolean; success: boolean },
): void {
  if (outcome.inPlace && outcome.success) {
    events.show(scope, outcome.target.id!, source);
  }
}

function overlayDeviceUnboundSource(): object | undefined {
  const state = DaemonState.getInstance();
  return state.isInitialized() ? state.getSessionManager() : undefined;
}

function subscribeOverlayDeviceUnbound(
  listener: (deviceId: string) => void,
): (() => void) | undefined {
  const state = DaemonState.getInstance();
  if (!state.isInitialized()) {
    // The shared host is created before startDaemon initialises DaemonState; the host retries.
    return undefined;
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
  target: OverlayTarget;
  assetReaders: AssetReaders;
  commits: OverlayCommitGenerations;
  cacheInvalidator: DeviceWindowCacheInvalidator;
  now: () => number;
} & Pick<
  OverlayToolDependencies,
  "adbFactory" | "lastRenderedObservation" | "anchorHierarchyCaptureFactory"
>;
type OverlayOutput = z.infer<typeof overlayOutputSchema>;

function mutationTarget(
  args: Omit<z.infer<typeof overlaySchema>, "action"> & { action: OverlayMutation },
): { id?: string; all?: true } {
  if (args.all) {
    return { all: true as const };
  }
  return { id: args.action === "show" ? (args.spec as OverlaySpec).id : args.id };
}

function shownOnDevice(
  store: OverlayStatusStore,
  scope: OverlayScope,
  target: { id?: string },
): OverlayLastResult | undefined {
  return target.id ? store.shownOnDevice(scope.deviceId, target.id) : undefined;
}

/** A refused display ends the call before any asset is uploaded. */
async function stageUnlessRefused(
  failure: OverlayResult | undefined,
  target: OverlayTarget,
  args: z.infer<typeof overlaySchema>,
  readers: AssetReaders,
  signal: AbortSignal | undefined,
): Promise<AssetStage> {
  return failure
    ? { uploaded: [], prepared: [], failure }
    : stageAssets(target, args, readers, signal);
}

async function performMutation(
  dependencies: OverlayHandlerDependencies,
  device: BootedDevice,
  args: Omit<z.infer<typeof overlaySchema>, "action"> & { action: OverlayMutation },
  scope: OverlayScope,
  signal?: AbortSignal,
): Promise<OverlayOutput> {
  const { store, events, target: overlayTarget, assetReaders, commits } = dependencies;
  const target = mutationTarget(args);
  const source = overlayEventSource(overlayTarget.transport);
  // The device holds one active overlay, so presence is device-wide, not per session.
  const shown = shownOnDevice(store, scope, target);
  const previouslyShown = shown !== undefined;
  const inPlace = args.action === "show" && shown !== undefined && args.reset !== true;
  // An older CtrlProxy re-shows a same-id overlay fresh on the display it is sent, so its pages
  // restart. It still validates before replacing, so a refused show leaves the old overlay and its
  // events exactly as an in-place one does; only the caller needs telling.
  const legacy = await legacyInPlaceWarning(overlayTarget, target, inPlace);
  const generation = beginShowGeneration(commits, scope, args.action, target);
  // Every display lookup and window-option check happens before staging; nothing is re-resolved
  // after dispatch. A refused show must not reset the event epoch of an overlay still on screen.
  const resolved = await preflightMutation(
    { inPlace, shownDisplayId: shown?.displayId },
    overlayTarget,
    device,
    args,
    dependencies,
    signal,
  );
  // The device is sent resolved bounds anchors; host status keeps the authored spec's identity.
  const sendArgs = resolved.spec ? { ...args, spec: resolved.spec } : args;
  if (!resolved.failure) {
    startFreshShowEvents(events, scope, source, { target, args, inPlace });
  }
  const comparable = await comparableForMutation(resolved, inPlace, device, args, dependencies);
  // An in-place show names the display it replaces on: if the overlay is dismissed while assets
  // stage, the runner then shows it fresh there instead of on the default display.
  const displayId = inPlace ? shown?.displayId : resolved.displayId;
  const stage = await stageUnlessRefused(
    resolved.failure,
    overlayTarget,
    sendArgs,
    assetReaders,
    signal,
  );
  const { result, warning } = await sendOverlay(
    overlayTarget,
    sendArgs,
    stage,
    signal,
    displayId,
    () => isSuperseded(commits, scope, target, generation),
  );
  retireObservation(dependencies.cacheInvalidator, device, result);
  const placed = placedDisplay(args, shown, comparable, result.success);
  const lastResult = isSuperseded(commits, scope, target, generation)
    ? supersededResult(dependencies, { args, target, result, placed })
    : commitMutation(dependencies, scope, source, {
        args,
        target,
        result,
        placed,
        inPlace,
        previouslyShown,
      });
  return {
    success: result.success,
    ...(result.error ? { error: result.error } : {}),
    lastResult,
    ...(stage.uploaded.length > 0 ? { uploadedAssets: stage.uploaded } : {}),
    ...anchorsOutput(resolved),
    ...missingAssetsOutput(result, [warning, placed.warning], legacy),
  };
}

/**
 * A same-id show replaces in place only on a CtrlProxy advertising overlay_show_in_place_v1. An
 * older APK ignores reset and re-shows the overlay fresh on the display it is sent (#10642), so the
 * caller is told its pager pages restarted. iOS's overlay agent always replaces in place.
 */
async function legacyInPlaceWarning(
  target: OverlayTarget,
  overlay: { id?: string },
  inPlace: boolean,
): Promise<string | undefined> {
  if (
    !inPlace ||
    !target.android ||
    (await target.android.supportsCommand(OVERLAY_SHOW_IN_PLACE_CAPABILITY))
  ) {
    return undefined;
  }
  return `the connected CtrlProxy does not advertise ${OVERLAY_SHOW_IN_PLACE_CAPABILITY}, so overlay ${overlay.id} was re-shown fresh on its display: pager pages restarted. Update the connected CtrlProxy to keep pages.`;
}

/**
 * A show or dismiss that landed changed the screen, so the observation cached before it is stale:
 * without this, the "Verify with observe" call right after returns the pre-mutation capture.
 * The foreground app is unchanged, so the iOS SDK identity is preserved.
 */
function retireObservation(
  invalidator: DeviceWindowCacheInvalidator,
  device: BootedDevice,
  result: OverlayResult,
): void {
  if (result.success) {
    invalidator.invalidate(device, true);
  }
}

function beginShowGeneration(
  commits: OverlayCommitGenerations,
  scope: OverlayScope,
  action: OverlayMutation,
  target: { id?: string },
): number | undefined {
  return action === "show" && target.id ? commits.begin(scope.deviceId, target.id) : undefined;
}

function isSuperseded(
  commits: OverlayCommitGenerations,
  scope: OverlayScope,
  target: { id?: string },
  generation: number | undefined,
): boolean {
  return (
    generation !== undefined &&
    target.id !== undefined &&
    !commits.isLatest(scope.deviceId, target.id, generation)
  );
}

async function comparableForMutation(
  resolved: { displayId?: number; failure?: OverlayResult },
  inPlace: boolean,
  device: BootedDevice,
  args: z.infer<typeof overlaySchema>,
  dependencies: Pick<OverlayToolDependencies, "adbFactory" | "lastRenderedObservation">,
): Promise<number | undefined | null> {
  return resolved.failure
    ? undefined
    : comparableRequestedDisplay(inPlace, resolved.displayId, device, args, dependencies);
}

interface CommitOutcome {
  args: { action: OverlayMutation };
  target: { id?: string; all?: true };
  result: OverlayResult;
  placed: { displayId?: number };
}

function commitMutation(
  dependencies: OverlayHandlerDependencies,
  scope: OverlayScope,
  source: OverlayEventSource,
  outcome: CommitOutcome & { inPlace: boolean; previouslyShown: boolean },
): OverlayLastResult {
  const { store, events } = dependencies;
  const { args, target, result, placed, inPlace, previouslyShown } = outcome;
  settleShowEvents(events, scope, source, { target, inPlace, success: result.success });
  clearMutationEvents(events, scope, target, args.action, result.success, previouslyShown);
  if (args.action === "show" && result.success && target.id) {
    events.replaceShown(scope.deviceId, target.id);
  }
  const lastResult = store.record(scope, args.action, target, result, placed.displayId);
  if (target.id && events.isDismissed(scope, target.id)) {
    store.dismissed(scope, target.id);
  }
  return lastResult;
}

/**
 * A newer show of the same id on this device started after this one, so it owns host status and
 * event buffers; this call reports only its own outcome and commits nothing.
 */
function supersededResult(
  dependencies: OverlayHandlerDependencies,
  outcome: CommitOutcome,
): OverlayLastResult {
  const { args, target, result, placed } = outcome;
  return {
    ...target,
    lastAction: args.action,
    ...(placed.displayId === undefined ? {} : { displayId: placed.displayId }),
    success: result.success,
    ...(result.error ? { error: result.error } : {}),
    ...(result.totalTimeMs === undefined ? {} : { totalTimeMs: result.totalTimeMs }),
    timestamp: dependencies.now(),
  };
}

/**
 * A same-id show without reset replaces the overlay in place on the display it is already on, so
 * the requested or pinned display is irrelevant: resolving it could only fail the call.
 */
async function resolveMutationDisplay(
  inPlace: boolean,
  target: OverlayTarget,
  device: BootedDevice,
  args: z.infer<typeof overlaySchema>,
  dependencies: Pick<OverlayToolDependencies, "adbFactory" | "lastRenderedObservation">,
): Promise<{ displayId?: number; failure?: OverlayResult }> {
  return inPlace ? {} : resolveShowDisplay(target, device, args, dependencies);
}

/**
 * The display an in-place show asked for (a fresh show's resolved one otherwise), resolved only to decide whether to warn that it was
 * ignored. null means it could not be resolved, which is itself ignored, so it always warns.
 */
async function comparableRequestedDisplay(
  inPlace: boolean,
  resolvedDisplayId: number | undefined,
  device: BootedDevice,
  args: z.infer<typeof overlaySchema>,
  dependencies: Pick<OverlayToolDependencies, "adbFactory" | "lastRenderedObservation">,
): Promise<number | undefined | null> {
  if (!inPlace) {
    return resolvedDisplayId;
  }
  if (args.display === undefined) {
    return undefined;
  }
  try {
    const id = await resolveOverlayDisplayId(device, args.display, {
      adb: (dependencies.adbFactory ?? defaultAdbClientFactory).create(device),
      lastRenderedObservation: dependencies.lastRenderedObservation,
    });
    return id || undefined;
  } catch (error) {
    // The selector is irrelevant to an in-place show, so an unresolvable one only changes the warning.
    logger.debug(`[overlay] ignored display selector did not resolve: ${errorMessage(error)}`);
    return null;
  }
}

/**
 * The display an accepted mutation leaves the overlay on. A same-id show without reset is replaced
 * in place on the device, on the display it is already on, so a different requested display is
 * ignored and the caller is told so.
 */
function placedDisplay(
  args: Pick<z.infer<typeof overlaySchema>, "action" | "reset" | "display">,
  shown: OverlayLastResult | undefined,
  displayId: number | undefined | null,
  success: boolean,
): { displayId?: number; warning?: string } {
  if (args.action !== "show" || shown?.id === undefined) {
    return { displayId: displayId ?? undefined };
  }
  // A refused show, reset or not, leaves the overlay on the display it was already on.
  if (!success) {
    return { displayId: shown.displayId };
  }
  if (args.reset === true) {
    return { displayId: displayId ?? undefined };
  }
  if (args.display === undefined || displayId === shown.displayId) {
    return { displayId: shown.displayId };
  }
  const where =
    shown.displayId === undefined ? "the default display" : `logical display ${shown.displayId}`;
  return {
    displayId: shown.displayId,
    warning: `display was ignored: overlay ${shown.id} is already shown on ${where}, and a show with the same id replaces it in place there. Pass reset: true to show it fresh on the requested display.`,
  };
}

/** Element anchors as resolved, also reported when the show then failed, so the caller can re-anchor. */
function anchorsOutput(stage: AnchorStage): Pick<OverlayOutput, "anchors" | "hierarchyUpdatedAt"> {
  return stage.anchors?.length
    ? {
        anchors: stage.anchors,
        ...(stage.hierarchyUpdatedAt === undefined
          ? {}
          : { hierarchyUpdatedAt: stage.hierarchyUpdatedAt }),
      }
    : {};
}

/** [landedWarning] is reported only when the mutation succeeded. */
function missingAssetsOutput(
  result: OverlayResult,
  warnings: readonly (string | undefined)[],
  landedWarning?: string,
): { missingAssets?: string[]; warning?: string } {
  const warning = [...warnings, result.success ? landedWarning : undefined]
    .filter((entry) => entry !== undefined)
    .join(" ");
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
  // The device holds one overlay for every session, so stale ids are enumerated device-wide: a
  // session that tracked the vanished overlay is not necessarily the one inspecting.
  for (const id of store.shownIds(scope.deviceId)) {
    if (!reportedIds.has(id)) {
      events.dismiss(scope.deviceId, id);
      store.dismissed(scope, id);
    }
  }
}

/** Hands the device's report and the events it replayed to the event buffers and status store. */
function adoptReportedOverlays(
  store: OverlayStatusStore,
  events: OverlayEventCoordinator,
  source: OverlayEventSource,
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
      events.adopt(scope, id, source, grouped, entry?.lastSequence ?? 0);
    }
  }
  dropUnreportedOverlays(store, events, scope, reportedIds);
  for (const entry of reported) {
    if (!history.has(entry.id)) {
      events.adopt(scope, entry.id, source, [], entry.lastSequence);
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
  dependencies: Pick<OverlayHandlerDependencies, "store" | "events">,
  target: OverlayTarget,
  scope: OverlayScope,
  timeoutMs: number | undefined,
): Promise<OverlayOutput> {
  const { store, events } = dependencies;
  // overlayPlatformError refuses inspect off Android, so only Android reaches here.
  const client = target.android;
  if (!client) {
    throw new ActionableError("inspect is Android only.");
  }
  // The device drains its offline ring from onClientConnected, which the capability probe below can
  // trigger by connecting, so the capture must be listening before the first operation.
  const replayed: OverlayEvent[] = [];
  const stopCapture = client.onEvent((event) => replayed.push(event));
  let result: OverlayResult;
  try {
    if (!(await client.supportsCommand(OVERLAY_PERSISTENCE_REPLAY_CAPABILITY))) {
      return {
        success: false,
        error: new ActionableError(overlayInspectUnsupportedMessage()).message,
      };
    }
    result = await client.inspect(timeoutMs);
  } catch (error) {
    logger.warn("[overlay] Inspect request failed", error);
    return { success: false, error: toActionableError(error, "Overlay inspect failed").message };
  } finally {
    stopCapture();
  }
  if (!result.success) {
    return { success: false, error: result.error ?? "Overlay inspect failed" };
  }
  adoptReportedOverlays(
    store,
    events,
    overlayEventSource(target.transport),
    scope,
    result.overlays,
    replayed,
  );
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
  source: OverlayEventSource,
  query: Pick<
    z.infer<typeof overlaySchema>,
    "id" | "eventName" | "kind" | "afterSequence" | "timeoutMs"
  >,
  context: { progress?: ProgressCallback; signal?: AbortSignal },
) {
  const waiting = events.awaitEvent(scope, query.id!, source, {
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

/**
 * Inputs only CtrlProxy can honour, refused before any device request. iOS simulators run the
 * injected overlay agent: no display and no reset (a same-id show always replaces in place).
 */
function overlayPlatformError(
  device: BootedDevice,
  args: z.infer<typeof overlaySchema>,
): ActionableError | undefined {
  if (device.platform === "android") {
    return undefined;
  }
  if (device.platform !== "ios") {
    return new ActionableError(
      "Overlays need an Android device or an iOS simulator. Target one with deviceId or sessionUuid.",
    );
  }
  if (args.action === "inspect") {
    return new ActionableError("inspect is Android only; omit it on iOS.");
  }
  if (args.display !== undefined) {
    return new ActionableError("display is Android only; omit display on iOS.");
  }
  if (args.reset !== undefined) {
    return new ActionableError(
      "reset is Android only; on iOS a show with the same id always replaces the overlay in place.",
    );
  }
  if (args.spec !== undefined) {
    const options = requestedOverlayWindowOptions(args.spec as OverlaySpec);
    if (options.appLayer || options.devicePersistence) {
      return new ActionableError(
        'window.layer "app" and window.persistence "device" are Android only; omit them on iOS.',
      );
    }
  }
  return undefined;
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
    deviceUnboundSource: overlayDeviceUnboundSource,
  };
}

/**
 * The single lifecycle mechanism: a released session (and the device its snapshot names),
 * a removed device and an unbound device all clear host status and event buffers.
 *
 * The unbound hook may not be available when the host is created (the daemon host is built
 * before DaemonState initialises), so `ensureSubscribed` retries it until it takes, keeping
 * exactly one active unbound subscription. It also follows the hook's source: once DaemonState is
 * re-initialised with a new session manager, the subscription to the old one is dropped and
 * replaced (#10715).
 */
function subscribeOverlayCleanup(
  lifecycle: OverlayEventLifecycle,
  events: OverlayEventCoordinator,
): { ensureSubscribed: () => void; unsubscribe: () => void } {
  const cleanups = [
    lifecycle.subscribeSessionRelease((sessionUuid, releasedDeviceId) => {
      events.releaseSession(sessionUuid);
      if (releasedDeviceId) {
        events.releaseDevice(releasedDeviceId);
      }
    }),
    lifecycle.subscribeDeviceRemoval((deviceId) => events.releaseDevice(deviceId)),
  ];
  // A lifecycle without a source never re-initialises; one constant stands for it.
  const fixedSource = {};
  let unbound: { source: object; unsubscribe: () => void } | undefined;
  let disposed = false;
  const ensureSubscribed = () => {
    if (disposed) {
      return;
    }
    const source = lifecycle.deviceUnboundSource ? lifecycle.deviceUnboundSource() : fixedSource;
    if (unbound !== undefined && unbound.source === source) {
      return;
    }
    unbound?.unsubscribe();
    unbound = undefined;
    if (source === undefined) {
      return;
    }
    const unsubscribe = lifecycle.subscribeDeviceUnbound((deviceId) =>
      events.releaseDevice(deviceId),
    );
    if (unsubscribe) {
      unbound = { source, unsubscribe };
    }
  };
  ensureSubscribed();
  return {
    ensureSubscribed,
    unsubscribe: () => {
      disposed = true;
      unbound?.unsubscribe();
      unbound = undefined;
      for (const cleanup of cleanups) {
        cleanup();
      }
    },
  };
}

/** Transports cached per underlying client; shared with the host that owns the subscriptions. */
interface OverlayTransportCache {
  android: WeakMap<OverlayClient, AndroidOverlayTransport>;
  ios: WeakMap<OverlayAgentClient, IosOverlayTransport>;
}

/**
 * One transport per underlying client keeps the coordinator's per-device event subscription
 * stable across calls and across MCP connections, exactly as when it subscribed to the client.
 */
function overlayTargets(
  clientFactory: (device: BootedDevice) => OverlayClient,
  agentConnections: OverlayAgentConnections,
  transports: OverlayTransportCache,
): {
  androidTarget: (device: BootedDevice) => OverlayTarget;
  iosTarget: (device: BootedDevice) => OverlayTarget | undefined;
} {
  const androidTarget = (device: BootedDevice): OverlayTarget => {
    const client = clientFactory(device);
    let transport = transports.android.get(client);
    if (transport === undefined) {
      transport = new AndroidOverlayTransport(client);
      transports.android.set(client, transport);
    }
    return { transport, android: transport };
  };
  const iosTarget = (device: BootedDevice): OverlayTarget | undefined => {
    const agent = agentConnections.get(device.deviceId);
    if (agent === undefined) {
      return undefined;
    }
    let transport = transports.ios.get(agent);
    if (transport === undefined) {
      transport = new IosOverlayTransport(agent);
      transports.ios.set(agent, transport);
    }
    return { transport, ios: transport };
  };
  return { androidTarget, iosTarget };
}

function overlayClock(dependencies: OverlayToolDependencies): Pick<Timer, "now"> {
  return dependencies.clock ?? dependencies.timer ?? defaultTimer;
}

/**
 * Host-side overlay state: status, event buffers, commit generations and transports. The daemon
 * re-registers the tool for every MCP connection, so this state must outlive any one handler.
 */
interface OverlayHost {
  store: OverlayStatusStore;
  events: OverlayEventCoordinator;
  commits: OverlayCommitGenerations;
  transports: OverlayTransportCache;
  /** Subscribes any lifecycle hook that was not yet available; a no-op once all are active. */
  ensureLifecycle(): void;
  dispose(): void;
}

function createOverlayHost(dependencies: OverlayToolDependencies): OverlayHost {
  const store = dependencies.store ?? new InMemoryOverlayStatusStore(overlayClock(dependencies));
  const events = new OverlayEventCoordinator(
    dependencies.timer ?? defaultTimer,
    store,
    TelemetryRecorder.getInstance(),
  );
  const cleanup = subscribeOverlayCleanup(
    dependencies.lifecycle ?? defaultOverlayLifecycle(),
    events,
  );
  let disposed = false;
  return {
    store,
    events,
    commits: new OverlayCommitGenerations(),
    transports: { android: new WeakMap(), ios: new WeakMap() },
    ensureLifecycle: cleanup.ensureSubscribed,
    dispose: () => {
      if (!disposed) {
        disposed = true;
        cleanup.unsubscribe();
        events.dispose();
      }
    },
  };
}

/** The daemon-process host every default registration (one per MCP connection) shares. */
let daemonOverlayHost: OverlayHost | undefined;
let activeRegistration: { host: OverlayHost; dispose: () => void } | undefined;

/**
 * Injecting any piece of host state (store, clock, timer, lifecycle) asks for a private host owned
 * by that registration; otherwise every registration shares the daemon host, so a second MCP
 * connection keeps the first one's status and pending events (keyed by session and device).
 */
function overlayHostFor(dependencies: OverlayToolDependencies): OverlayHost {
  const { store, clock, timer, lifecycle } = dependencies;
  if (store || clock || timer || lifecycle) {
    return createOverlayHost(dependencies);
  }
  daemonOverlayHost ??= createOverlayHost(dependencies);
  return daemonOverlayHost;
}

/**
 * A private host is disposed with its registration. The shared host is disposed only by the
 * registration currently installed: an older connection's disposer must not wipe it.
 */
function overlayRegistrationDisposer(host: OverlayHost): () => void {
  const dispose = () => {
    const active = activeRegistration?.dispose === dispose;
    if (active) {
      activeRegistration = undefined;
    }
    if (host !== daemonOverlayHost) {
      host.dispose();
    } else if (active) {
      host.dispose();
      daemonOverlayHost = undefined;
    }
  };
  return dispose;
}

export function registerOverlayTools(dependencies: OverlayToolDependencies = {}): () => void {
  const host = overlayHostFor(dependencies);
  // Replacing a registration that used a different host makes that host's state obsolete.
  if (activeRegistration && activeRegistration.host !== host) {
    activeRegistration.dispose();
  }
  // Per-connection registrations run after DaemonState initialises: pick up the unbound hook.
  host.ensureLifecycle();
  const { store, events, commits } = host;
  const clientFactory =
    dependencies.clientFactory ??
    ((device: BootedDevice) => AndroidCtrlProxyClient.getInstance(device));
  const agentConnections = dependencies.agentConnections ?? noOverlayAgentConnections;
  const { androidTarget, iosTarget } = overlayTargets(
    clientFactory,
    agentConnections,
    host.transports,
  );
  const cacheInvalidator =
    dependencies.cacheInvalidator ?? new DefaultDeviceWindowCacheInvalidator();
  const clock = overlayClock(dependencies);
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
    host.ensureLifecycle();
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
    const platformError = overlayPlatformError(device, args);
    if (platformError) {
      return responseFor({ success: false, error: platformError.message });
    }
    const scope = overlayScope(device, args);
    if (args.action === "status") {
      return responseFor({ success: true, ...statusOutput(store, events, scope) });
    }
    const target = device.platform === "android" ? androidTarget(device) : iosTarget(device);
    if (!target) {
      const error = new ActionableError(overlayAgentNotConnectedMessage(device.deviceId));
      return responseFor({ success: false, error: error.message });
    }
    if (args.action === "inspect") {
      return responseFor(await inspectDevice({ store, events }, target, scope, args.timeoutMs));
    }
    if (args.action === "awaitEvent") {
      const source = overlayEventSource(target.transport);
      const waited = await waitForOverlayEvent(events, scope, source, args, { progress, signal });
      return responseFor({ success: true, ...waited });
    }
    const handlerDependencies: OverlayHandlerDependencies = {
      store,
      events,
      target,
      assetReaders,
      commits,
      cacheInvalidator,
      now: () => clock.now(),
      adbFactory: dependencies.adbFactory,
      lastRenderedObservation: dependencies.lastRenderedObservation,
      anchorHierarchyCaptureFactory: dependencies.anchorHierarchyCaptureFactory,
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
    PROTOTYPE_TOOL_NAME,
    'Show (always a full spec), dismiss (id or all:true), status (host-local, no device request), inspect (asks the device which overlays it is showing and adopts them into status and awaitEvent; use it after a session release or reconnect), or awaitEvent for an overlay id on Android, or on an iOS simulator through the overlay agent that launchApp with overlay:true injects (show, dismiss, status, awaitEvent; sizes are points; reset is Android only). A show with the id of the overlay already on screen replaces it in place: it keeps the display and each pager\'s page (clamped), while the new spec\'s state is authoritative (values the user changed by tapping are not carried over unless the spec includes them); reset:true starts fresh instead. To present alternatives, show one design, describe it and the others in chat (what each is, what changed, which you recommend), and show the next on request; or show one spec whose pager holds every design with a visible label per page. Ask the user in chat which they prefer; never wait on the device for a choice. awaitEvent returns one buffered event, supports eventName/kind and afterSequence, and times out successfully (timedOut:true); default 30000 ms, maximum 60000 ms. Buffer: 64 events per session/device/id; overflow drops oldest and reports droppedCount. Lower-or-equal sequences are ignored, including late arrivals and reconnect replays. Nodes: box/row/column, text/image/icon/spacer/textField, Material switch/checkbox/button/radioGroup/listItem/slider/chip/card/iconButton/fab/segmentedButton/topAppBar/divider/badge/progress/dialog/snackbar/timePicker/datePicker bound to state keys, scroll/pager/tabBar/bottomNav/bottomSheet; actions: emit/setPage/setState/toggle/increment/decrement/dismiss. Sizes and anchors use dp (points on iOS). A node\'s anchor {type:"element",selector:{elementId,text,testTag,container},alignment:cover|top|bottom|start|end,offset?} is resolved once at show against the app (the overlay excluded) and converted to dp with the display density (iOS bounds are already points); a missing, ambiguous or off-screen element fails the show, and the result reports anchors and hierarchyUpdatedAt (show again to re-anchor). {type:"bounds",bounds:{x,y,width,height}} is screen dp (screen points on iOS). Window placement: fullscreen/sheet/floating, window.opacity: 0-100 (default 100). Example: {action:"show",spec:{id:"demo",window:{placement:{type:"fullscreen"},opacity:80},root:{type:"text",text:"Hello"}}}. show also accepts assets:[{id,path}] (absolute local PNG/JPEG/WebP file path, or a TTF/OTF font file referenced from style.fontFamily as {asset}) or [{id,observation}] (an observation screenshot URI) uploaded before the overlay is sent; image nodes reference the id. If the device reports supplied assets missing, they are re-uploaded and the overlay re-sent once; missingAssets and warning report what is still missing. Verify with observe; no screenshot is returned. Status makes no device request and includes pendingCount/lastSequence/droppedCount after events arrive. Device dismissed events remove shown status; the terminal event remains available until consumed or explicit show/dismiss. Awaiting consumes events; unmatched events remain buffered. Optional MCP progress reports wait start/finish without delaying the wait. Session release, device removal and unbinding clear buffers. A disconnect alone is not observed. window.layer: system (default, above system UI) or app (above apps only, so the shade, keyboard and screenshot preview draw over it; the daemon grants CtrlProxy SYSTEM_ALERT_WINDOW with appops first). window.persistence: session (default) or device: the overlay stays interactive after USB/adb disconnect and session end with no idle timeout, keeps its assets, and carries a visible Close control; remove it with that control, dismiss, or a new show. Both are Android only and need a CtrlProxy advertising overlay_window_options_v1. A device-persistent overlay keeps emitting taps, page changes and text input while no host is connected: the device buffers the last 200 events (oldest dropped, counted) and delivers them when a host connects or on inspect, with sequences continuing and no rewind; inspect returns deviceDroppedEvents. inspect needs a CtrlProxy advertising overlay_persistence_replay_v1 and is refused otherwise.',
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
  const dispose = overlayRegistrationDisposer(host);
  activeRegistration = { host, dispose };
  return dispose;
}

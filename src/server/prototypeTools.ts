import { TelemetryRecorder } from "../features/telemetry/TelemetryRecorder";
import { z } from "zod/v4";
import { z as specZ, type ZodTypeAny } from "zod";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { SessionReleaseBroadcaster } from "./sessionReleaseBroadcast";
import { getDaemonStreamDeviceLifecycleEmitter } from "../daemon/streamDeviceLifecycleEvents";
import { PrototypeEventCoordinator } from "../features/prototype/PrototypeEventCoordinator";
import {
  DEFAULT_PROTOTYPE_EVENT_TIMEOUT_MS,
  MAX_PROTOTYPE_EVENT_TIMEOUT_MS,
} from "../features/prototype/prototypeEventTimeout";
import { DaemonState } from "../daemon/daemonState";
import type { PrototypeMutation } from "../features/prototype/PrototypeStatusStore";
import { defaultTimer } from "../utils/SystemTimer";
import { combineWithAmbientAbort } from "../utils/AbortContext";
import type { ProgressCallback } from "./toolRegistry";
import { ToolRegistry } from "./toolRegistry";
import { addDeviceTargetingToSchema, withJsonSchemaOverride } from "./toolSchemaHelpers";
import { ActionableError, toActionableError } from "../models/ActionableError";
import type { BootedDevice } from "../models";
import { AndroidCtrlProxyClient } from "../features/observe/android/AndroidCtrlProxyClient";
import {
  AndroidPrototypeTransport,
  type AndroidPrototypeClient,
} from "../features/prototype/androidPrototypeTransport";
import {
  prototypeAssetPutClient,
  prototypeEventSource,
  type PrototypeTransport,
} from "../features/prototype/PrototypeTransport";
import type { PrototypeEventSource } from "../features/prototype/PrototypeEventCoordinator";
import {
  IOS_PROTOTYPE_INSPECT_CAPABILITY,
  IosPrototypeTransport,
  noPrototypeAgentConnections,
  prototypeAgentNotConnectedMessage,
  type PrototypeAgentConnections,
} from "../features/prototype/ios/iosPrototypeTransport";
import type { PrototypeAgentClient } from "../features/prototype/ios/prototypeAgentClient";
import {
  prototypeDisplayUnsupportedMessage,
  prototypeInspectUnsupportedMessage,
} from "../features/observe/android/CtrlProxyPrototypes";
import {
  PROTOTYPE_ANCHOR_CAPABILITY,
  PROTOTYPE_APPEARANCE_CAPABILITY,
  PROTOTYPE_DISPLAY_CAPABILITY,
  PROTOTYPE_EVENT_KINDS,
  PROTOTYPE_PERSISTENCE_REPLAY_CAPABILITY,
  PROTOTYPE_THEME_MODES_CAPABILITY,
  PROTOTYPE_WINDOW_OPTIONS_CAPABILITY,
  PROTOTYPE_SHOW_IN_PLACE_CAPABILITY,
} from "../features/observe/android/ctrlProxyProtocol";
import type {
  PrototypeDismiss,
  PrototypeEvent,
  PrototypeResult,
  PrototypeStatusEntry,
} from "../features/observe/android/ctrlProxyProtocol";
import {
  MAX_PROTOTYPE_SPEC_BYTES,
  prototypeSpecSchema,
  type PrototypeSpec,
} from "../features/prototype/prototypeSpec";
import { readPrototypeSpecFile } from "../features/prototype/prototypeSpecFile";
import { validatePrototypeSpec } from "../features/prototype/prototypeValidation";
import {
  expandPrototypeComponents,
  MAX_PROTOTYPE_COMPONENT_DEPTH,
  prototypeSpecForDevice,
} from "../features/prototype/prototypeComponents";
import { STATE_KEY } from "../features/prototype/prototypeTemplate";
import {
  hasElementAnchors,
  hasPrototypeAnchors,
  prototypeAnchorPlacementError,
  resolvePrototypeAnchors,
  type ResolvedPrototypeAnchor,
} from "../features/prototype/prototypeAnchors";
import type { HierarchyCapture } from "../features/observe/HierarchyCapture";
import { createDeviceHierarchyCapture } from "../features/observe/DeviceHierarchyCapture";
import {
  grantPrototypeAppLayer,
  prototypeWindowOptionsUnsupportedMessage,
  requestedPrototypeWindowOptions,
} from "../features/prototype/prototypeWindowOptions";
import {
  prototypeThemeModeFields,
  prototypeThemeModesUnsupportedMessage,
} from "../features/prototype/prototypeThemeModes";
import {
  parsePrototypeAppearance,
  PROTOTYPE_APPEARANCE_INPUTS,
  PROTOTYPE_APPEARANCE_MODES,
  PROTOTYPE_APPEARANCE_SOURCES,
  prototypeAppearanceOverride,
  prototypeAppearanceUnsupportedMessage,
  shownAppearance,
} from "../features/prototype/prototypeAppearance";
import {
  resolvePrototypeDisplayId,
  type PrototypeDisplayDependencies,
} from "../features/prototype/prototypeDisplay";
import {
  InMemoryPrototypeStatusStore,
  type PrototypeLastResult,
  type PrototypeStatusStore,
  type PrototypeScope,
} from "../features/prototype/PrototypeStatusStore";
import { PrototypeCommitGenerations } from "../features/prototype/PrototypeCommitGenerations";
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
  nodePrototypeAssetFileReader,
  preparePrototypeAssets,
  uploadPrototypeAssets,
  type PrototypeAssetFileReader,
  type PrototypeObservationScreenshotReader,
  type UploadedPrototypeAsset,
} from "../features/prototype/prototypeAssetUploader";
import type { PrototypeAssetUpload } from "../features/prototype/prototypeAssets";
import {
  missingAssetsWarning,
  type MissingAssetRepair,
} from "../features/prototype/prototypeMissingAssets";
import { PROTOTYPE_SUSPENDED_WAIT_WARNING } from "../features/prototype/prototypeSuspended";
import { readObservationScreenshotBytes } from "./observationResources";
import {
  DefaultDeviceWindowCacheInvalidator,
  type DeviceWindowCacheInvalidator,
} from "../features/observe/DeviceWindowCacheInvalidator";
import {
  MAX_PROTOTYPE_ASSET_COUNT,
  MAX_PROTOTYPE_ASSET_ID_LENGTH,
} from "../features/prototype/prototypeAssets";

// The settled spec is Zod 3; registry/device targeting use Zod 4. The installed
// MCP SDK converts the original schema, avoiding a second authored spec schema.
// The SDK union of Zod 3/4 schemas exceeds TS instantiation depth; this call accepts only Zod 3.
// oxlint-disable-next-line auto-mobile/no-unknown-cast -- Narrow the SDK converter at the Zod 3/4 boundary.
const convertSpec = toJsonSchemaCompat as unknown as (
  schema: ZodTypeAny,
) => Record<string, unknown>;
const advertisedSpec = convertSpec(prototypeSpecSchema);
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
/**
 * Reusable components (#11053) are expanded on the host before validation, so they are not part of
 * the device spec schema; advertise the authored `components` map and `use` node here. Every
 * child slot already points at the root node schema, so a `use` fits wherever a node does.
 */
function advertiseComponents(spec: Record<string, unknown>): void {
  const properties = spec.properties as Record<string, Record<string, unknown>> | undefined;
  const root = properties?.root;
  if (!properties || !Array.isArray(root?.anyOf)) {
    return;
  }
  const name = { type: "string", pattern: STATE_KEY.source };
  root.anyOf = [
    ...(root.anyOf as unknown[]),
    {
      type: "object",
      description:
        "Replaced on the host by components[component].root with {props.<field>} bound in the fields repeat binds; a placeholder that is the whole value keeps the prop's type",
      properties: {
        type: { type: "string", enum: ["use"] },
        component: name,
        props: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] } },
      },
      required: ["type", "component"],
      additionalProperties: false,
    },
  ];
  properties.components = {
    type: "object",
    description: `Reusable node templates by name, placed with {type:"use",component,props}; expanded on the host before validation (use nesting up to ${MAX_PROTOTYPE_COMPONENT_DEPTH} deep, no cycles, every prop used); limits apply to the expanded spec`,
    propertyNames: { pattern: STATE_KEY.source },
    additionalProperties: {
      type: "object",
      properties: { root: { $ref: "#/properties/spec/properties/root" } },
      required: ["root"],
      additionalProperties: false,
    },
  };
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
advertiseComponents(advertisedSpec);
const specDetailsSchema = specZ.object({ spec: prototypeSpecSchema });
const stateDetailsSchema = prototypeSpecSchema.pick({ state: true });

/** The first problem with an authored spec as `{path, text}`; `text` includes Zod's allowed values. */
function specProblem(spec: unknown): { path: string; text: string } | undefined {
  const validated = validatePrototypeSpec(spec);
  if (validated.success) {
    return undefined;
  }
  const { path, message } = validated.error;
  // Nested authored values are not tool metadata. Strip only the envelope so
  // reserved names inside state remain valid user keys.
  // Zod describes the device spec, so it reads the expanded one; a component error has no Zod
  // counterpart to add.
  const expansion = expandPrototypeComponents(spec);
  const external = { spec: expansion.success ? expansion.spec : spec };
  deleteInternalToolParams(external);
  // The contract supplies deterministic paths/limits; Zod supplies allowed enum
  // values and numeric bounds. Avoid recursing into inputs that exceed limits.
  const details =
    !expansion.success || /limit|depth|budget/i.test(message)
      ? undefined
      : specDetailsSchema.safeParse(external);
  return {
    path,
    text: `${message}${details && !details.success ? `; ${details.error.message}` : ""}`,
  };
}

function specError(spec: unknown): string | undefined {
  const problem = specProblem(spec);
  return problem && `Invalid prototype at spec.${problem.path}: ${problem.text}`;
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
          "Invalid prototype at state: use flat string, number or boolean values and keys matching [A-Za-z_][A-Za-z0-9_]{0,63}",
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
          .max(MAX_PROTOTYPE_ASSET_ID_LENGTH)
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
  .max(MAX_PROTOTYPE_ASSET_COUNT);

export const prototypeSchema = addDeviceTargetingToSchema(
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
          'Full prototype spec: id, window, optional theme (mode light|dark|system, colors.seed hex or colors.source "device", plus optional per-role hex overrides in colors such as colors.primary or colors.surface applied over that scheme in light and dark, typography.scale 0.75-1.5 and fontFamily sans|serif|mono, shapes.corner none|small|medium|large|full; text style.textStyle names a Material type role such as titleLarge; style color, background and border.color take hex or a Material colour role such as primary, onSurface, surfaceContainer; style.cornerRadius takes dp, none|extraSmall|small|medium|large|extraLarge|full, or per-corner {topStart,topEnd,bottomEnd,bottomStart} dp), optional state, root. window.opacity is 0-100, default 100. show always renders the whole spec; spec.state is authoritative. window.layer "app" and window.persistence "device" need a CtrlProxy advertising prototype_window_options_v1. Per-mode forms need a device advertising prototype_theme_modes_v1 and are refused otherwise: a colour field, gradient stop or scrim as {light, dark} (each hex or a role), a role name in a gradient stop or scrim, theme.colors.light / theme.colors.dark {role: hex} maps applied after the flat overrides for the resolved mode, and image.asset or a tabBar/bottomNav item image as {light, dark} asset ids.',
        ),
      specPath: z
        .string()
        .min(1)
        .optional()
        .describe(
          `show only: instead of spec, an absolute path of a local JSON file holding the same spec (up to ${MAX_PROTOTYPE_SPEC_BYTES} bytes) that the daemon reads and validates like an inline spec; the path is never sent to the device. Exactly one of spec or specPath. Use it for a spec a script generated, instead of pasting the JSON into the call.`,
        ),
      display: z
        .string()
        .optional()
        .describe(
          "show only: panel key, role, or active to show the prototype on. Precedence: explicit display, then the session display pin, then the default display. Needs a CtrlProxy advertising prototype_display_id_v1; a disconnected panel is refused. Ignored, with a warning, by a same-id show without reset, which keeps the display the prototype is on.",
        ),
      reset: z
        .boolean()
        .optional()
        .describe(
          "show only: when the prototype with spec.id is already shown, start it fresh (pager pages from the spec, display re-resolved) instead of replacing it in place",
        ),
      appearance: z
        .enum(PROTOTYPE_APPEARANCE_INPUTS)
        .optional()
        .describe(
          'show only: what the system light/dark setting means for this prototype. device (default) follows the device; light or dark pins it without changing the device or the app behind, so a spec with theme.mode "system" or no mode can be checked in both modes. It replaces the system setting only: an explicit theme.mode, a flat theme.colors.background/surface override and an opaque authored background still decide first. Each show states it afresh (a same-id show without it follows the device again). light and dark need a device advertising prototype_appearance_v1 and are refused otherwise.',
        ),
      id: z
        .string()
        .min(1)
        .optional()
        .describe("Prototype id required for dismiss (unless all: true) and awaitEvent"),
      assets: assetsInput
        .optional()
        .describe(
          "show only: images to upload before the prototype is sent, as {id, path} with an absolute local file path or {id, observation} with an observation screenshot URI (PNG, JPEG or WebP, up to 4 MiB each, 16 MiB total, 32 assets). Reference each id from image nodes, or from style.fontFamily as {asset} for a TTF/OTF font file (path only, up to 2 MiB). Uploads are sequential; any failure fails the call before the prototype changes and names the assets already stored. If the device reports a supplied asset missing after the prototype is sent, it is re-uploaded and the prototype re-sent once.",
        ),
      all: z.literal(true).optional().describe("Dismiss all prototypes on the targeted device"),
      eventName: z.string().min(1).optional().describe("awaitEvent only: filter event name"),
      kind: z
        .enum(PROTOTYPE_EVENT_KINDS)
        .optional()
        .describe(
          "awaitEvent only: filter event kind. appearance_changed (name null, payload {mode, source}) is sent once whenever the shown prototype's resolved light/dark mode changes, by a device advertising prototype_appearance_v1",
        ),
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
          `Device request timeout; awaitEvent defaults to ${DEFAULT_PROTOTYPE_EVENT_TIMEOUT_MS} ms, maximum ${MAX_PROTOTYPE_EVENT_TIMEOUT_MS} ms; timeout is a successful empty result.`,
        ),
    })
    .strict(),
).superRefine((value, ctx) => {
  const fields = [
    "spec",
    "specPath",
    "id",
    "all",
    "display",
    "reset",
    "appearance",
    "eventName",
    "kind",
    "afterSequence",
    "assets",
  ] as const;
  const allowed: Record<typeof value.action, readonly string[]> = {
    show: ["spec", "specPath", "display", "reset", "appearance", "assets"],
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
  if (value.action === "show" && (value.spec === undefined) === (value.specPath === undefined)) {
    ctx.addIssue({
      code: "custom",
      path: ["spec"],
      message:
        value.spec === undefined
          ? "show requires exactly one of spec or specPath"
          : "show takes either spec or specPath, not both",
    });
  }
  if (value.action === "dismiss" && (value.id === undefined) === (value.all === undefined)) {
    ctx.addIssue({
      code: "custom",
      path: ["id"],
      message: "dismiss requires exactly one of id or all: true",
    });
  }
});

function validateAwaitEventInput(
  value: z.infer<typeof prototypeSchema>,
  ctx: z.RefinementCtx,
): void {
  if (value.id === undefined) {
    ctx.addIssue({ code: "custom", path: ["id"], message: "awaitEvent requires id" });
  }
  if (value.timeoutMs !== undefined && value.timeoutMs > MAX_PROTOTYPE_EVENT_TIMEOUT_MS) {
    ctx.addIssue({
      code: "custom",
      path: ["timeoutMs"],
      message: `awaitEvent timeoutMs must not exceed ${MAX_PROTOTYPE_EVENT_TIMEOUT_MS}`,
    });
  }
}

/** status and inspect show nothing on the device: reads (#10965). The rest are control. */
function isPrototypeReadAction(args: z.infer<typeof prototypeSchema>): boolean {
  return args.action === "status" || args.action === "inspect";
}

function prototypeScope(
  device: BootedDevice,
  args: z.infer<typeof prototypeSchema>,
): PrototypeScope {
  const context = getToolSelectionContext();
  return {
    sessionUuid:
      args.sessionUuid ?? context?.routingSessionUuid ?? context?.toolSelectionProfileUuid,
    deviceId: device.deviceId,
  };
}

const appearanceSchema = z.object({
  mode: z.enum(PROTOTYPE_APPEARANCE_MODES),
  source: z
    .enum(PROTOTYPE_APPEARANCE_SOURCES)
    .describe(
      "What decided the mode: explicit (theme.mode light or dark), roleLuminance (the flat theme.colors.background, else surface, override), authoredBackground (the first opaque authored background), override (the show's appearance), or system (the device's own setting)",
    ),
  deviceDark: z
    .boolean()
    .describe(
      "The device's own setting whatever decided mode, as of the last show, inspect or system-sourced appearance_changed event",
    ),
});
const lastResultSchema = z.object({
  id: z.string().optional(),
  all: z.literal(true).optional(),
  lastAction: z.enum(["show", "dismiss"]),
  adopted: z
    .literal(true)
    .optional()
    .describe("The device reported this prototype through inspect; this host did not show it"),
  persistent: z
    .boolean()
    .optional()
    .describe(
      "Adopted prototypes only: true when the device keeps the prototype after the host disconnects (window.persistence: device), false when it ends with the session",
    ),
  suspended: z
    .literal(true)
    .optional()
    .describe(
      "Android only: the prototype is hidden because the app it was shown over is not in front (as of the last inspect); its state is kept and it returns with the app. Absent when visible and on iOS",
    ),
  displayId: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Android logical display the prototype was shown on; absent for the default display"),
  appearance: appearanceSchema
    .optional()
    .describe(
      "The light or dark mode the prototype is drawn in, as the device last reported it: in lastResult what a successful show resolved to, and per prototype in status and inspect that value refreshed by inspect and by appearance_changed events. Absent when the device does not advertise prototype_appearance_v1, on dismiss and on a failed show",
    ),
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
    .describe("Highest sequence accepted for this prototype"),
  droppedCount: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Cumulative events dropped by buffer overflow in this scope"),
});
const prototypeEventOutputSchema = z.object({
  id: z.string(),
  sequence: z.number().int().nonnegative(),
  kind: z.enum(PROTOTYPE_EVENT_KINDS),
  name: z.string().nullable(),
  payload: z.json(),
  state: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  pages: z.record(z.string(), z.number().int().nonnegative()),
  timestamp: z.number(),
});
export const prototypeOutputSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  prototypes: z
    .array(
      lastResultSchema.extend(eventCountsSchema.shape).extend({
        pages: z.record(z.string(), z.number().int().nonnegative()).optional(),
        state: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
        lastKnown: z
          .literal(true)
          .optional()
          .describe(
            "Pages and state are the last accepted prototype_event snapshot, not a live device query",
          ),
      }),
    )
    .optional(),
  lastResult: lastResultSchema.optional(),
  event: prototypeEventOutputSchema.optional(),
  timedOut: z
    .literal(true)
    .optional()
    .describe("awaitEvent reached its timeout without a matching event; success remains true"),
  reason: z
    .literal("dismissed")
    .optional()
    .describe("The prototype scope ended without a matching event"),
  uploadedAssets: z
    .array(z.object({ id: z.string(), mimeType: z.string(), bytes: z.number().int().positive() }))
    .optional()
    .describe(
      "show with assets: assets the device confirmed, also present on failure. They stay on the device until the prototype session ends.",
    ),
  missingAssets: z
    .array(z.string())
    .optional()
    .describe(
      "show: asset ids the prototype references that the device has no copy of; the prototype is shown with placeholders. Absent when none. Upload them with assets on a show.",
    ),
  warning: z
    .string()
    .optional()
    .describe(
      "show succeeded or awaitEvent timed out, and it needs attention: names what to do about missingAssets, that display was ignored by a same-id show, or (awaitEvent timeout) that the prototype is hidden because its app is not in front",
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
      "show with element anchors: each anchored node's path and the app element bounds it was resolved to, as observe reports them (boundsPx: px on Android, points on iOS) and in spec units (bounds: dp on Android, points on iOS). Resolved once at show; the prototype does not follow later scrolling or layout, so show again to re-anchor.",
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

export interface PrototypeEventLifecycle {
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
type PrototypeClient = AndroidPrototypeClient;
/**
 * The transport for one call; `android` carries the CtrlProxy-only display gate and inspect, `ios`
 * the injected agent's advertised capabilities.
 */
interface PrototypeTarget {
  transport: PrototypeTransport;
  android?: AndroidPrototypeTransport;
  ios?: Pick<IosPrototypeTransport, "supportsCapability" | "status">;
}
export interface PrototypeToolDependencies {
  /** Reads local files named by `assets`; tests inject an in-memory reader. */
  assetFileReader?: PrototypeAssetFileReader;
  /** Resolves `assets[].observation` URIs; defaults to the observation screenshot resource. */
  observationScreenshotReader?: PrototypeObservationScreenshotReader;
  clientFactory?: (device: BootedDevice) => PrototypeClient;
  /** Injected iOS simulator agent connections, recorded by `launchApp {prototype: true}` (#10567). */
  agentConnections?: PrototypeAgentConnections;
  adbFactory?: AdbClientFactory;
  lastRenderedObservation?: PrototypeDisplayDependencies["lastRenderedObservation"];
  store?: PrototypeStatusStore;
  clock?: Pick<Timer, "now">;
  timer?: Timer;
  lifecycle?: PrototypeEventLifecycle;
  /** Retires the device's cached observation after a show or dismiss lands; tests inject a fake. */
  cacheInvalidator?: DeviceWindowCacheInvalidator;
  /** Captures the hierarchy element anchors resolve against; tests inject captured hierarchies. */
  anchorHierarchyCaptureFactory?: (device: BootedDevice) => HierarchyCapture;
}
/** MCP name of the on-device prototype tool. */
export const PROTOTYPE_TOOL_NAME = "prototype";
const responseFor = (payload: z.infer<typeof prototypeOutputSchema>) =>
  withIsErrorOnFailure(createStructuredToolResponse(payload), payload.success);

// Validation has already succeeded. Forward authored specs unchanged; omitted
// defaults (including opacity=100) remain the wire contract's defaults.
async function mutate(
  target: PrototypeTarget,
  args: z.infer<typeof prototypeSchema>,
  displayId?: number,
): Promise<PrototypeResult> {
  if (args.action === "show") {
    return target.transport.show(args.spec as PrototypeSpec, {
      timeoutMs: args.timeoutMs,
      displayId,
      reset: args.reset,
      // [appearanceRefusal] already ended the call when the device would ignore it.
      appearance: prototypeAppearanceOverride(args.appearance),
    });
  }
  const dismissal: PrototypeDismiss = args.all ? { all: true } : { id: args.id! };
  return target.transport.dismiss(dismissal, args.timeoutMs);
}

/**
 * Resolves `display` (already explicit-or-pinned) to a logical display id and refuses, before
 * anything is sent, when the device cannot honour it. Only show carries a display.
 */
async function showDisplayId(
  target: PrototypeTarget,
  device: BootedDevice,
  args: z.infer<typeof prototypeSchema>,
  dependencies: Pick<PrototypeToolDependencies, "adbFactory" | "lastRenderedObservation">,
): Promise<number | undefined> {
  // prototypePlatformError refuses display off Android, so only Android reaches the resolver.
  if (args.action !== "show" || args.display === undefined || !target.android) {
    return undefined;
  }
  const displayId = await resolvePrototypeDisplayId(device, args.display, {
    adb: (dependencies.adbFactory ?? defaultAdbClientFactory).create(device),
    lastRenderedObservation: dependencies.lastRenderedObservation,
  });
  // Id 0 is the default display: it needs neither the wire field nor the capability, and the
  // result schema leaves displayId absent for it, so it is never carried forward as 0.
  if (!displayId) {
    return undefined;
  }
  if (!(await target.android.supportsCommand(PROTOTYPE_DISPLAY_CAPABILITY))) {
    throw new ActionableError(prototypeDisplayUnsupportedMessage(displayId));
  }
  return displayId;
}

/**
 * Refuses, before anything is sent, a spec whose window options the device would silently ignore.
 * It has no device side effect: the app-layer grant is [appLayerGrant], run last.
 */
async function windowOptionsRefusal(
  target: PrototypeTarget,
  args: z.infer<typeof prototypeSchema>,
  signal: AbortSignal | undefined,
): Promise<PrototypeResult | undefined> {
  if (args.action !== "show" || args.spec === undefined) {
    return undefined;
  }
  const options = requestedPrototypeWindowOptions(args.spec as PrototypeSpec);
  if (!options.appLayer && !options.devicePersistence) {
    return undefined;
  }
  // prototypePlatformError refuses persistence off Android; layer "app" is ignored on iOS.
  if (!target.android) {
    return undefined;
  }
  const supported = await target.android.supportsCommand(PROTOTYPE_WINDOW_OPTIONS_CAPABILITY);
  // The lookup waits for connection and handshake; an abort during it must stop every variant.
  signal?.throwIfAborted();
  if (!supported) {
    return {
      success: false,
      error: new ActionableError(prototypeWindowOptionsUnsupportedMessage(options)).message,
    };
  }
  return undefined;
}

/**
 * The SYSTEM_ALERT_WINDOW grant for an app-layer window (the device re-checks it and fails with
 * the appop command when the grant did not take), or undefined when the show needs none. It is a
 * device mutation, so it runs after every refusal, immediately before the show is sent.
 */
function appLayerGrant(
  target: PrototypeTarget,
  device: BootedDevice,
  args: z.infer<typeof prototypeSchema>,
  dependencies: Pick<PrototypeToolDependencies, "adbFactory">,
  signal: AbortSignal | undefined,
): (() => Promise<void>) | undefined {
  if (args.action !== "show" || args.spec === undefined || !target.android) {
    return undefined;
  }
  if (!requestedPrototypeWindowOptions(args.spec as PrototypeSpec).appLayer) {
    return undefined;
  }
  return async () => {
    await grantPrototypeAppLayer(
      (dependencies.adbFactory ?? defaultAdbClientFactory).create(device),
      signal,
    );
    // An abort that landed after the grant completed must still stop the mutation.
    signal?.throwIfAborted();
  };
}

/**
 * Refuses, before anything is sent, a spec that uses a per-mode form (#11218) on a device whose
 * renderer does not resolve them: an older device rejects the spec or draws one mode's value.
 */
async function themeModesRefusal(
  target: PrototypeTarget,
  args: z.infer<typeof prototypeSchema>,
  signal: AbortSignal | undefined,
): Promise<PrototypeResult | undefined> {
  if (args.action !== "show" || args.spec === undefined) {
    return undefined;
  }
  const fields = prototypeThemeModeFields(args.spec);
  if (fields.length === 0) {
    return undefined;
  }
  const supported = target.android
    ? await target.android.supportsCommand(PROTOTYPE_THEME_MODES_CAPABILITY)
    : target.ios?.supportsCapability(PROTOTYPE_THEME_MODES_CAPABILITY) === true;
  // The lookup waits for connection and handshake; an abort during it must stop the show.
  signal?.throwIfAborted();
  if (supported) {
    return undefined;
  }
  const message = prototypeThemeModesUnsupportedMessage(fields, target.android ? "android" : "ios");
  return { success: false, error: new ActionableError(message).message };
}

/**
 * Refuses, before anything is sent, a `light` or `dark` appearance override (#11223) on a device
 * that does not advertise `prototype_appearance_v1`: an older device ignores the request field and
 * draws the prototype in the device's own mode, which the caller would take for the pinned one.
 * `device` and an omitted `appearance` send nothing, so they need no capability.
 */
async function appearanceRefusal(
  target: PrototypeTarget,
  args: z.infer<typeof prototypeSchema>,
  signal: AbortSignal | undefined,
): Promise<PrototypeResult | undefined> {
  const override =
    args.action === "show" ? prototypeAppearanceOverride(args.appearance) : undefined;
  if (override === undefined) {
    return undefined;
  }
  const supported = target.android
    ? await target.android.supportsCommand(PROTOTYPE_APPEARANCE_CAPABILITY)
    : target.ios?.supportsCapability(PROTOTYPE_APPEARANCE_CAPABILITY) === true;
  // The lookup waits for connection and handshake; an abort during it must stop the show.
  signal?.throwIfAborted();
  if (supported) {
    return undefined;
  }
  const message = prototypeAppearanceUnsupportedMessage(
    override,
    target.android ? "android" : "ios",
  );
  return { success: false, error: new ActionableError(message).message };
}

const IOS_RESET_UNSUPPORTED_MESSAGE = `The connected iOS prototype agent does not advertise ${PROTOTYPE_SHOW_IN_PLACE_CAPABILITY}, so it does not support reset: it would keep the pager pages instead of starting fresh. Nothing was shown. Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version, or omit reset.`;

/**
 * Refuses, before anything is sent or any host state changes (#11394), `reset: true` on an iOS
 * prototype agent that does not advertise `prototype_show_in_place_v1`: the transport refuses it
 * too, but only after the event epoch was reset and assets uploaded. Android needs no refusal
 * here: an older CtrlProxy re-shows fresh, which [legacyInPlaceWarning] reports.
 */
function iosResetRefusal(
  target: PrototypeTarget,
  args: z.infer<typeof prototypeSchema>,
): PrototypeResult | undefined {
  if (
    args.action !== "show" ||
    args.reset !== true ||
    !target.ios ||
    target.ios.supportsCapability(PROTOTYPE_SHOW_IN_PLACE_CAPABILITY)
  ) {
    return undefined;
  }
  return { success: false, error: new ActionableError(IOS_RESET_UNSUPPORTED_MESSAGE).message };
}

interface AnchorStage {
  /** The spec to send, element anchors replaced by bounds anchors; absent when unchanged. */
  spec?: PrototypeSpec;
  anchors?: ResolvedPrototypeAnchor[];
  hierarchyUpdatedAt?: number;
  failure?: PrototypeResult;
}

const ANCHOR_UNSUPPORTED_MESSAGE = `The connected CtrlProxy does not advertise ${PROTOTYPE_ANCHOR_CAPABILITY}, so it would ignore anchor and draw the node at its normal position. Nothing was shown. Update the connected CtrlProxy, or remove anchor.`;
const IOS_ANCHOR_UNSUPPORTED_MESSAGE = `The connected iOS prototype agent does not advertise ${PROTOTYPE_ANCHOR_CAPABILITY}, so it would ignore anchor and draw the node at its normal position. Nothing was shown. Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version, or remove anchor.`;
const ANCHOR_DISPLAY_MESSAGE =
  "Element anchors resolve against the default display's app hierarchy, so they cannot be shown on another display. Nothing was shown. Omit display, or use a bounds anchor in dp.";

/** Throws when the connected CtrlProxy or iOS prototype agent would ignore the spec's anchors. */
async function assertAnchorCapability(target: PrototypeTarget): Promise<void> {
  if (target.android) {
    if (!(await target.android.supportsCommand(PROTOTYPE_ANCHOR_CAPABILITY))) {
      throw new ActionableError(ANCHOR_UNSUPPORTED_MESSAGE);
    }
    return;
  }
  if (!target.ios?.supportsCapability(PROTOTYPE_ANCHOR_CAPABILITY)) {
    throw new ActionableError(IOS_ANCHOR_UNSUPPORTED_MESSAGE);
  }
}

/** Throws when the device would ignore the spec's anchors or its placement would clip them. */
async function assertAnchorsShowable(
  target: PrototypeTarget,
  spec: PrototypeSpec,
  displayId: number | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  await assertAnchorCapability(target);
  signal?.throwIfAborted();
  const placementError = prototypeAnchorPlacementError(spec);
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
  spec: PrototypeSpec,
  request: { timeoutMs?: number; signal?: AbortSignal },
  dependencies: Pick<PrototypeToolDependencies, "anchorHierarchyCaptureFactory">,
): Promise<AnchorStage> {
  if (!hasElementAnchors(spec)) {
    return {};
  }
  const capture = (
    dependencies.anchorHierarchyCaptureFactory ?? ((d) => createDeviceHierarchyCapture(d))
  )(device);
  const snapshot = await capture.capture({ freshness: "fresh", ...request });
  // iOS hierarchies are in points, the unit iOS spec sizes use; Android's px convert to dp.
  const resolution = resolvePrototypeAnchors(spec, {
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
 * resolves each element anchor against a fresh app hierarchy (the prototype excluded), converting
 * Android px bounds to dp once with the display density; iOS bounds are points already (#9316). A
 * missing, ambiguous or off-screen element fails the show.
 */
async function resolveShowAnchors(
  target: PrototypeTarget,
  device: BootedDevice,
  args: z.infer<typeof prototypeSchema>,
  context: { displayId?: number; signal?: AbortSignal },
  dependencies: Pick<PrototypeToolDependencies, "anchorHierarchyCaptureFactory">,
): Promise<AnchorStage> {
  const { displayId, signal } = context;
  const spec = args.action === "show" ? (args.spec as PrototypeSpec | undefined) : undefined;
  if (!spec || !hasPrototypeAnchors(spec)) {
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
    logger.warn(`[prototype] anchor resolution refused the show: ${errorMessage(error)}`);
    return {
      failure: {
        success: false,
        error: toActionableError(error, "Prototype anchor failed").message,
      },
    };
  }
}

interface AssetStage {
  uploaded: UploadedPrototypeAsset[];
  /** The validated uploads, kept so a missing asset can be re-sent without re-reading its source. */
  prepared: PrototypeAssetUpload[];
  failure?: PrototypeResult;
}

interface AssetReaders {
  assetFileReader: PrototypeAssetFileReader;
  observationScreenshotReader: PrototypeObservationScreenshotReader;
}

/** Upload every `assets` entry before the prototype is sent; a failure ends the call. */
async function stageAssets(
  target: PrototypeTarget,
  args: z.infer<typeof prototypeSchema>,
  readers: AssetReaders,
  signal: AbortSignal | undefined,
): Promise<AssetStage> {
  if (args.assets === undefined) {
    return { uploaded: [], prepared: [] };
  }
  const prepared = await preparePrototypeAssets(
    args.assets,
    readers.assetFileReader,
    readers.observationScreenshotReader,
  );
  if ("error" in prepared) {
    return { uploaded: [], prepared: [], failure: { success: false, error: prepared.error } };
  }
  const outcome = await uploadPrototypeAssets(
    prototypeAssetPutClient(target.transport),
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
  target: PrototypeTarget,
  args: z.infer<typeof prototypeSchema>,
  displayId: number | undefined,
): Promise<PrototypeResult> {
  try {
    return await mutate(target, args, displayId);
  } catch (error) {
    logger.warn("[prototype] Request failed", error);
    return { success: false, error: toActionableError(error, "Prototype request failed").message };
  }
}

interface MissingAssetRetry {
  result: PrototypeResult;
  repair: MissingAssetRepair;
}

/**
 * The upload-then-cleared race: the device finished the show but lists assets this same
 * call uploaded as missing. Re-uploads those once and re-sends once. Bounded: never loops, honours
 * the abort signal, and keeps the first (successful) result when the repair cannot complete.
 */
async function retryMissingAssets(
  target: PrototypeTarget,
  args: z.infer<typeof prototypeSchema>,
  stage: AssetStage,
  first: PrototypeResult,
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
  const upload = await uploadPrototypeAssets(prototypeAssetPutClient(target.transport), again, {
    signal,
    action: "resend",
  });
  if (!upload.success) {
    return fail(upload.error ?? "upload failed");
  }
  if (signal?.aborted) {
    return fail("the request was cancelled before the prototype was re-sent");
  }
  // The re-send targets the display the first send resolved, never a re-resolved one.
  const second = await runMutation(target, args, displayId);
  return second.success
    ? { result: second, repair: { kind: "still-missing" } }
    : fail(second.error ?? "re-sending the prototype failed");
}

interface MutationOutcome {
  result: PrototypeResult;
  warning?: string;
}

/**
 * A newer show of the same id on this device started while this one resolved its display or
 * staged assets (#10641). Sending now would put this older spec on screen, possibly on another
 * display, while host status records the newer one, so the older show is never sent.
 */
function supersededBeforeSend(args: { spec?: unknown }): PrototypeResult {
  const id = (args.spec as PrototypeSpec | undefined)?.id;
  return {
    success: false,
    error: `Prototype ${id ?? ""} was not sent: a newer show of the same id on this device started first and is the one on screen.`,
  };
}

/** A re-send after a newer same-id show landed would replace it with this older spec. */
function needsAssetResend(first: PrototypeResult, superseded: () => boolean): boolean {
  return first.success && (first.missingAssets?.length ?? 0) > 0 && !superseded();
}

async function sendPrototype(
  target: PrototypeTarget,
  args: z.infer<typeof prototypeSchema>,
  stage: AssetStage,
  signal: AbortSignal | undefined,
  displayId: number | undefined,
  hooks: { superseded?: () => boolean; beforeSend?: () => Promise<void> } = {},
): Promise<MutationOutcome> {
  const superseded = hooks.superseded ?? (() => false);
  const { beforeSend } = hooks;
  if (stage.failure) {
    return { result: stage.failure };
  }
  if (superseded()) {
    return { result: supersededBeforeSend(args) };
  }
  await beforeSend?.();
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
  target: PrototypeTarget,
  device: BootedDevice,
  args: z.infer<typeof prototypeSchema>,
  dependencies: Pick<PrototypeToolDependencies, "adbFactory" | "lastRenderedObservation">,
): Promise<{ displayId?: number; failure?: PrototypeResult }> {
  try {
    return { displayId: await showDisplayId(target, device, args, dependencies) };
  } catch (error) {
    logger.warn("[prototype] Request failed", error);
    return {
      failure: {
        success: false,
        error: toActionableError(error, "Prototype request failed").message,
      },
    };
  }
}

/**
 * Display resolution, then the iOS reset refusal, the theme-modes refusal, then the appearance-override refusal, then
 * window-option support, then anchor
 * resolution: any refusal ends the call unsent and leaves the device untouched (the app-layer grant
 * is a device side effect that runs later, in [sendPrototype]). An in-place show stays on [show.shownDisplayId], so anchors are checked against that.
 */
async function preflightMutation(
  show: { inPlace: boolean; shownDisplayId?: number },
  target: PrototypeTarget,
  device: BootedDevice,
  args: z.infer<typeof prototypeSchema>,
  dependencies: Pick<
    PrototypeToolDependencies,
    "adbFactory" | "lastRenderedObservation" | "anchorHierarchyCaptureFactory"
  >,
  signal: AbortSignal | undefined,
): Promise<AnchorStage & { displayId?: number }> {
  const resolved = await resolveMutationDisplay(show.inPlace, target, device, args, dependencies);
  if (resolved.failure) {
    return resolved;
  }
  const failure =
    iosResetRefusal(target, args) ??
    (await themeModesRefusal(target, args, signal)) ??
    (await appearanceRefusal(target, args, signal)) ??
    (await windowOptionsRefusal(target, args, signal));
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
  events: PrototypeEventCoordinator,
  scope: PrototypeScope,
  target: { id?: string; all?: true },
  action: PrototypeMutation,
  success: boolean,
  previouslyShown: boolean,
): void {
  if ((action === "dismiss" && success) || (action === "show" && !success && !previouslyShown)) {
    events.dismiss(scope.deviceId, target.id);
  }
}

/**
 * A fresh show starts its event epoch before dispatch. An in-place show waits until the
 * replacement lands: a failed one leaves the old prototype on screen, so its buffered events and
 * sequence high-water mark must survive.
 */
function startFreshShowEvents(
  events: PrototypeEventCoordinator,
  scope: PrototypeScope,
  source: PrototypeEventSource,
  show: { target: { id?: string }; args: { action: PrototypeMutation }; inPlace: boolean },
): void {
  if (show.args.action === "show" && !show.inPlace) {
    events.show(scope, show.target.id!, source);
  }
}

function settleShowEvents(
  events: PrototypeEventCoordinator,
  scope: PrototypeScope,
  source: PrototypeEventSource,
  outcome: { target: { id?: string }; inPlace: boolean; success: boolean },
): void {
  if (outcome.inPlace && outcome.success) {
    events.show(scope, outcome.target.id!, source);
  }
}

function prototypeDeviceUnboundSource(): object | undefined {
  const state = DaemonState.getInstance();
  return state.isInitialized() ? state.getSessionManager() : undefined;
}

function subscribePrototypeDeviceUnbound(
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

type PrototypeHandlerDependencies = {
  store: PrototypeStatusStore;
  events: PrototypeEventCoordinator;
  target: PrototypeTarget;
  assetReaders: AssetReaders;
  commits: PrototypeCommitGenerations;
  cacheInvalidator: DeviceWindowCacheInvalidator;
  now: () => number;
} & Pick<
  PrototypeToolDependencies,
  "adbFactory" | "lastRenderedObservation" | "anchorHierarchyCaptureFactory"
>;
type PrototypeOutput = z.infer<typeof prototypeOutputSchema>;

function mutationTarget(
  args: Omit<z.infer<typeof prototypeSchema>, "action"> & { action: PrototypeMutation },
): { id?: string; all?: true } {
  if (args.all) {
    return { all: true as const };
  }
  return { id: args.action === "show" ? (args.spec as PrototypeSpec).id : args.id };
}

function shownOnDevice(
  store: PrototypeStatusStore,
  scope: PrototypeScope,
  target: { id?: string },
): PrototypeLastResult | undefined {
  return target.id ? store.shownOnDevice(scope.deviceId, target.id) : undefined;
}

/** A refused display ends the call before any asset is uploaded. */
async function stageUnlessRefused(
  failure: PrototypeResult | undefined,
  target: PrototypeTarget,
  args: z.infer<typeof prototypeSchema>,
  readers: AssetReaders,
  signal: AbortSignal | undefined,
): Promise<AssetStage> {
  return failure
    ? { uploaded: [], prepared: [], failure }
    : stageAssets(target, args, readers, signal);
}

async function performMutation(
  dependencies: PrototypeHandlerDependencies,
  device: BootedDevice,
  args: Omit<z.infer<typeof prototypeSchema>, "action"> & { action: PrototypeMutation },
  scope: PrototypeScope,
  signal?: AbortSignal,
): Promise<PrototypeOutput> {
  const { store, events, target: prototypeTarget, assetReaders, commits } = dependencies;
  const target = mutationTarget(args);
  const source = prototypeEventSource(prototypeTarget.transport);
  // The device holds one active prototype, so presence is device-wide, not per session.
  const shown = shownOnDevice(store, scope, target);
  const previouslyShown = shown !== undefined;
  const inPlace = args.action === "show" && shown !== undefined && args.reset !== true;
  // An older CtrlProxy re-shows a same-id prototype fresh on the display it is sent, so its pages
  // restart. It still validates before replacing, so a refused show leaves the old prototype and its
  // events exactly as an in-place one does; only the caller needs telling.
  const legacy = await legacyInPlaceWarning(prototypeTarget, target, inPlace);
  const generation = beginShowGeneration(commits, scope, args.action, target);
  // Every display lookup and window-option check happens before staging; nothing is re-resolved
  // after dispatch. A refused show must not reset the event epoch of a prototype still on screen.
  const resolved = await preflightMutation(
    { inPlace, shownDisplayId: shown?.displayId },
    prototypeTarget,
    device,
    args,
    dependencies,
    signal,
  );
  // The device is sent resolved bounds anchors; host status keeps the authored spec's identity.
  const sendArgs = resolved.spec ? { ...args, spec: resolved.spec } : args;
  const comparable = await comparableForMutation(resolved, inPlace, device, args, dependencies);
  // An in-place show names the display it replaces on: if the prototype is dismissed while assets
  // stage, the runner then shows it fresh there instead of on the default display.
  const displayId = inPlace ? shown?.displayId : resolved.displayId;
  const stage = await stageUnlessRefused(
    resolved.failure,
    prototypeTarget,
    sendArgs,
    assetReaders,
    signal,
  );
  const { result, warning } = await sendPrototype(
    prototypeTarget,
    sendArgs,
    stage,
    signal,
    displayId,
    {
      superseded: () => isSuperseded(commits, scope, target, generation),
      beforeSend: async () => {
        await appLayerGrant(prototypeTarget, device, args, dependencies, signal)?.();
        // Last step before dispatch: a refusal, a failed upload, a lost race or a failed grant
        // must leave the event epoch of a prototype still on screen alone (#11394).
        startFreshShowEvents(events, scope, source, { target, args, inPlace });
      },
    },
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
 * A same-id show replaces in place only on a CtrlProxy advertising prototype_show_in_place_v1. An
 * older APK ignores reset and re-shows the prototype fresh on the display it is sent (#10642), so the
 * caller is told its pager pages restarted. iOS's prototype agent always replaces in place.
 */
async function legacyInPlaceWarning(
  target: PrototypeTarget,
  prototype: { id?: string },
  inPlace: boolean,
): Promise<string | undefined> {
  if (
    !inPlace ||
    !target.android ||
    (await target.android.supportsCommand(PROTOTYPE_SHOW_IN_PLACE_CAPABILITY))
  ) {
    return undefined;
  }
  return `the connected CtrlProxy does not advertise ${PROTOTYPE_SHOW_IN_PLACE_CAPABILITY}, so prototype ${prototype.id} was re-shown fresh on its display: pager pages restarted. Update the connected CtrlProxy to keep pages.`;
}

/**
 * A show or dismiss that landed changed the screen, so the observation cached before it is stale:
 * without this, the "Verify with observe" call right after returns the pre-mutation capture.
 * The foreground app is unchanged, so the iOS SDK identity is preserved.
 */
function retireObservation(
  invalidator: DeviceWindowCacheInvalidator,
  device: BootedDevice,
  result: PrototypeResult,
): void {
  if (result.success) {
    invalidator.invalidate(device, true);
  }
}

function beginShowGeneration(
  commits: PrototypeCommitGenerations,
  scope: PrototypeScope,
  action: PrototypeMutation,
  target: { id?: string },
): number | undefined {
  return action === "show" && target.id ? commits.begin(scope.deviceId, target.id) : undefined;
}

function isSuperseded(
  commits: PrototypeCommitGenerations,
  scope: PrototypeScope,
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
  resolved: { displayId?: number; failure?: PrototypeResult },
  inPlace: boolean,
  device: BootedDevice,
  args: z.infer<typeof prototypeSchema>,
  dependencies: Pick<PrototypeToolDependencies, "adbFactory" | "lastRenderedObservation">,
): Promise<number | undefined | null> {
  return resolved.failure
    ? undefined
    : comparableRequestedDisplay(inPlace, resolved.displayId, device, args, dependencies);
}

interface CommitOutcome {
  args: { action: PrototypeMutation };
  target: { id?: string; all?: true };
  result: PrototypeResult;
  placed: { displayId?: number };
}

function commitMutation(
  dependencies: PrototypeHandlerDependencies,
  scope: PrototypeScope,
  source: PrototypeEventSource,
  outcome: CommitOutcome & { inPlace: boolean; previouslyShown: boolean },
): PrototypeLastResult {
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
  dependencies: PrototypeHandlerDependencies,
  outcome: CommitOutcome,
): PrototypeLastResult {
  const { args, target, result, placed } = outcome;
  return {
    ...target,
    lastAction: args.action,
    ...(placed.displayId === undefined ? {} : { displayId: placed.displayId }),
    ...shownAppearance(args.action, result),
    success: result.success,
    ...(result.error ? { error: result.error } : {}),
    ...(result.totalTimeMs === undefined ? {} : { totalTimeMs: result.totalTimeMs }),
    timestamp: dependencies.now(),
  };
}

/**
 * A same-id show without reset replaces the prototype in place on the display it is already on, so
 * the requested or pinned display is irrelevant: resolving it could only fail the call.
 */
async function resolveMutationDisplay(
  inPlace: boolean,
  target: PrototypeTarget,
  device: BootedDevice,
  args: z.infer<typeof prototypeSchema>,
  dependencies: Pick<PrototypeToolDependencies, "adbFactory" | "lastRenderedObservation">,
): Promise<{ displayId?: number; failure?: PrototypeResult }> {
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
  args: z.infer<typeof prototypeSchema>,
  dependencies: Pick<PrototypeToolDependencies, "adbFactory" | "lastRenderedObservation">,
): Promise<number | undefined | null> {
  if (!inPlace) {
    return resolvedDisplayId;
  }
  if (args.display === undefined) {
    return undefined;
  }
  try {
    const id = await resolvePrototypeDisplayId(device, args.display, {
      adb: (dependencies.adbFactory ?? defaultAdbClientFactory).create(device),
      lastRenderedObservation: dependencies.lastRenderedObservation,
    });
    return id || undefined;
  } catch (error) {
    // The selector is irrelevant to an in-place show, so an unresolvable one only changes the warning.
    logger.debug(`[prototype] ignored display selector did not resolve: ${errorMessage(error)}`);
    return null;
  }
}

/**
 * The display an accepted mutation leaves the prototype on. A same-id show without reset is replaced
 * in place on the device, on the display it is already on, so a different requested display is
 * ignored and the caller is told so.
 */
function placedDisplay(
  args: Pick<z.infer<typeof prototypeSchema>, "action" | "reset" | "display">,
  shown: PrototypeLastResult | undefined,
  displayId: number | undefined | null,
  success: boolean,
): { displayId?: number; warning?: string } {
  if (args.action !== "show" || shown?.id === undefined) {
    return { displayId: displayId ?? undefined };
  }
  // A refused show, reset or not, leaves the prototype on the display it was already on.
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
    warning: `display was ignored: prototype ${shown.id} is already shown on ${where}, and a show with the same id replaces it in place there. Pass reset: true to show it fresh on the requested display.`,
  };
}

/** Element anchors as resolved, also reported when the show then failed, so the caller can re-anchor. */
function anchorsOutput(
  stage: AnchorStage,
): Pick<PrototypeOutput, "anchors" | "hierarchyUpdatedAt"> {
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
  result: PrototypeResult,
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

const devicePrototypeEntrySchema = z.object({
  id: z.string().min(1),
  persistent: z.boolean(),
  state: stateInput,
  pages: z.record(z.string(), z.number().int().nonnegative()).default({}),
  lastSequence: z.number().int().nonnegative(),
  suspended: z.boolean().optional(),
  // Absent from a device without prototype_appearance_v1; a malformed one is dropped, not guessed.
  appearance: z.unknown().optional().transform(parsePrototypeAppearance),
});

function parseReportedPrototypes(
  prototypes: readonly unknown[] | undefined,
): PrototypeStatusEntry[] {
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
  // The device holds one prototype for every session, so stale ids are enumerated device-wide: a
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
  scope: PrototypeScope,
  prototypes: readonly unknown[] | undefined,
  replayed: readonly PrototypeEvent[],
): void {
  const reported = parseReportedPrototypes(prototypes);
  const reportedIds = new Set(reported.map((entry) => entry.id));
  const history = groupByPrototype(replayed);
  for (const [id, grouped] of history) {
    // A prototype that ended while no host was connected is not reported, but its terminal event
    // still belongs to whoever awaits it.
    if (reportedIds.has(id) || grouped.some((event) => event.kind === "dismissed")) {
      const entry = reported.find((known) => known.id === id);
      events.adopt(scope, id, source, grouped, entry?.lastSequence ?? 0);
    }
  }
  dropUnreportedPrototypes(store, events, scope, reportedIds);
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
  timeoutMs: number | undefined,
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
    if (!(await client.supportsCommand(PROTOTYPE_PERSISTENCE_REPLAY_CAPABILITY))) {
      return {
        success: false,
        error: new ActionableError(prototypeInspectUnsupportedMessage()).message,
      };
    }
    result = await client.inspect(timeoutMs);
  } catch (error) {
    logger.warn("[prototype] Inspect request failed", error);
    return { success: false, error: toActionableError(error, "Prototype inspect failed").message };
  } finally {
    stopCapture();
  }
  if (!result.success) {
    return { success: false, error: result.error ?? "Prototype inspect failed" };
  }
  adoptReportedPrototypes(
    store,
    events,
    prototypeEventSource(target.transport),
    scope,
    result.prototypes,
    replayed,
  );
  return {
    success: true,
    ...statusOutput(store, events, scope),
    deviceDroppedEvents: result.droppedEvents ?? 0,
  };
}

const iosAgentStatusSchema = z.object({
  shown: z.boolean(),
  id: z.string().min(1).nullable(),
  pages: z.record(z.string(), z.number().int().nonnegative()).default({}),
  state: stateInput,
  lastSequence: z.number().int().nonnegative(),
  // Flat on the status (the agent holds one prototype); absent when nothing is shown and from an
  // agent without prototype_appearance_v1.
  appearance: z.unknown().optional().transform(parsePrototypeAppearance),
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
  const { shown, id, pages, state, lastSequence, appearance } = status.data;
  const reported =
    shown && id !== null ? [{ id, persistent: false, state, pages, lastSequence, appearance }] : [];
  adoptReportedPrototypes(
    store,
    events,
    prototypeEventSource(target.transport),
    scope,
    reported,
    [],
  );
  return { success: true, ...statusOutput(store, events, scope) };
}

function statusOutput(
  store: PrototypeStatusStore,
  events: PrototypeEventCoordinator,
  scope: PrototypeScope,
): Pick<PrototypeOutput, "prototypes" | "lastResult"> {
  const status = store.status(scope);
  return {
    ...status,
    prototypes: status.prototypes.map((entry) => {
      const counts = entry.id ? events.counts(scope, entry.id) : undefined;
      return counts?.lastSequence === undefined ? entry : { ...entry, ...counts };
    }),
  };
}

/** A timed-out wait on a prototype the device last reported hidden explains why nothing came. */
function suspendedWaitWarning(
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
async function waitForPrototypeEvent(
  events: PrototypeEventCoordinator,
  scope: PrototypeScope,
  source: PrototypeEventSource,
  query: Pick<
    z.infer<typeof prototypeSchema>,
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
  notifyPrototypeWaitProgress(context.progress, false);
  try {
    return await waiting;
  } finally {
    notifyPrototypeWaitProgress(context.progress, true);
  }
}

/**
 * Inputs only CtrlProxy can honour, refused before any device request. iOS simulators run the
 * injected prototype agent: no display.
 */
function prototypePlatformError(
  device: BootedDevice,
  args: z.infer<typeof prototypeSchema>,
): ActionableError | undefined {
  if (device.platform === "android") {
    return undefined;
  }
  if (device.platform !== "ios") {
    return new ActionableError(
      "Prototypes need an Android device or an iOS simulator. Target one with deviceId or sessionUuid.",
    );
  }
  if (args.display !== undefined) {
    return new ActionableError("display is Android only; omit display on iOS.");
  }
  if (args.spec !== undefined) {
    const options = requestedPrototypeWindowOptions(args.spec as PrototypeSpec);
    // window.layer "app" is accepted and ignored on iOS, silently (owner decision 2026-10-09): the
    // agent's window level is fixed, so one spec runs on both platforms.
    if (options.devicePersistence) {
      return new ActionableError('window.persistence "device" is Android only; omit it on iOS.');
    }
  }
  return undefined;
}

function defaultPrototypeLifecycle(): PrototypeEventLifecycle {
  return {
    subscribeSessionRelease: (listener) =>
      SessionReleaseBroadcaster.subscribe((sessionUuid, _reason, snapshot, extras) =>
        // An upgrade-only re-announcement's device may belong to its next owner by now (#11206):
        // clear the released session's own state only.
        listener(sessionUuid, extras?.upgradeOnly ? undefined : snapshot?.deviceId),
      ),
    subscribeDeviceRemoval: (listener) =>
      getDaemonStreamDeviceLifecycleEmitter().onDeviceRemoved(listener),
    subscribeDeviceUnbound: subscribePrototypeDeviceUnbound,
    deviceUnboundSource: prototypeDeviceUnboundSource,
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
function subscribePrototypeCleanup(
  lifecycle: PrototypeEventLifecycle,
  events: PrototypeEventCoordinator,
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
interface PrototypeTransportCache {
  android: WeakMap<PrototypeClient, AndroidPrototypeTransport>;
  ios: WeakMap<PrototypeAgentClient, IosPrototypeTransport>;
}

/**
 * One transport per underlying client keeps the coordinator's per-device event subscription
 * stable across calls and across MCP connections, exactly as when it subscribed to the client.
 */
function prototypeTargets(
  clientFactory: (device: BootedDevice) => PrototypeClient,
  agentConnections: PrototypeAgentConnections,
  transports: PrototypeTransportCache,
): {
  androidTarget: (device: BootedDevice) => PrototypeTarget;
  iosTarget: (device: BootedDevice) => PrototypeTarget | undefined;
} {
  const androidTarget = (device: BootedDevice): PrototypeTarget => {
    const client = clientFactory(device);
    let transport = transports.android.get(client);
    if (transport === undefined) {
      transport = new AndroidPrototypeTransport(client);
      transports.android.set(client, transport);
    }
    return { transport, android: transport };
  };
  const iosTarget = (device: BootedDevice): PrototypeTarget | undefined => {
    const agent = agentConnections.get(device.deviceId);
    if (agent === undefined) {
      return undefined;
    }
    let transport = transports.ios.get(agent);
    if (transport === undefined) {
      transport = new IosPrototypeTransport(agent);
      transports.ios.set(agent, transport);
    }
    return { transport, ios: transport };
  };
  return { androidTarget, iosTarget };
}

function prototypeClock(dependencies: PrototypeToolDependencies): Pick<Timer, "now"> {
  return dependencies.clock ?? dependencies.timer ?? defaultTimer;
}

/**
 * Host-side prototype state: status, event buffers, commit generations and transports. The daemon
 * re-registers the tool for every MCP connection, so this state must outlive any one handler.
 */
interface PrototypeHost {
  store: PrototypeStatusStore;
  events: PrototypeEventCoordinator;
  commits: PrototypeCommitGenerations;
  transports: PrototypeTransportCache;
  /** Subscribes any lifecycle hook that was not yet available; a no-op once all are active. */
  ensureLifecycle(): void;
  dispose(): void;
}

function createPrototypeHost(dependencies: PrototypeToolDependencies): PrototypeHost {
  const store =
    dependencies.store ?? new InMemoryPrototypeStatusStore(prototypeClock(dependencies));
  const events = new PrototypeEventCoordinator(
    dependencies.timer ?? defaultTimer,
    store,
    TelemetryRecorder.getInstance(),
  );
  const cleanup = subscribePrototypeCleanup(
    dependencies.lifecycle ?? defaultPrototypeLifecycle(),
    events,
  );
  let disposed = false;
  return {
    store,
    events,
    commits: new PrototypeCommitGenerations(),
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
let daemonPrototypeHost: PrototypeHost | undefined;
let activeRegistration: { host: PrototypeHost; dispose: () => void } | undefined;

/**
 * Injecting any piece of host state (store, clock, timer, lifecycle) asks for a private host owned
 * by that registration; otherwise every registration shares the daemon host, so a second MCP
 * connection keeps the first one's status and pending events (keyed by session and device).
 */
function prototypeHostFor(dependencies: PrototypeToolDependencies): PrototypeHost {
  const { store, clock, timer, lifecycle } = dependencies;
  if (store || clock || timer || lifecycle) {
    return createPrototypeHost(dependencies);
  }
  daemonPrototypeHost ??= createPrototypeHost(dependencies);
  return daemonPrototypeHost;
}

/**
 * A private host is disposed with its registration. The shared host is disposed only by the
 * registration currently installed: an older connection's disposer must not wipe it.
 */
function prototypeRegistrationDisposer(host: PrototypeHost): () => void {
  const dispose = () => {
    const active = activeRegistration?.dispose === dispose;
    if (active) {
      activeRegistration = undefined;
    }
    if (host !== daemonPrototypeHost) {
      host.dispose();
    } else if (active) {
      host.dispose();
      daemonPrototypeHost = undefined;
    }
  };
  return dispose;
}

/** Parses the caller's arguments after the daemon's internal routing fields are removed. */
function parsePrototypeInput(input: unknown) {
  const external: Record<string, unknown> =
    input && typeof input === "object" && !Array.isArray(input) ? { ...input } : {};
  deleteInternalToolParams(external);
  return prototypeSchema.safeParse(external);
}

/**
 * A show with `specPath` becomes a show with the file's spec, validated like an inline one, before
 * anything else looks at the arguments; the path goes no further than this function.
 */
async function withSpecFromPath(
  args: z.infer<typeof prototypeSchema>,
  reader: PrototypeAssetFileReader,
): Promise<{ args: z.infer<typeof prototypeSchema> } | { error: string }> {
  if (args.action !== "show" || args.specPath === undefined) {
    return { args };
  }
  const { specPath, ...rest } = args;
  const read = await readPrototypeSpecFile(specPath, reader);
  if ("error" in read) {
    return read;
  }
  const problem = specProblem(read.json);
  if (problem) {
    return { error: `specPath ${specPath}: ${problem.path}: ${problem.text}` };
  }
  return { args: { ...rest, spec: read.json } };
}

export function registerPrototypeTools(dependencies: PrototypeToolDependencies = {}): () => void {
  const host = prototypeHostFor(dependencies);
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
  const agentConnections = dependencies.agentConnections ?? noPrototypeAgentConnections;
  const { androidTarget, iosTarget } = prototypeTargets(
    clientFactory,
    agentConnections,
    host.transports,
  );
  const cacheInvalidator =
    dependencies.cacheInvalidator ?? new DefaultDeviceWindowCacheInvalidator();
  const clock = prototypeClock(dependencies);
  const assetReaders: AssetReaders = {
    assetFileReader: dependencies.assetFileReader ?? nodePrototypeAssetFileReader,
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
    const parsed = parsePrototypeInput(input);
    if (!parsed.success) {
      return responseFor({
        success: false,
        error: `Invalid prototype input: ${parsed.error.message}`,
      });
    }
    // Only a specPath show awaits here: other calls keep their timing against FakeTimer.
    const loaded =
      parsed.data.action === "show" && parsed.data.specPath !== undefined
        ? await withSpecFromPath(parsed.data, assetReaders.assetFileReader)
        : { args: parsed.data };
    if ("error" in loaded) {
      return responseFor({ success: false, error: loaded.error });
    }
    // Components are expanded on the host (#11053): everything past validation sees plain nodes.
    const args =
      loaded.args.spec === undefined
        ? loaded.args
        : { ...loaded.args, spec: prototypeSpecForDevice(loaded.args.spec) };
    const platformError = prototypePlatformError(device, args);
    if (platformError) {
      return responseFor({ success: false, error: platformError.message });
    }
    const scope = prototypeScope(device, args);
    if (args.action === "status") {
      return responseFor({ success: true, ...statusOutput(store, events, scope) });
    }
    const target = device.platform === "android" ? androidTarget(device) : iosTarget(device);
    if (!target) {
      const error = new ActionableError(prototypeAgentNotConnectedMessage(device.deviceId));
      return responseFor({ success: false, error: error.message });
    }
    if (args.action === "inspect") {
      return responseFor(await inspectDevice({ store, events }, target, scope, args.timeoutMs));
    }
    if (args.action === "awaitEvent") {
      const source = prototypeEventSource(target.transport);
      const waited = await waitForPrototypeEvent(events, scope, source, args, { progress, signal });
      return responseFor({
        success: true,
        ...waited,
        ...suspendedWaitWarning(store, scope, args.id, waited),
      });
    }
    const handlerDependencies: PrototypeHandlerDependencies = {
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
    'Show (always a full spec, inline as spec or from a local JSON file as specPath), dismiss (id or all:true), status (host-local, no device request), inspect (asks the device which prototypes it is showing and adopts them into status and awaitEvent; use it after a session release or reconnect), or awaitEvent for a prototype id on Android, or on an iOS simulator through the prototype agent that launchApp with prototype:true injects (show, dismiss, status, inspect, awaitEvent; sizes are points). A show with the id of the prototype already on screen replaces it in place: it keeps the display and each pager\'s page (clamped), while the new spec\'s state is authoritative (values the user changed by tapping are not carried over unless the spec includes them); reset:true starts fresh instead. To present alternatives, show one design, describe it and the others in chat (what each is, what changed, which you recommend), and show the next on request; or show one spec whose pager holds every design with a visible label per page. Ask the user in chat which they prefer; never wait on the device for a choice. awaitEvent returns one buffered event, supports eventName/kind and afterSequence, and times out successfully (timedOut:true); default 30000 ms, maximum 60000 ms. Buffer: 64 events per session/device/id; overflow drops oldest and reports droppedCount. Lower-or-equal sequences are ignored, including late arrivals and reconnect replays. Nodes: box/row/column, text/image/icon/spacer/textField, Material switch/checkbox/button/radioGroup/listItem/slider/chip/card/iconButton/fab/segmentedButton/topAppBar/divider/badge/progress/dialog/snackbar/timePicker/datePicker bound to state keys, scroll/pager/tabBar/bottomNav/bottomSheet; actions: emit/setPage/setState/toggle/increment/decrement/dismiss. Reuse: a top-level components:{name:{root}} map placed with {type:"use",component,props} nodes, expanded on the host with {props.<field>} bound like repeat placeholders. Sizes and anchors use dp (points on iOS). A node\'s anchor {type:"element",selector:{elementId,text,testTag,container},alignment:cover|top|bottom|start|end,offset?} is resolved once at show against the app (the prototype excluded) and converted to dp with the display density (iOS bounds are already points); a missing, ambiguous or off-screen element fails the show, and the result reports anchors and hierarchyUpdatedAt (show again to re-anchor). {type:"bounds",bounds:{x,y,width,height}} is screen dp (screen points on iOS). Window placement: fullscreen/sheet/floating, window.opacity: 0-100 (default 100). Example: {action:"show",spec:{id:"demo",window:{placement:{type:"fullscreen"},opacity:80},root:{type:"text",text:"Hello"}}}. show also accepts assets:[{id,path}] (absolute local PNG/JPEG/WebP file path, or a TTF/OTF font file referenced from style.fontFamily as {asset}) or [{id,observation}] (an observation screenshot URI) uploaded before the prototype is sent; image nodes reference the id. If the device reports supplied assets missing, they are re-uploaded and the prototype re-sent once; missingAssets and warning report what is still missing. Verify with observe; no screenshot is returned. On Android a session prototype is tied to the app it was shown over: while another app is in front it is hidden (state kept, no dismissed event, not in observe, layer "prototype" calls fail saying so) and it returns with the app; a device-persistent prototype is not tied to an app. Status makes no device request, marks a prototype suspended:true once an inspect finds it hidden that way (an awaitEvent that then times out warns), and includes pendingCount/lastSequence/droppedCount after events arrive. Device dismissed events remove shown status; the terminal event remains available until consumed or explicit show/dismiss. Awaiting consumes events; unmatched events remain buffered. Optional MCP progress reports wait start/finish without delaying the wait. Session release, device removal and unbinding clear buffers. A disconnect alone is not observed. window.layer: system (default, above system UI) or app (above apps only, so the shade, keyboard and screenshot preview draw over it; the daemon grants CtrlProxy SYSTEM_ALERT_WINDOW with appops first). window.persistence: session (default) or device: the prototype stays interactive after USB/adb disconnect and session end with no idle timeout, keeps its assets, and carries a visible Close control; remove it with that control, dismiss, or a new show. Both are Android only and need a CtrlProxy advertising prototype_window_options_v1. A device-persistent prototype keeps emitting taps, page changes and text input while no host is connected: the device buffers the last 200 events (oldest dropped, counted) and delivers them when a host connects or on inspect, with sequences continuing and no rewind; inspect returns deviceDroppedEvents. inspect needs a CtrlProxy advertising prototype_persistence_replay_v1 and is refused otherwise. On an iOS simulator inspect asks the agent (prototype_inspect_v1) for the one prototype it shows, with no suspended and no deviceDroppedEvents, and is refused with a relaunch hint on an older agent. Light and dark: show takes appearance device (default), light or dark, which pins what the system setting means for that show without changing the device; it replaces the system setting only (mode order: explicit theme.mode, then the flat theme.colors.background/surface luminance, then an opaque authored background, then appearance, else the device), and light or dark is refused unless the device advertises prototype_appearance_v1. Such a device reports appearance {mode, source, deviceDark} in lastResult after a show and per prototype in status and inspect, and sends one appearance_changed event (awaitEvent kind; payload {mode, source}) on any change of the resolved mode while shown (the device flipping, or prototype state changing an inferred mode), never for the show itself. In a scrim slot only the scrim role gets alpha (0.4); other roles are drawn unchanged. Per-mode {light, dark} forms need prototype_theme_modes_v1. Read the MCP resource automobile:prototype for the authoring guide (repeat grammar, limits, theme roles); look up icon names with automobile:prototype/icons?query=<word>.',
    prototypeSchema,
    handler,
    {
      defaultEnabled: false,
      outputSchema: prototypeOutputSchema,
      deviceReadOnly: isPrototypeReadAction,
    },
  );
  const dispose = prototypeRegistrationDisposer(host);
  activeRegistration = { host, dispose };
  return dispose;
}

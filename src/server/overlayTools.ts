import { z } from "zod/v4";
import { z as specZ, type ZodTypeAny } from "zod";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
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
import { SessionReleaseBroadcaster } from "./sessionReleaseBroadcast";
import { getDaemonStreamDeviceLifecycleEmitter } from "../daemon/streamDeviceLifecycleEvents";

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
      action: z.enum(["show", "update", "dismiss", "status"]),
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
        .describe("Overlay id for update or dismiss; must equal spec.id on update"),
      state: stateInput
        .optional()
        .describe("Flat state patch for update; use either spec or state"),
      all: z.literal(true).optional().describe("Dismiss all overlays on the targeted device"),
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
).superRefine((value, ctx) => {
  const fields = ["spec", "id", "state", "all", "display"] as const;
  const allowed: Record<typeof value.action, readonly string[]> = {
    show: ["spec", "display"],
    update: ["id", "spec", "state"],
    dismiss: ["id", "all"],
    status: [],
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
export const overlayOutputSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  overlays: z.array(lastResultSchema).optional(),
  lastResult: lastResultSchema.optional(),
});

type OverlayClient = Pick<
  AndroidCtrlProxyClient,
  "requestShowOverlay" | "requestUpdateOverlay" | "requestDismissOverlay" | "supportsCommand"
>;
interface OverlayToolDependencies {
  clientFactory?: (device: BootedDevice) => OverlayClient;
  adbFactory?: AdbClientFactory;
  lastRenderedObservation?: OverlayDisplayDependencies["lastRenderedObservation"];
  store?: OverlayStatusStore;
  clock?: Pick<Timer, "now">;
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
  // Id 0 is the default display; it needs neither the wire field nor the capability.
  if (displayId && !(await client.supportsCommand(OVERLAY_DISPLAY_CAPABILITY))) {
    throw new ActionableError(overlayDisplayUnsupportedMessage(displayId));
  }
  return displayId;
}

export function registerOverlayTools(dependencies: OverlayToolDependencies = {}): () => void {
  // Registry replacement makes the previous handler/store obsolete.
  unsubscribeOverlayLifecycle?.();
  const store = dependencies.store ?? new InMemoryOverlayStatusStore(dependencies.clock);
  const clientFactory =
    dependencies.clientFactory ??
    ((device: BootedDevice) => AndroidCtrlProxyClient.getInstance(device));
  const handler = async (device: BootedDevice, input: unknown) => {
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
      return responseFor({ success: true, ...store.status(scope) });
    }
    const target = args.all
      ? { all: true as const }
      : { id: args.action === "show" ? (args.spec as OverlaySpec).id : args.id };
    let result: OverlayResult;
    let displayId: number | undefined;
    try {
      const client = clientFactory(device);
      displayId = await showDisplayId(client, device, args, dependencies);
      result = await mutate(client, args, displayId);
    } catch (error) {
      logger.warn("[overlay] Request failed", error);
      result = {
        success: false,
        error: toActionableError(error, "Overlay request failed").message,
      };
    }
    const lastResult = store.record(scope, args.action, target, result, displayId);
    return responseFor({
      success: result.success,
      ...(result.error ? { error: result.error } : {}),
      lastResult,
    });
  };
  ToolRegistry.registerDeviceAware(
    "overlay",
    'Show, update (spec or flat state), dismiss (id or all:true), or inspect host-local overlay status on Android. Nodes: box/row/column, text/image/icon/spacer/textField, scroll/pager/tabBar/bottomNav/bottomSheet; actions: emit/setPage/setState/dismiss. Sizes and anchors use dp; window placement: fullscreen/sheet/floating, window.opacity: 0-100 (default 100). Example: {action:"show",spec:{id:"demo",window:{placement:{type:"fullscreen"},opacity:80},root:{type:"text",text:"Hello"}}}. Verify with observe; no screenshot is returned. Status reflects host requests only, not device events.',
    overlaySchema,
    handler,
    { defaultEnabled: false, outputSchema: overlayOutputSchema },
  );
  const unsubscribeSession = SessionReleaseBroadcaster.subscribe(
    (sessionUuid, _reason, snapshot) => {
      store.clearSession(sessionUuid);
      if (snapshot) {
        store.clearDevice(snapshot.deviceId);
      }
    },
  );
  const unsubscribeDevice = getDaemonStreamDeviceLifecycleEmitter().onDeviceRemoved((deviceId) => {
    store.clearDevice(deviceId);
  });
  const unsubscribe = () => {
    unsubscribeSession();
    unsubscribeDevice();
    if (unsubscribeOverlayLifecycle === unsubscribe) {
      unsubscribeOverlayLifecycle = undefined;
    }
  };
  unsubscribeOverlayLifecycle = unsubscribe;
  return unsubscribe;
}

import { PLAN_RELEVANT } from "./toolRegistryTypes";
import { z } from "zod/v4";
import { ToolRegistry, ProgressCallback } from "./toolRegistry";
import { SetUIState, type LiveDeadlineSubscriber } from "../features/action/SetUIState";
import { BootedDevice } from "../models";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { addDeviceTargetingToSchema } from "../utils/schemaHelpers";
import {
  elementIdTextFieldsSchema,
  validateElementIdTextSelector,
} from "../models/elementSelectorSchemas";
import { INTERNAL_LIVE_DEADLINE_KEY_PARAM } from "../daemon/wire/constants";
import { resolveTransportDeadlineMs } from "./transportDeadline";
import { getLiveDeadlineMs, subscribeLiveDeadline } from "../daemon/liveDeadlineRegistry";

/**
 * Schema for a single field specification
 */
const fieldSpecSchema = z
  .object({
    selector: elementIdTextFieldsSchema
      .superRefine((value, ctx) => {
        validateElementIdTextSelector(
          value,
          ctx,
          "Provide exactly one of elementId or text in selector",
        );
      })
      .describe("Field selector"),
    value: z.string().optional().describe("Text/dropdown value"),
    selected: z.boolean().optional().describe("Checkbox/toggle state"),
  })
  .refine((data) => data.value !== undefined || data.selected !== undefined, {
    message: "Provide either value (for text/dropdown) or selected (for checkbox/toggle)",
  });

/**
 * Schema for setUIState tool input
 */
export const setUIStateSchema = z
  .object({
    fields: z
      .array(fieldSpecSchema)
      .min(1, "At least one field is required")
      .describe("Fields to set"),
    scrollDirection: z.enum(["up", "down"]).optional().describe("Initial search scroll direction"),
  })
  .strict();

/**
 * Output schema for field result
 */
const fieldResultSchema = z.object({
  selector: z.object({
    text: z.string().optional(),
    elementId: z.string().optional(),
  }),
  success: z.boolean(),
  attempts: z.number(),
  verified: z.boolean().optional(),
  error: z.string().optional(),
  fieldType: z.enum(["text", "checkbox", "toggle", "dropdown", "unknown"]).optional(),
  skipped: z.boolean().optional(),
  notAttempted: z.boolean().optional(),
  timedOut: z.boolean().optional(),
});

/**
 * Output schema for setUIState result
 */
const setUIStateResultSchema = z.object({
  success: z.boolean().describe("All fields set"),
  fields: z.array(fieldResultSchema).describe("Field results"),
  totalAttempts: z.number().describe("Total attempts"),
  warnings: z.array(z.string()).optional().describe("Field operation warnings"),
  error: z.string().optional().describe("Error message"),
});

export type SetUIStateArgs = z.infer<typeof setUIStateSchema>;

// Narrow executor interface for per-handler dependency injection.
export type SetUIStateLike = Pick<SetUIState, "execute">;

function createDefaultSetUIState(device: BootedDevice): SetUIStateLike {
  const adb = device.platform === "android" ? defaultAdbClientFactory.create(device) : null;
  return new SetUIState(device, adb);
}

export { resolveTransportDeadlineMs };

export interface FormToolDependencies {
  setUIStateFactory?: (device: BootedDevice) => SetUIStateLike;
}

/**
 * Resolve a getter for the LIVE (possibly progress-extended) transport
 * deadline, when the daemon registered one for this exact request (issue
 * #6222 P1 reopen). `__mcpLiveDeadlineKey` is only ever present on a
 * daemon-forwarded, progress-capable call (see `INTERNAL_LIVE_DEADLINE_KEY_PARAM`
 * and `liveDeadlineRegistry`) -- absent, this returns `undefined` and
 * `SetUIState.execute()` falls back to the frozen `transportDeadlineMs`
 * snapshot from {@link resolveTransportDeadlineMs}.
 */
function resolveLiveDeadlineKey(args: unknown): string | undefined {
  if (!args || typeof args !== "object") {
    return undefined;
  }
  const key = (args as Record<string, unknown>)[INTERNAL_LIVE_DEADLINE_KEY_PARAM];
  if (typeof key !== "string" || key.length === 0) {
    return undefined;
  }
  return key;
}

export function resolveLiveTransportDeadlineGetter(
  args: unknown,
): (() => number | undefined) | undefined {
  const key = resolveLiveDeadlineKey(args);
  return key === undefined ? undefined : () => getLiveDeadlineMs(key);
}

/**
 * Resolve a subscription to extensions of that same live deadline, so
 * `SetUIState` re-arms an in-flight race the moment the daemon applies an
 * extension rather than only when a later progress tick re-reads it (issue
 * #6283). `undefined` whenever {@link resolveLiveTransportDeadlineGetter} is.
 */
export function resolveLiveTransportDeadlineSubscriber(
  args: unknown,
): LiveDeadlineSubscriber | undefined {
  const key = resolveLiveDeadlineKey(args);
  return key === undefined ? undefined : (listener) => subscribeLiveDeadline(key, listener);
}

export function createSetUIStateHandler({
  setUIStateFactory = createDefaultSetUIState,
}: FormToolDependencies = {}) {
  return async (
    device: BootedDevice,
    args: SetUIStateArgs,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    const setUIState = setUIStateFactory(device);
    const transportDeadlineMs = resolveTransportDeadlineMs(args);
    const getLiveTransportDeadlineMs = resolveLiveTransportDeadlineGetter(args);
    const subscribeLiveTransportDeadline = resolveLiveTransportDeadlineSubscriber(args);

    const result = await setUIState.execute(
      {
        fields: args.fields.map((f) => ({
          selector: {
            text: f.selector.text,
            elementId: f.selector.elementId,
          },
          value: f.value,
          selected: f.selected,
        })),
        scrollDirection: args.scrollDirection,
      },
      progress,
      signal,
      { transportDeadlineMs, getLiveTransportDeadlineMs, subscribeLiveTransportDeadline },
    );

    const response = createStructuredToolResponse({
      success: result.success,
      fields: result.fields.map((f) => ({
        selector: f.selector,
        success: f.success,
        attempts: f.attempts,
        verified: f.verified,
        error: f.error,
        fieldType: f.fieldType,
        skipped: f.skipped,
        notAttempted: f.notAttempted,
        timedOut: f.timedOut,
      })),
      totalAttempts: result.totalAttempts,
      error: result.error,
      ...(result.warnings?.length ? { warnings: result.warnings } : {}),
    });
    // Genuine partial success (some fields set, others failed) keeps
    // isError:false — the per-field `fields` array is the actionable status
    // (#6237). But when EVERY field failed, the primary operation did not
    // succeed at all and must be reported as such (#6200, #6251).
    const allFieldsFailed = result.fields.length > 0 && result.fields.every((f) => !f.success);
    return allFieldsFailed ? { ...response, isError: true as const } : response;
  };
}

/**
 * Register form-related tools with the tool registry
 */
export function registerFormTools(deps: FormToolDependencies = {}): void {
  // setUIState tool
  ToolRegistry.registerDeviceAware(
    "setUIState",
    "Set multiple form fields by desired state.",
    addDeviceTargetingToSchema(setUIStateSchema),
    {
      handler: createSetUIStateHandler(deps),
      ...PLAN_RELEVANT,
      defaultEnabled: true,
      supportsProgress: true,
      debugOnly: true,
      outputSchema: setUIStateResultSchema,
      planExecutable: true,
    },
  );
}

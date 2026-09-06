import { z } from "zod/v4";
import { ToolRegistry, ProgressCallback } from "./toolRegistry";
import { SetUIState } from "../features/action/SetUIState";
import { BootedDevice } from "../models";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { addDeviceTargetingToSchema } from "./toolSchemaHelpers";
import { elementIdTextFieldsSchema, validateElementIdTextSelector } from "./elementSelectorSchemas";
import {
  INTERNAL_MCP_REQUEST_TIMEOUT_PARAM,
  INTERNAL_EXECUTION_START_TIME_PARAM,
  INTERNAL_LIVE_DEADLINE_KEY_PARAM,
} from "../daemon/constants";
import { getLiveDeadlineMs } from "../daemon/liveDeadlineRegistry";

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
const setUIStateSchema = z.object({
  fields: z
    .array(fieldSpecSchema)
    .min(1, "At least one field is required")
    .describe("Fields to set"),
  scrollDirection: z.enum(["up", "down"]).optional().describe("Initial search scroll direction"),
});

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
  error: z.string().optional().describe("Error message"),
});

export type SetUIStateArgs = z.infer<typeof setUIStateSchema>;

// Injection seam for the setUIState handler (mirrors the tapAny factory seam
// in interactionTools.ts). Lets a unit test exercise the registered handler
// wiring with a fake SetUIState whose execute() returns a chosen
// success/partial/failure result, instead of spying on the class prototype
// (#6251 review — a prototype spy is a process-global patch that can leak
// into unrelated tests running in the same process).
export type SetUIStateLike = Pick<SetUIState, "execute">;

function createDefaultSetUIState(device: BootedDevice): SetUIStateLike {
  const adb = device.platform === "android" ? defaultAdbClientFactory.create(device) : null;
  return new SetUIState(device, adb);
}

let setUIStateFactory: (device: BootedDevice) => SetUIStateLike = createDefaultSetUIState;

export function setSetUIStateFactory(factory: (device: BootedDevice) => SetUIStateLike): void {
  setUIStateFactory = factory;
}

export function resetSetUIStateFactory(): void {
  setUIStateFactory = createDefaultSetUIState;
}

/**
 * Recover the ABSOLUTE deadline of the current MCP request from the internal
 * params the server attaches to every daemon-forwarded call (issue #6222
 * P1). `__mcpRequestTimeoutMs` is the transport budget still remaining when
 * the request reached this process -- time already spent in the daemon's
 * per-session queue is already deducted (see `resolveMcpRequestTimeoutMs`
 * and `ProgressExtendableDeadline` in `src/daemon/mcpRequestTimeout.ts`).
 * `__executionStartTime` is this execution's own start time on the SAME
 * `defaultTimer` clock `SetUIState` uses. Their sum is the absolute
 * wall-clock deadline `SetUIState.execute()` must return before. Neither
 * field is present on a direct, non-daemon call, in which case there is no
 * transport deadline to bound against and `SetUIState` falls back to its own
 * conservative internal budget.
 */
function resolveTransportDeadlineMs(args: unknown): number | undefined {
  if (!args || typeof args !== "object") {
    return undefined;
  }
  const record = args as Record<string, unknown>;
  const remainingMs = record[INTERNAL_MCP_REQUEST_TIMEOUT_PARAM];
  const startTimeMs = record[INTERNAL_EXECUTION_START_TIME_PARAM];
  if (
    typeof remainingMs !== "number" ||
    !Number.isFinite(remainingMs) ||
    remainingMs <= 0 ||
    typeof startTimeMs !== "number" ||
    !Number.isFinite(startTimeMs)
  ) {
    return undefined;
  }
  return startTimeMs + remainingMs;
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
function resolveLiveTransportDeadlineGetter(args: unknown): (() => number | undefined) | undefined {
  if (!args || typeof args !== "object") {
    return undefined;
  }
  const key = (args as Record<string, unknown>)[INTERNAL_LIVE_DEADLINE_KEY_PARAM];
  if (typeof key !== "string" || key.length === 0) {
    return undefined;
  }
  return () => getLiveDeadlineMs(key);
}

export const setUIStateHandler = async (
  device: BootedDevice,
  args: SetUIStateArgs,
  progress?: ProgressCallback,
  signal?: AbortSignal,
) => {
  const setUIState = setUIStateFactory(device);
  const transportDeadlineMs = resolveTransportDeadlineMs(args);
  const getLiveTransportDeadlineMs = resolveLiveTransportDeadlineGetter(args);

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
    transportDeadlineMs,
    getLiveTransportDeadlineMs,
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
  });
  // Genuine partial success (some fields set, others failed) keeps
  // isError:false — the per-field `fields` array is the actionable status
  // (#6237). But when EVERY field failed, the primary operation did not
  // succeed at all and must be reported as such (#6200, #6251).
  const allFieldsFailed = result.fields.length > 0 && result.fields.every((f) => !f.success);
  return allFieldsFailed ? { ...response, isError: true as const } : response;
};

/**
 * Register form-related tools with the tool registry
 */
export function registerFormTools(): void {
  // setUIState tool
  ToolRegistry.registerDeviceAware(
    "setUIState",
    "Set multiple form fields by desired state.",
    addDeviceTargetingToSchema(setUIStateSchema),
    setUIStateHandler,
    {
      defaultEnabled: true,
      supportsProgress: true,
      debugOnly: true,
      outputSchema: setUIStateResultSchema,
      planExecutable: true,
    },
  );
}

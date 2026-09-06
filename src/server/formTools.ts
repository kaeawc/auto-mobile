import { z } from "zod/v4";
import { ToolRegistry, ProgressCallback } from "./toolRegistry";
import { SetUIState } from "../features/action/SetUIState";
import { BootedDevice } from "../models";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { addDeviceTargetingToSchema } from "./toolSchemaHelpers";
import { elementIdTextFieldsSchema, validateElementIdTextSelector } from "./elementSelectorSchemas";

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

export const setUIStateHandler = async (
  device: BootedDevice,
  args: SetUIStateArgs,
  progress?: ProgressCallback,
  signal?: AbortSignal,
) => {
  const setUIState = setUIStateFactory(device);

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

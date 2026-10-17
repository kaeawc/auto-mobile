import { z } from "zod/v4";
import { ActionableError } from "../models";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { defineDeviceTool } from "./defineTool";
import { SetAccessibilityFocus } from "../features/accessibility/SetAccessibilityFocus";
import { accessibilityFocusResultSchema } from "./toolOutputSchemas";

// `defineDeviceTool` applies `.strict()` (#6712) and device targeting, and infers the
// handler's args from this schema.
const accessibilityFocusInput = z.object({
  action: z.enum(["set", "clear"]).optional().describe("set default or clear TalkBack focus"),
  resourceId: z.string().optional().describe("Target resource ID"),
  text: z.string().optional().describe("Target text"),
  contentDesc: z
    .string()
    .optional()
    .describe("Exact content-desc or accessible label; distinct from visible text"),
});

// Debug-only pending audit: this explicit cursor setter is not a typical UI
// navigation/interaction tool because a human cannot directly command TalkBack
// to focus an arbitrary node. Re-evaluate whether it should be removed, kept as
// an internal debug primitive, or implemented through human-representative
// TalkBack navigation gestures instead.
const accessibilityFocusTool = defineDeviceTool({
  name: "accessibilityFocus",
  description: "Set or clear Android TalkBack focus by resourceId, text, or contentDesc.",
  input: accessibilityFocusInput,
  handler: async (device, args) => {
    if (device.platform !== "android") {
      throw new ActionableError(
        "accessibilityFocus is only supported on Android (TalkBack). iOS VoiceOver focus is not yet implemented.",
      );
    }

    const feature = new SetAccessibilityFocus(device);
    const result = await feature.execute({
      action: args.action,
      resourceId: args.resourceId,
      text: args.text,
      contentDesc: args.contentDesc,
    });

    if (!result.success) {
      throw new ActionableError(result.error ?? "Failed to update accessibility focus");
    }

    return createStructuredToolResponse({
      success: true,
      focusedElement: result.focusedElement,
      confirmed: result.confirmed,
      warning: result.warning,
      ...(result.alreadySatisfied ? { alreadySatisfied: true } : {}),
    });
  },
  options: {
    defaultEnabled: false,
    debugOnly: true,
    outputSchema: accessibilityFocusResultSchema,
  },
});

export const accessibilityFocusSchema = accessibilityFocusTool.schema;

export function registerAccessibilityFocusTools() {
  accessibilityFocusTool.register();
}

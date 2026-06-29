import { z } from "zod";
import { ToolRegistry } from "./toolRegistry";
import type { ProgressCallback } from "./toolRegistry";
import { ActionableError, BootedDevice } from "../models";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { addDeviceTargetingToSchema } from "./toolSchemaHelpers";
import { SetAccessibilityFocus } from "../features/accessibility/SetAccessibilityFocus";
import { accessibilityFocusResultSchema } from "./toolOutputSchemas";

export const accessibilityFocusSchema = addDeviceTargetingToSchema(
  z.object({
    action: z
      .enum(["set", "clear"])
      .optional()
      .describe("Set (default) or clear the accessibility (TalkBack) focus cursor"),
    resourceId: z
      .string()
      .optional()
      .describe("Resource ID of the target element, e.g. com.example:id/title"),
    text: z
      .string()
      .optional()
      .describe("Text of the target element (resolved to a resource-id via the element finder)"),
    contentDesc: z
      .string()
      .optional()
      .describe("Content description of the target element (resolved to a resource-id)")
  })
);

interface AccessibilityFocusArgs {
  action?: "set" | "clear";
  resourceId?: string;
  text?: string;
  contentDesc?: string;
}

export function registerAccessibilityFocusTools() {
  const handler = async (
    device: BootedDevice,
    args: AccessibilityFocusArgs,
    _progress?: ProgressCallback
  ) => {
    if (device.platform !== "android") {
      throw new ActionableError(
        "accessibilityFocus is only supported on Android (TalkBack). iOS VoiceOver focus is not yet implemented."
      );
    }

    const feature = new SetAccessibilityFocus(device);
    const result = await feature.execute({
      action: args.action,
      resourceId: args.resourceId,
      text: args.text,
      contentDesc: args.contentDesc
    });

    if (!result.success) {
      throw new ActionableError(result.error ?? "Failed to update accessibility focus");
    }

    return createStructuredToolResponse({
      success: true,
      focusedElement: result.focusedElement,
      warning: result.warning
    });
  };

  ToolRegistry.registerDeviceAware(
    "accessibilityFocus",
    "Set or clear the Android TalkBack accessibility-focus cursor on a target element (Android only). " +
      "Provide one selector: resourceId, text, or contentDesc. action defaults to 'set'; pass 'clear' to clear the cursor.",
    accessibilityFocusSchema,
    handler,
    false,
    false,
    { outputSchema: accessibilityFocusResultSchema }
  );
}

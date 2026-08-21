import { z } from "zod/v4";
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
      .describe("set default or clear TalkBack focus"),
    resourceId: z
      .string()
      .optional()
      .describe("Target resource ID"),
    text: z
      .string()
      .optional()
      .describe("Target text"),
    contentDesc: z
      .string()
      .optional()
      .describe("Target content-desc")
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
      confirmed: result.confirmed,
      warning: result.warning
    });
  };

  // Debug-only pending audit: this explicit cursor setter is not a typical UI
  // navigation/interaction tool because a human cannot directly command TalkBack
  // to focus an arbitrary node. Re-evaluate whether it should be removed, kept as
  // an internal debug primitive, or implemented through human-representative
  // TalkBack navigation gestures instead.
  ToolRegistry.registerDeviceAware("accessibilityFocus", "Set or clear Android TalkBack focus by resourceId, text, or contentDesc.", accessibilityFocusSchema, handler, { debugOnly: true, outputSchema: accessibilityFocusResultSchema });
}

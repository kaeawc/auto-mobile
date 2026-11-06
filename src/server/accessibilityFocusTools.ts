import { z } from "zod/v4";
import { ActionableError, type BootedDevice } from "../models";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { defineDeviceTool } from "./defineTool";
import {
  SetAccessibilityFocus,
  type IosAccessibilityFocusService,
} from "../features/accessibility/SetAccessibilityFocus";
import { accessibilityFocusResultSchema } from "./toolOutputSchemas";
import { accessibilityActionTool } from "./accessibilityActionTool";

// `defineDeviceTool` applies `.strict()` (#6712) and device targeting, and infers the
// handler's args from this schema.
const accessibilityFocusInput = z.object({
  action: z
    .enum(["set", "clear"])
    .optional()
    .describe("set default or clear accessibility focus (clear is Android-only)"),
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
export function createAccessibilityFocusTool(
  iosServiceFactory?: (device: BootedDevice) => IosAccessibilityFocusService,
) {
  return defineDeviceTool({
    name: "accessibilityFocus",
    description:
      "Set accessibility focus on Android (TalkBack) and iOS (VoiceOver) by resourceId, text, or contentDesc. Clearing focus is supported on Android only.",
    input: accessibilityFocusInput,
    handler: async (device, args) => {
      const feature = new SetAccessibilityFocus(
        device,
        iosServiceFactory ? { iosServiceFactory } : {},
      );
      const result = await feature.execute({
        action: args.action,
        resourceId: args.resourceId,
        text: args.text,
        contentDesc: args.contentDesc,
      });

      if (!result.success) {
        throw new ActionableError(
          result.error ??
            (device.platform === "ios"
              ? "Failed to set VoiceOver focus"
              : "Failed to update accessibility focus"),
        );
      }

      if (device.platform === "ios") {
        return createStructuredToolResponse({
          success: true,
          confirmed: result.confirmed,
          warning: result.warning,
        });
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
}

export const accessibilityFocusSchema = createAccessibilityFocusTool().schema;

export interface AccessibilityFocusToolDependencies {
  iosServiceFactory?: ((device: BootedDevice) => IosAccessibilityFocusService) | undefined;
}

export function registerAccessibilityFocusTools(deps: AccessibilityFocusToolDependencies = {}) {
  createAccessibilityFocusTool(deps.iosServiceFactory).register();
  // Semantic and custom accessibility actions (#14077) share the focus tool's target resolution.
  accessibilityActionTool.register();
}

import { z } from "zod/v4";
import { defineDeviceTool } from "./defineTool";
import { PLAN_RELEVANT } from "./toolRegistryTypes";
import { createStructuredToolResponse, withIsErrorOnFailure } from "../utils/toolUtils";
import {
  ACCESSIBILITY_ACTIONS,
  PerformAccessibilityAction,
} from "../features/accessibility/PerformAccessibilityAction";

const accessibilityActionInput = z.object({
  action: z
    .enum(ACCESSIBILITY_ACTIONS)
    .describe(
      "Accessibility action. page_* needs API 29+, press_and_hold API 30+; set_progress takes " +
        "progress; custom runs the app-defined action labeled customAction",
    ),
  resourceId: z.string().optional().describe("Target resource ID"),
  text: z.string().optional().describe("Target text"),
  contentDesc: z
    .string()
    .optional()
    .describe("Exact content-desc or accessible label; distinct from visible text"),
  customAction: z
    .string()
    .min(1)
    .optional()
    .describe("Label of the app-defined action, for action custom"),
  progress: z
    .number()
    .refine(Number.isFinite, "progress must be finite")
    .optional()
    .describe("Value in the control's own range, for action set_progress"),
});

export const accessibilityActionResultSchema = z
  .object({
    success: z.boolean(),
    action: z.string(),
    resourceId: z.string(),
    error: z.string().optional(),
  })
  .passthrough();

export const accessibilityActionTool = defineDeviceTool({
  name: "accessibilityAction",
  description:
    "Perform an Android accessibility action on an element, the way TalkBack or Switch Access does: expand, collapse, dismiss, select, clear_selection, show_on_screen, scroll in a direction, page (API 29+), press_and_hold (API 30+), set_progress on a slider, or custom to run an app-defined action (e.g. a Compose customActions label) by its label. Target the element by resourceId, text or contentDesc; it needs a unique resource-id. An action the element does not offer is refused, and the error lists the actions it does offer (custom ones as custom:<label>).",
  input: accessibilityActionInput,
  handler: async (device, args, _progress, signal) => {
    const result = await new PerformAccessibilityAction(device).execute({
      action: args.action,
      ...(args.resourceId !== undefined ? { resourceId: args.resourceId } : {}),
      ...(args.text !== undefined ? { text: args.text } : {}),
      ...(args.contentDesc !== undefined ? { contentDesc: args.contentDesc } : {}),
      ...(args.customAction !== undefined ? { customAction: args.customAction } : {}),
      ...(args.progress !== undefined ? { progress: args.progress } : {}),
      ...(signal ? { signal } : {}),
    });
    return withIsErrorOnFailure(createStructuredToolResponse(result), result.success);
  },
  options: {
    ...PLAN_RELEVANT,
    defaultEnabled: false,
    outputSchema: accessibilityActionResultSchema,
  },
});

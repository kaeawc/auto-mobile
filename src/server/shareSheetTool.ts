import { z } from "zod/v4";
import { ShareSheet, type IosShareSheetClientFactory } from "../features/shareSheet/ShareSheet";
import { SHARE_SHEET_KINDS } from "../features/shareSheet/ShareTarget";
import { toActionableError } from "../models";
import { platformSchema } from "../utils/schemaHelpers";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { unsupportedPlatformToolMessage } from "./applePlatformToolSupport";
import { defineDeviceTool } from "./defineTool";
import { ToolRegistry } from "./toolRegistry";
import { PLAN_RELEVANT } from "./toolRegistryTypes";

const shareTargetSchema = z.object({
  label: z.string(),
  appId: z.string().optional(),
  kind: z.enum(["app", "direct", "action"]),
});

export const shareSheetTool = defineDeviceTool({
  name: "shareSheet",
  description:
    "List visible targets, select a target, or dismiss the share sheet after the app opens it. The iOS activity view controller reports sheetKind ios-activity-view-controller and requires an exact label for select. Android select requires an exact label or verified appId.",
  input: z.object({
    platform: z
      .enum(platformSchema.options, {
        error: ({ input }) =>
          input === "watchos" ? unsupportedPlatformToolMessage("shareSheet", input) : undefined,
      })
      .optional(),
    action: z.enum(["list", "select", "dismiss"]),
    label: z.string().trim().min(1).optional().describe("Exact target label for select"),
    appId: z.string().trim().min(1).optional().describe("Verified Android package for select"),
  }),
  options: {
    defaultEnabled: true,
    ...PLAN_RELEVANT,
    deviceReadOnly: (args) => args.action === "list",
    deviceReadOnlyArgs: [{ argument: "action", values: ["list"] }],
    outputSchema: z.object({
      success: z.literal(true),
      action: z.enum(["list", "select", "dismiss"]),
      sheetKind: z.enum(SHARE_SHEET_KINDS),
      targets: z.array(shareTargetSchema).optional(),
      selected: shareTargetSchema.optional(),
    }),
  },
});

export function registerShareSheetTool(iosClientFactory?: IosShareSheetClientFactory): void {
  shareSheetTool.register(ToolRegistry, async (device, args, _progress, signal) => {
    try {
      const shareSheet = new ShareSheet(device, undefined, iosClientFactory);
      return createStructuredToolResponse(await shareSheet.execute(args, signal));
    } catch (error) {
      throw toActionableError(error, `Failed to ${args.action} on the share sheet`);
    }
  });
}

import { z } from "zod/v4";
import { defineDeviceTool } from "./defineTool";
import { createStructuredToolResponse, withIsErrorOnFailure } from "../utils/toolUtils";
import {
  NativeAccessibilityAudit,
  type NativeAccessibilityAuditInput,
} from "../features/accessibility/NativeAccessibilityAudit";
import { IOS_ACCESSIBILITY_AUDIT_CHECKS } from "../features/observe/ios/CtrlProxyAccessibilityAudit";
import { MAX_ACCESSIBILITY_VIOLATIONS } from "../features/accessibility/WcagAudit";

const accessibilityAuditInput = z.object({
  appId: z
    .string()
    .min(1)
    .optional()
    .describe("Bundle id of the app to audit (default: the foreground app)"),
  checks: z
    .array(z.enum([...IOS_ACCESSIBILITY_AUDIT_CHECKS, "all"]))
    .optional()
    .describe("Checks to run (default: all)"),
  maxIssues: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe(
      `Most issues to return (default ${MAX_ACCESSIBILITY_VIOLATIONS}); truncated reports a clip`,
    ),
});

const boundsOutputSchema = z.object({
  left: z.number(),
  top: z.number(),
  right: z.number(),
  bottom: z.number(),
});

export const accessibilityAuditResultSchema = z
  .object({
    success: z.boolean(),
    engine: z.enum(["xcuitest", "atf"]),
    issues: z.array(
      z
        .object({
          check: z.string(),
          summary: z.string(),
          detail: z.string().optional(),
          elementId: z.string().optional(),
          label: z.string().optional(),
          bounds: boundsOutputSchema.optional(),
        })
        .passthrough(),
    ),
    totalIssues: z.number(),
    truncated: z.boolean(),
    unsupportedChecks: z.array(z.string()),
    errorCode: z.enum(["unsupported_capability", "unsupported_platform"]).optional(),
    error: z.string().optional(),
  })
  .passthrough();

export function createAccessibilityAuditTool(
  audit: NativeAccessibilityAudit = new NativeAccessibilityAudit(),
) {
  return defineDeviceTool({
    name: "accessibilityAudit",
    description:
      "Run the platform's own accessibility audit engine on the current screen. iOS (iOS 17+, Simulator and physical) runs XCUITest performAccessibilityAudit and reports contrast, hitRegion, dynamicType, textClipped, sufficientDescription, trait and elementDetection issues, each with the element's accessibility identifier as elementId (usable with tapOn/highlight) and bounds. Unlike the host-side WCAG audit, the platform engine sees real hit regions, Dynamic Type support and clipped text. Android (Accessibility Test Framework) is not available yet and returns errorCode unsupported_platform; a runner that predates this command returns errorCode unsupported_capability.",
    input: accessibilityAuditInput,
    handler: async (device, args, _progress, signal) => {
      const input: NativeAccessibilityAuditInput = {
        ...(args.appId ? { appId: args.appId } : {}),
        ...(args.checks ? { checks: args.checks } : {}),
        ...(args.maxIssues !== undefined ? { maxIssues: args.maxIssues } : {}),
        ...(signal ? { signal } : {}),
      };
      const result = await audit.run(device, input);
      return withIsErrorOnFailure(createStructuredToolResponse(result), result.success);
    },
    options: {
      defaultEnabled: false,
      outputSchema: accessibilityAuditResultSchema,
    },
  });
}

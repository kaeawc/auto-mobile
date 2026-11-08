import { z } from "zod/v4";
import { defineDeviceTool } from "./defineTool";
import { createStructuredToolResponse, withIsErrorOnFailure } from "../utils/toolUtils";
import {
  NativeAccessibilityAudit,
  type NativeAccessibilityAuditInput,
} from "../features/accessibility/NativeAccessibilityAudit";
import { IOS_ACCESSIBILITY_AUDIT_CHECKS } from "../features/observe/ios/CtrlProxyAccessibilityAudit";
import { MAX_ACCESSIBILITY_VIOLATIONS } from "../features/accessibility/WcagAudit";
import { PLAN_RELEVANT } from "./toolRegistryTypes";
import type { BootedDevice } from "../models";
import type { OnDemandAuditEngines } from "../features/audit/OnDemandAudit";
import { createDefaultOnDemandAuditEngines } from "../features/audit/DefaultOnDemandAuditEngines";
import {
  runWcagAccessibilityAudit,
  type WcagAccessibilityAuditInput,
} from "../features/audit/WcagAccessibilityAudit";
import {
  auditBaselineInput,
  auditFailOnInput,
  auditScopeInput,
  baselineDiffOutputSchema,
  violationOutputSchema,
} from "./auditToolSchemas";

export const ACCESSIBILITY_AUDIT_ENGINES = ["platform", "wcag"] as const;
export type AccessibilityAuditEngine = (typeof ACCESSIBILITY_AUDIT_ENGINES)[number];

/** One call works on both platforms: Android runs the WCAG checks, iOS the XCUITest engine. */
export function defaultAccessibilityAuditEngine(device: BootedDevice): AccessibilityAuditEngine {
  return device.platform === "android" ? "wcag" : "platform";
}

const PLATFORM_ONLY_ARGS = ["checks", "maxIssues"] as const;
const WCAG_ONLY_ARGS = ["scope", "baseline", "failOn"] as const;

const accessibilityAuditInput = z.object({
  engine: z
    .enum(ACCESSIBILITY_AUDIT_ENGINES)
    .optional()
    .describe(
      "platform (XCUITest) or wcag (host-side checks); default wcag on Android, platform on iOS",
    ),
  appId: z
    .string()
    .min(1)
    .optional()
    .describe("Package or bundle id of the app to audit (default: the foreground app)"),
  checks: z
    .array(z.enum([...IOS_ACCESSIBILITY_AUDIT_CHECKS, "all"]))
    .optional()
    .describe("platform engine: checks to run (default: all)"),
  maxIssues: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe(
      `platform engine: most issues to return (default ${MAX_ACCESSIBILITY_VIOLATIONS}); truncated reports a clip`,
    ),
  scope: auditScopeInput.describe("wcag engine: limit the audit to one container's subtree"),
  baseline: auditBaselineInput.describe("wcag engine: named accessibility baseline"),
  failOn: auditFailOnInput.describe(
    "wcag engine: fail the call at this violation severity (default never: report only)",
  ),
});

type AccessibilityAuditArgs = z.infer<typeof accessibilityAuditInput>;

const boundsOutputSchema = z.object({
  left: z.number(),
  top: z.number(),
  right: z.number(),
  bottom: z.number(),
});

export const accessibilityAuditResultSchema = z
  .object({
    success: z.boolean(),
    engine: z.enum(["xcuitest", "atf", "wcag"]),
    failed: z.boolean().optional(),
    appId: z.string().optional(),
    issues: z
      .array(
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
      )
      .optional(),
    totalIssues: z.number().optional(),
    unsupportedChecks: z.array(z.string()).optional(),
    violations: z.array(violationOutputSchema).optional(),
    totalViolations: z.number().optional(),
    summary: z.object({}).passthrough().optional(),
    screenId: z.string().optional(),
    baselineDiff: baselineDiffOutputSchema.optional(),
    baselineRecorded: z.string().optional(),
    truncated: z.boolean().optional(),
    errorCode: z.enum(["unsupported_capability", "unsupported_platform"]).optional(),
    error: z.string().optional(),
  })
  .passthrough();

/** The arguments of the other engine present in a call, which this engine cannot honour. */
function foreignArgs(engine: AccessibilityAuditEngine, args: AccessibilityAuditArgs): string[] {
  const foreign = engine === "wcag" ? PLATFORM_ONLY_ARGS : WCAG_ONLY_ARGS;
  return foreign.filter((name) => args[name] !== undefined);
}

function wcagInput(
  args: AccessibilityAuditArgs,
  signal: AbortSignal | undefined,
): WcagAccessibilityAuditInput {
  return {
    ...(signal ? { signal } : {}),
    ...(args.appId ? { appId: args.appId } : {}),
    ...(args.scope?.container ? { container: args.scope.container } : {}),
    ...(args.baseline ? { baseline: args.baseline } : {}),
    ...(args.failOn ? { failOn: args.failOn } : {}),
  };
}

function platformInput(
  args: AccessibilityAuditArgs,
  signal: AbortSignal | undefined,
): NativeAccessibilityAuditInput {
  return {
    ...(args.appId ? { appId: args.appId } : {}),
    ...(args.checks ? { checks: args.checks } : {}),
    ...(args.maxIssues !== undefined ? { maxIssues: args.maxIssues } : {}),
    ...(signal ? { signal } : {}),
  };
}

function engineName(engine: AccessibilityAuditEngine, device: BootedDevice) {
  if (engine === "wcag") {
    return "wcag" as const;
  }
  return device.platform === "ios" ? ("xcuitest" as const) : ("atf" as const);
}

export function createAccessibilityAuditTool(
  audit: NativeAccessibilityAudit = new NativeAccessibilityAudit(),
  enginesFor: (device: BootedDevice) => OnDemandAuditEngines = createDefaultOnDemandAuditEngines,
) {
  return defineDeviceTool({
    name: "accessibilityAudit",
    description:
      "Audit the accessibility of the current screen. engine wcag (default on Android; Android only) runs the host-side WCAG checks (contrast, touch targets, labels, headings) with every audit feature flag off and reports violations with the element from this observation; an appId that is not in the foreground is an error; scope.container limits it to one element's subtree; baseline record saves the violations under a name and compare reports baselineDiff (new, fixed, unchanged), and only new violations count toward failOn; failOn error|warning makes the call fail when findings reach that severity, for plan assertions (default never). engine platform (default on iOS) runs the platform's own engine: on iOS 17+ (Simulator and physical) XCUITest performAccessibilityAudit reports contrast, hitRegion, dynamicType, textClipped, sufficientDescription, trait and elementDetection issues, each with the element's accessibility identifier as elementId (usable with tapOn/highlight) and bounds; it sees real hit regions, Dynamic Type support and clipped text. On both engines an appId that is not in the foreground (background or not running) is an error naming the foreground app. checks and maxIssues apply to the platform engine, scope, baseline and failOn to wcag; passing one to the other engine is an error. The Android platform engine (Accessibility Test Framework) is not available yet and returns errorCode unsupported_platform, as does wcag on iOS; a runner that predates the iOS command returns errorCode unsupported_capability.",
    input: accessibilityAuditInput,
    handler: async (device, args, _progress, signal) => {
      const engine = args.engine ?? defaultAccessibilityAuditEngine(device);
      const foreign = foreignArgs(engine, args);
      if (foreign.length > 0) {
        const result = {
          success: false,
          engine: engineName(engine, device),
          // A platform result always carries its issue fields, an error included.
          ...(engine === "platform"
            ? { issues: [], totalIssues: 0, truncated: false, unsupportedChecks: [] }
            : { failed: false }),
          error: `${foreign.join(", ")} ${foreign.length === 1 ? "does" : "do"} not apply to engine ${engine}; pass engine ${engine === "wcag" ? "platform" : "wcag"} or drop ${foreign.length === 1 ? "it" : "them"}.`,
        };
        return withIsErrorOnFailure(createStructuredToolResponse(result), false);
      }
      const result =
        engine === "wcag"
          ? await runWcagAccessibilityAudit(device, enginesFor(device), wcagInput(args, signal))
          : await audit.run(device, platformInput(args, signal));
      return withIsErrorOnFailure(createStructuredToolResponse(result), result.success);
    },
    options: {
      ...PLAN_RELEVANT,
      defaultEnabled: false,
      outputSchema: accessibilityAuditResultSchema,
    },
  });
}

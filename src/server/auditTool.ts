import { z } from "zod/v4";
import { defineDeviceTool } from "./defineTool";
import { PLAN_RELEVANT } from "./toolRegistryTypes";
import type { BootedDevice } from "../models";
import { createStructuredToolResponse, withIsErrorOnFailure } from "../utils/toolUtils";
import {
  auditAppIdInput,
  auditBaselineInput,
  auditFailOnInput,
  auditScopeInput,
  baselineDiffOutputSchema,
  passedOutputSchema,
  violationOutputSchema,
} from "./auditToolSchemas";
import {
  AUDIT_KINDS,
  OnDemandAudit,
  type OnDemandAuditEngines,
  type OnDemandAuditInput,
} from "../features/audit/OnDemandAudit";
import { createDefaultOnDemandAuditEngines } from "../features/audit/DefaultOnDemandAuditEngines";

const auditInput = z.object({
  kinds: z
    .array(z.enum(AUDIT_KINDS))
    .min(1)
    .optional()
    .describe("Audits to run (default: accessibility)"),
  appId: auditAppIdInput,
  scope: auditScopeInput,
  baseline: auditBaselineInput,
  failOn: auditFailOnInput,
});

export const auditResultSchema = z
  .object({
    success: z.boolean(),
    failed: z.boolean(),
    appId: z.string().optional(),
    accessibility: z
      .object({
        violations: z.array(violationOutputSchema),
        totalViolations: z.number(),
        truncated: z.boolean(),
        summary: z.object({}).passthrough(),
        screenId: z.string(),
      })
      .passthrough()
      .optional(),
    performance: passedOutputSchema.optional(),
    memory: passedOutputSchema.optional(),
    baselineDiff: baselineDiffOutputSchema.optional(),
    baselineRecorded: z.string().optional(),
    unsupported: z.record(z.string(), z.string()).optional(),
    error: z.string().optional(),
  })
  .passthrough();

export function createAuditTool(
  enginesFor: (device: BootedDevice) => OnDemandAuditEngines = createDefaultOnDemandAuditEngines,
) {
  return defineDeviceTool({
    name: "audit",
    description:
      "Deprecated: use accessibilityAudit (engine wcag) for accessibility and performanceAudit for performance and memory; this tool returns the same results and will be removed. Audit the current screen on demand, with every audit feature flag off and without changing flag state. kinds: accessibility (WCAG: contrast, touch targets, labels, headings; default), performance (UI jank and touch latency of the foreground app), memory (a memory snapshot of appId). Violations carry the element from this observation; accessibility of an appId that is not in the foreground is an error. scope.container limits the accessibility audit to one element's subtree. baseline record saves the accessibility violations under a name; compare reports baselineDiff (new, fixed, unchanged), and only new violations count toward failOn. failOn error|warning makes the call fail when findings reach that severity, for plan assertions; default never. Android only.",
    input: auditInput,
    handler: async (device, args) => {
      const input: OnDemandAuditInput = {
        ...(args.kinds ? { kinds: args.kinds } : {}),
        ...(args.appId ? { appId: args.appId } : {}),
        ...(args.scope?.container ? { container: args.scope.container } : {}),
        ...(args.baseline ? { baseline: args.baseline } : {}),
        ...(args.failOn ? { failOn: args.failOn } : {}),
      };
      const result = await new OnDemandAudit(device, enginesFor(device)).run(input);
      return withIsErrorOnFailure(createStructuredToolResponse(result), result.success);
    },
    options: {
      ...PLAN_RELEVANT,
      defaultEnabled: false,
      outputSchema: auditResultSchema,
    },
  });
}

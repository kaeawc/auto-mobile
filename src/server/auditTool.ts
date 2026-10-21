import { z } from "zod/v4";
import { defineDeviceTool } from "./defineTool";
import { PLAN_RELEVANT } from "./toolRegistryTypes";
import type { BootedDevice } from "../models";
import { createStructuredToolResponse, withIsErrorOnFailure } from "../utils/toolUtils";
import {
  AUDIT_FAIL_ON,
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
  appId: z.string().min(1).optional().describe("Package to audit (default: the foreground app)"),
  scope: z
    .object({
      container: z
        .object({
          elementId: z.string().min(1).optional().describe("Container resource id"),
          text: z.string().min(1).optional().describe("Container text or content-desc"),
        })
        .refine((value) => value.elementId !== undefined || value.text !== undefined, {
          message: "container needs elementId or text",
        }),
    })
    .optional()
    .describe("Limit the accessibility audit to one container's subtree"),
  baseline: z
    .object({
      name: z.string().min(1).describe("Baseline name"),
      mode: z.enum(["compare", "record"]).describe("record saves; compare reports the diff"),
    })
    .optional()
    .describe("Named accessibility baseline"),
  failOn: z
    .enum(AUDIT_FAIL_ON)
    .optional()
    .describe("Fail the call at this violation severity (default never: report only)"),
});

const violationOutputSchema = z
  .object({ type: z.string(), severity: z.string(), fingerprint: z.string() })
  .passthrough();

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
    performance: z.object({ passed: z.boolean() }).passthrough().optional(),
    memory: z.object({ passed: z.boolean() }).passthrough().optional(),
    baselineDiff: z
      .object({
        new: z.array(violationOutputSchema),
        fixed: z.array(z.string()),
        unchanged: z.number(),
      })
      .optional(),
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
      "Audit the current screen on demand, with every audit feature flag off and without changing flag state. kinds: accessibility (WCAG: contrast, touch targets, labels, headings; default), performance (UI jank and touch latency of the foreground app), memory (a memory snapshot of appId). Violations carry the element from this observation. scope.container limits the accessibility audit to one element's subtree. baseline record saves the accessibility violations under a name; compare reports baselineDiff (new, fixed, unchanged), and only new violations count toward failOn. failOn error|warning makes the call fail when findings reach that severity, for plan assertions; default never. Android only.",
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

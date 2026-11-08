import { z } from "zod/v4";
import { AUDIT_FAIL_ON } from "../features/audit/OnDemandAudit";

/**
 * Input and output pieces shared by `accessibilityAudit` (wcag engine), `performanceAudit` and
 * the deprecated `audit` tool, so the three describe the same arguments the same way (#17279).
 */

export const auditAppIdInput = z
  .string()
  .min(1)
  .optional()
  .describe("Package to audit (default: the foreground app)");

export const auditScopeInput = z
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
  .describe("Limit the accessibility audit to one container's subtree");

export const auditBaselineInput = z
  .object({
    name: z.string().min(1).describe("Baseline name"),
    mode: z.enum(["compare", "record"]).describe("record saves; compare reports the diff"),
  })
  .optional()
  .describe("Named accessibility baseline");

export const auditFailOnInput = z
  .enum(AUDIT_FAIL_ON)
  .optional()
  .describe("Fail the call at this violation severity (default never: report only)");

export const violationOutputSchema = z
  .object({ type: z.string(), severity: z.string(), fingerprint: z.string() })
  .passthrough();

export const baselineDiffOutputSchema = z.object({
  new: z.array(violationOutputSchema),
  fixed: z.array(z.string()),
  unchanged: z.number(),
});

export const passedOutputSchema = z.object({ passed: z.boolean() }).passthrough();

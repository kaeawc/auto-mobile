import { z } from "zod/v4";
import { defineDeviceTool } from "./defineTool";
import { PLAN_RELEVANT } from "./toolRegistryTypes";
import type { BootedDevice } from "../models";
import { createStructuredToolResponse, withIsErrorOnFailure } from "../utils/toolUtils";
import {
  OnDemandAudit,
  PERFORMANCE_AUDIT_KINDS,
  type OnDemandAuditEngines,
} from "../features/audit/OnDemandAudit";
import { createDefaultOnDemandAuditEngines } from "../features/audit/DefaultOnDemandAuditEngines";
import { auditAppIdInput, auditFailOnInput, passedOutputSchema } from "./auditToolSchemas";

const performanceAuditInput = z.object({
  kinds: z
    .array(z.enum(PERFORMANCE_AUDIT_KINDS))
    .min(1)
    .optional()
    .describe("Checks to run (default: performance and memory)"),
  appId: auditAppIdInput,
  failOn: auditFailOnInput.describe(
    "Fail the call when a check does not pass or cannot run: error or warning (default never: report only)",
  ),
});

export const performanceAuditResultSchema = z
  .object({
    success: z.boolean(),
    failed: z.boolean(),
    appId: z.string().optional(),
    performance: passedOutputSchema.optional(),
    memory: passedOutputSchema.optional(),
    unsupported: z.record(z.string(), z.string()).optional(),
    error: z.string().optional(),
  })
  .passthrough();

export function createPerformanceAuditTool(
  enginesFor: (device: BootedDevice) => OnDemandAuditEngines = createDefaultOnDemandAuditEngines,
) {
  return defineDeviceTool({
    name: "performanceAudit",
    description:
      "Pass/fail performance checks of an app on the current screen, against the configured thresholds. kinds: performance (UI jank, frame time and touch latency of the foreground app; appId must be in the foreground) and memory (a memory snapshot of appId); default both. Each reports passed with its metrics and violations. failOn error|warning makes the call fail when a check does not pass or cannot run (performance of an appId not in the foreground is listed under unsupported), for plan assertions; default never. For raw captures use performanceTrace, captureTrace, measureStartup or heapDump. Android only.",
    input: performanceAuditInput,
    handler: async (device, args) => {
      const result = await new OnDemandAudit(device, enginesFor(device)).run({
        kinds: args.kinds ?? PERFORMANCE_AUDIT_KINDS,
        ...(args.appId ? { appId: args.appId } : {}),
        ...(args.failOn ? { failOn: args.failOn } : {}),
      });
      return withIsErrorOnFailure(createStructuredToolResponse(result), result.success);
    },
    options: {
      ...PLAN_RELEVANT,
      defaultEnabled: false,
      outputSchema: performanceAuditResultSchema,
    },
  });
}

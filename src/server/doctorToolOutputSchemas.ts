import { z } from "zod/v4";

const checkResultSchema = z
  .object({
    name: z.string(),
    status: z.enum(["pass", "warn", "fail", "skip"]),
    message: z.string(),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
    detail: z.string().optional(),
    recommendation: z.string().optional(),
  })
  .passthrough();

const checkSectionSchema = z.object({ checks: z.array(checkResultSchema) }).passthrough();

/** Mirrors `DoctorReport` (src/utils/doctorTypes.ts). */
export const doctorReportSchema = z
  .object({
    timestamp: z.string(),
    version: z.string(),
    platform: z.string(),
    arch: z.string(),
    diagnosticProfile: z.string().optional(),
    system: checkSectionSchema,
    android: checkSectionSchema.optional(),
    ios: checkSectionSchema.optional(),
    autoMobile: checkSectionSchema,
    summary: z
      .object({
        total: z.number(),
        passed: z.number(),
        warnings: z.number(),
        failed: z.number(),
        skipped: z.number(),
      })
      .passthrough(),
    recommendations: z.array(z.string()),
  })
  .passthrough();

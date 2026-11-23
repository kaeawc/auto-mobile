import { z } from "zod/v4";

export const prototypeRuntimeKindSchema = z.enum([
  "ctrlproxy",
  "iosAgent",
  "iosViewer",
  "disposableApp",
  "protoviewer",
  "embedded",
]);
export const PROTOTYPE_PLATFORM_MODES = ["real", "fake", "simulated"] as const;
const prototypePlatformModeSchema = z.enum(PROTOTYPE_PLATFORM_MODES);
export const prototypePlatformReasonSchema = z.enum([
  "permission_denied",
  "hardware_unavailable",
  "play_services_missing",
  "simulator",
  "fake_mode",
]);

export const prototypePlatformReportSchema = z.strictObject({
  runtime: prototypeRuntimeKindSchema,
  appState: z.string().optional(),
  modules: z.record(
    z.string(),
    z.strictObject({
      availability: z.enum(["ready", "degraded", "unavailable"]),
      mode: prototypePlatformModeSchema.optional(),
      reason: prototypePlatformReasonSchema.optional(),
      inFlight: z.number().int().nonnegative().optional(),
    }),
  ),
  permissions: z.record(z.string(), z.string()).optional(),
});

export type PrototypeRuntimeKind = z.infer<typeof prototypeRuntimeKindSchema>;
export type PrototypePlatformReport = z.infer<typeof prototypePlatformReportSchema>;

export function parsePrototypePlatformReport(input: unknown): PrototypePlatformReport | undefined {
  const parsed = prototypePlatformReportSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}

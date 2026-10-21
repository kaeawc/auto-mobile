import { z } from "zod";
import type { TimingData, TimingEntry } from "../../models/TimingData";
import type { SessionPreparationTiming } from "./devicePort";

const entry: z.ZodType<TimingEntry> = z.lazy(() =>
  z.object({
    name: z.string(),
    durationMs: z.number().finite().nonnegative(),
    children: data.optional(),
  }),
);
const data: z.ZodType<TimingData> = z.lazy(() =>
  z.union([z.array(entry), z.record(z.string(), entry)]),
);
const lifecycle = z.object({ provision: z.object({ timing: data.nullable().optional() }) });

export function preparationTiming(value: unknown): SessionPreparationTiming | undefined {
  const parsed = lifecycle.safeParse(value);
  if (!parsed.success || !parsed.data.provision.timing) {
    return undefined;
  }
  const phases: SessionPreparationTiming = {};
  const visit = (timing: TimingData) => {
    for (const entry of Object.values(timing)) {
      if (entry.name === "provisionExactDevice") {
        phases.createMs = entry.durationMs;
      }
      if (entry.name === "bootDevice") {
        phases.bootMs = entry.durationMs;
      }
      if (entry.name === "ensureCtrlProxy iOS" || entry.name === "ensureAccessibilityService") {
        phases.automationReadyMs = entry.durationMs;
      }
      if (entry.children) {
        visit(entry.children);
      }
    }
  };
  visit(parsed.data.provision.timing);
  return phases;
}

import { z } from "zod";
import contract from "../../../schemas/prototype-spec-contract.json";
const limits = contract.limits;
const id = z.string().min(1).max(limits.MAX_PROTOTYPE_TIMER_ID_LENGTH);
const delay = z
  .number()
  .int()
  .min(limits.MIN_PROTOTYPE_TIMER_MS)
  .max(limits.MAX_PROTOTYPE_TIMER_MS);
let actions: (() => z.ZodTypeAny) | undefined;
export function bindPrototypeTimerActions(schema: () => z.ZodTypeAny): void {
  actions = schema;
}
export const startTimerActionSchema = z
  .object({
    type: z.enum(["startTimer"]),
    id,
    afterMs: delay,
    everyMs: delay.optional(),
    maxRuns: z.number().int().min(1).max(limits.MAX_PROTOTYPE_TIMER_RUNS).optional(),
    actions: z
      .array(z.lazy((): z.ZodTypeAny => (actions ? actions() : z.never())))
      .min(1)
      .max(32),
  })
  .strict();
export const cancelTimerActionSchema = z.object({ type: z.enum(["cancelTimer"]), id }).strict();
export const prototypeTimerReportsSchema = z
  .array(
    z.object({
      id,
      nextFireInMs: z.number().int().safe().nonnegative(),
      runs: z.number().int().safe().nonnegative(),
    }),
  )
  .max(limits.MAX_PROTOTYPE_TIMERS);
export type PrototypeTimerReport = z.infer<typeof prototypeTimerReportsSchema>[number];
export function parsePrototypeTimerReports(value: unknown): PrototypeTimerReport[] | undefined {
  const parsed = prototypeTimerReportsSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

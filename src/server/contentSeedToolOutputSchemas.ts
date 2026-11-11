import { z } from "zod/v4";
const counts = z
  .object({
    contacts: z.number().int().nonnegative(),
    calendarEvents: z.number().int().nonnegative(),
    callLog: z.number().int().nonnegative(),
    smsInbox: z.number().int().nonnegative(),
  })
  .strict();
export const seedContentResultSchema = z
  .object({ namespace: z.string(), inserted: counts, removed: counts })
  .strict();

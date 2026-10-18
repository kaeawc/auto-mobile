import { z } from "zod/v4";

/** `message` plus the executed `SQLResult` (DatabaseInspector.ts); cells are driver-typed. */
export const sqlQueryResultSchema = z
  .object({
    message: z.string(),
    type: z.enum(["query", "mutation"]),
    columns: z.array(z.string()).optional(),
    rows: z.array(z.array(z.unknown())).optional(),
    rowsAffected: z.number().optional(),
    bigIntegerColumns: z.array(z.number()).optional(),
    diagnostic: z.object({ code: z.string(), message: z.string() }).passthrough().optional(),
    truncated: z.boolean().optional(),
  })
  .passthrough();

import { z } from "zod/v4";

const mappingSchema = z.object({
  devicePort: z.number().int(),
  hostPort: z.number().int().optional(),
  host: z.string(),
  owned: z.boolean(),
  status: z.enum([
    "added",
    "present",
    "restored",
    "missing",
    "removed",
    "gone",
    "foreign",
    "reachable",
    "unreachable",
    "probe_unsupported",
  ]),
  probeReason: z.enum(["closed", "refused", "timeout", "unsupported"]).optional(),
  probeDetail: z.string().optional(),
});

/** Every portReverse outcome; `failed` is returned with `isError`. */
export const portReverseResultSchema = z
  .object({
    message: z.string(),
    success: z.boolean(),
    status: z.enum(["ok", "failed", "not_applicable"]),
    action: z.enum(["ensure", "list", "verify", "remove"]),
    deviceId: z.string(),
    mappings: z.array(mappingSchema).optional(),
    restored: z.array(z.number().int()).optional(),
    restoreFailures: z
      .array(z.object({ devicePort: z.number().int(), error: z.string() }))
      .optional(),
    errorCode: z
      .enum(["port_reverse_conflict", "port_reverse_not_owned", "port_reverse_port_refused"])
      .optional(),
    ports: z.array(z.number().int()).optional(),
  })
  .passthrough();

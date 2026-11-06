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
  hostListening: z.boolean().optional(),
  reclaimed: z.object({ host: z.string(), reason: z.enum(["host_refused"]) }).optional(),
  deviceListener: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("none") }),
      z.object({ kind: z.literal("reverse") }),
      z.object({
        kind: z.literal("process"),
        uid: z.number().int(),
        package: z.string().optional(),
      }),
      z.object({ kind: z.literal("unsupported"), detail: z.string() }),
    ])
    .optional(),
});

const conflictKind = z.enum(["other_session", "external_live", "external_unknown"]);

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
      .enum([
        "port_reverse_conflict",
        "port_reverse_not_owned",
        "port_reverse_port_refused",
        "port_reverse_reclaim_failed",
        "port_reverse_device_port_in_use",
      ])
      .optional(),
    ports: z.array(z.number().int()).optional(),
    conflictKind: conflictKind.optional(),
    conflicts: z
      .array(z.object({ devicePort: z.number().int(), conflictKind: conflictKind.optional() }))
      .optional(),
  })
  .passthrough();

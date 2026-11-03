import { z } from "zod";
import { exceedsPushPayloadLimit } from "../utility/iosPushPayload";
import { prototypeContractPatterns } from "./prototypeContractPatterns";
import { prototypeJsonSchema, type PrototypeJson } from "./prototypeJson";

/**
 * A simulated push: `type` picks the handler, `data` is what `{event: "/data/..."}` reads, and
 * `notification` is posted as a plain alert when no handler exists. Field limits match
 * `notifications.post`.
 */
export interface PrototypePushPayload {
  type: string;
  data: { [key: string]: PrototypeJson };
  notification?: {
    title: string;
    body?: string;
    channel?: string;
    group?: string;
    badge?: number;
  };
}

export type PrototypePushValidation =
  | { success: true; payload: PrototypePushPayload; json: string }
  | { success: false; error: { code: "invalid_args"; path: string; message: string } };

const stateKey = z.string().regex(prototypeContractPatterns.stateKey);

const payloadSchema = z
  .object({
    type: stateKey,
    data: z.record(prototypeJsonSchema).default({}),
    notification: z
      .object({
        title: z
          .string()
          .max(128)
          .refine((value) => value.trim().length > 0, "must not be blank"),
        body: z.string().max(1024).optional(),
        channel: stateKey.optional(),
        group: z.string().max(128).optional(),
        badge: z.number().int().min(0).max(9999).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Validate a host-supplied push payload before it reaches a runtime. Its compact JSON must fit the
 * 4 KiB APNs limit that `postNotification` also enforces, so a push the host accepts can always
 * travel the system path.
 */
export function validatePrototypePushPayload(value: unknown): PrototypePushValidation {
  const parsed = payloadSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    return invalid(["data", ...issue.path].join("."), issue.message);
  }
  const payload = parsed.data as PrototypePushPayload;
  const json = JSON.stringify(payload);
  if (exceedsPushPayloadLimit(json)) {
    return invalid(
      "data",
      `The push payload is ${Buffer.byteLength(json, "utf8")} bytes of compact JSON; the limit is 4096 bytes (the APNs limit). Send less data.`,
    );
  }
  return { success: true, payload, json };
}

function invalid(path: string, message: string): PrototypePushValidation {
  return { success: false, error: { code: "invalid_args", path, message } };
}

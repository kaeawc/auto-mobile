/**
 * Wire messages for host-proxied prototype HTTP requests (`request` action with `via: "host"`,
 * #12527). The device sends `prototype_request` (all bindings already resolved) and the host
 * answers with one `prototype_response` carrying the same `requestId`. Responses never go through
 * `patch`, so they cannot collide with `baseRevision`.
 */
import { z } from "zod";

export const PROTOTYPE_REQUEST_MESSAGE_TYPE = "prototype_request";
export const PROTOTYPE_RESPONSE_MESSAGE_TYPE = "prototype_response";

export const PROTOTYPE_REQUEST_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;
export type PrototypeRequestMethod = (typeof PROTOTYPE_REQUEST_METHODS)[number];

export const PROTOTYPE_REQUEST_ERROR_CODES = [
  "timeout",
  "too_large",
  "connection_refused",
  "cancelled",
  "invalid_url",
  "invalid_request",
  "network",
  "too_many_in_flight",
  // A 2xx body `/data` cannot hold (the JSON `null` body); the devices also raise it themselves.
  "invalid_response",
] as const;
export type PrototypeRequestErrorCode = (typeof PROTOTYPE_REQUEST_ERROR_CODES)[number];

export type PrototypeRequestJson =
  | string
  | number
  | boolean
  | null
  | PrototypeRequestJson[]
  | { [key: string]: PrototypeRequestJson };

const jsonSchema: z.ZodType<PrototypeRequestJson> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonSchema),
    z.record(jsonSchema),
  ]),
);

export const prototypeRequestMessageSchema = z.object({
  type: z.literal(PROTOTYPE_REQUEST_MESSAGE_TYPE),
  requestId: z.string().min(1),
  /** The prototype that issued the request; dismissing it cancels the request. */
  prototypeId: z.string().min(1),
  method: z.enum(PROTOTYPE_REQUEST_METHODS),
  url: z.string(),
  headers: z.record(z.string()).optional(),
  body: jsonSchema.optional(),
  /** Clamped to the maximum timeout; absent means the default. */
  timeoutMs: z.number().int().positive().optional(),
});
export type PrototypeRequestMessage = z.infer<typeof prototypeRequestMessageSchema>;

export const prototypeResponseMessageSchema = z.discriminatedUnion("ok", [
  z.object({
    type: z.literal(PROTOTYPE_RESPONSE_MESSAGE_TYPE),
    requestId: z.string(),
    ok: z.literal(true),
    status: z.number().int(),
    headers: z.record(z.string()),
    /** Parsed JSON, or the raw string when the body is not JSON. Null for an empty body. */
    body: jsonSchema.nullable(),
    durationMs: z.number(),
  }),
  z.object({
    type: z.literal(PROTOTYPE_RESPONSE_MESSAGE_TYPE),
    requestId: z.string(),
    ok: z.literal(false),
    error: z.object({
      code: z.enum(PROTOTYPE_REQUEST_ERROR_CODES),
      message: z.string(),
    }),
    durationMs: z.number(),
  }),
]);
export type PrototypeResponseMessage = z.infer<typeof prototypeResponseMessageSchema>;

import { z } from "zod";
import type { PrototypeEvent } from "../observe/android/ctrlProxyProtocol";
import { PROTOTYPE_REQUEST_EVENT_NAME } from "./prototypeRequest";
import { PROTOTYPE_REQUEST_META_ERROR_CODES } from "./prototypeRequestOutcome";
import { PROTOTYPE_REQUEST_METHODS } from "./prototypeRequestProtocol";

/**
 * A finished `request` (#12523, `prototype_network_v1`) is reported as an `emit` event whose
 * `name` is {@link PROTOTYPE_REQUEST_EVENT_NAME} (authored emits cannot use it) and whose
 * `payload` is this object, so no wire field is added: await it with
 * `awaitEvent {kind: "emit", eventName: "prototype_request"}`. One event per request, sent after
 * the `into`, `__meta` and `statusKey` writes and before `onSuccess` / `onError` run; a request
 * superseded by a newer one to the same `into` reports `error.code` `cancelled`. `state` and
 * `pages` are the usual snapshot.
 */
export interface PrototypeRequestEventPayload {
  /** Unique per request on the device; stable between the request and its response. */
  requestId: string;
  method: (typeof PROTOTYPE_REQUEST_METHODS)[number];
  /** The URL after bindings and `query`, cut to 2048 characters. */
  url: string;
  via: "host" | "device";
  /** The `into` path, bound for repeat rows; absent when the action has none. */
  into?: string;
  outcome: "success" | "error";
  /** The HTTP status; absent when no response arrived. */
  status?: number;
  durationMs: number;
  /** Present for every `error` outcome, including a non-2xx status (`http_error`). */
  error?: { code: (typeof PROTOTYPE_REQUEST_META_ERROR_CODES)[number]; message: string };
}

const payloadSchema = z
  .object({
    requestId: z.string().min(1).max(128),
    method: z.enum(PROTOTYPE_REQUEST_METHODS),
    url: z.string().max(2048),
    via: z.enum(["host", "device"]),
    into: z.string().min(1).optional(),
    outcome: z.enum(["success", "error"]),
    status: z.number().finite().int().min(100).max(599).optional(),
    durationMs: z.number().finite().nonnegative(),
    error: z
      .object({
        code: z.enum(PROTOTYPE_REQUEST_META_ERROR_CODES),
        message: z.string().max(512),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((payload) => (payload.outcome === "error") === (payload.error !== undefined));

/** True for an `emit` event under the reserved request name. */
export function isPrototypeRequestEventName(event: Pick<PrototypeEvent, "kind" | "name">): boolean {
  return event.kind === "emit" && event.name === PROTOTYPE_REQUEST_EVENT_NAME;
}

/** The request an event reports, or undefined for any other event or a malformed payload. */
export function prototypeRequestEventOf(
  event: Pick<PrototypeEvent, "kind" | "name" | "payload">,
): PrototypeRequestEventPayload | undefined {
  if (!isPrototypeRequestEventName(event)) {
    return undefined;
  }
  const payload = payloadSchema.safeParse(event.payload);
  return payload.success ? payload.data : undefined;
}

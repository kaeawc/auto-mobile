import { z } from "zod";
import type { PrototypeEvent } from "../observe/android/ctrlProxyProtocol";
import { prototypeJsonSchema, type PrototypeJson } from "./prototypeJson";
import {
  PROTOTYPE_PLATFORM_DELIVERED_EVENT_NAME,
  PROTOTYPE_PLATFORM_ERROR_CODES,
  PROTOTYPE_PLATFORM_EVENT_NAME,
} from "./prototypePlatform";

/**
 * The platform vocabulary (#14294) reports to the host through `emit` events under two reserved
 * names, so no wire field is added (the same approach as `prototype_request`):
 *
 * - a finished `platform` call is `emit` {@link PROTOTYPE_PLATFORM_EVENT_NAME}, sent after the
 *   `into`, `__meta` and `statusKey` writes and before `onSuccess` / `onError` run;
 * - a delivered platform event is `emit` {@link PROTOTYPE_PLATFORM_DELIVERED_EVENT_NAME}, sent
 *   after its `platform.on` handler ran. `data` fits the 4 KiB emit budget; larger data is cut and
 *   flagged `truncated`.
 *
 * Await them with `awaitEvent {kind: "emit", eventName: "prototype_platform"}` (or
 * `"prototype_platform_event"`). `simulated` marks an outcome or event injected by the host.
 */
export interface PrototypePlatformCallEventPayload {
  /** Unique per call on the device. */
  callId: string;
  /** The `<module>.<op>` call. */
  call: string;
  outcome: "success" | "error";
  durationMs: number;
  /** Clipboard audit metadata contains no clipboard text. */
  op?: "copy" | "paste" | "hasText";
  bytes?: number;
  /** Present for every `error` outcome. */
  error?: { code: (typeof PROTOTYPE_PLATFORM_ERROR_CODES)[number]; message: string };
  simulated?: true;
}

export interface PrototypePlatformDeliveredEventPayload {
  /** The `<module>.<event>` name. */
  event: string;
  data: PrototypeJson;
  truncated?: true;
  simulated?: true;
}

const qualifiedName = z
  .string()
  .max(128)
  .regex(/^[^.]+\.[^.].*$/);

const callPayloadSchema = z
  .object({
    callId: z.string().min(1).max(128),
    call: qualifiedName,
    outcome: z.enum(["success", "error"]),
    durationMs: z.number().finite().nonnegative(),
    op: z.enum(["copy", "paste", "hasText"]).optional(),
    bytes: z.number().int().nonnegative().optional(),
    error: z
      .object({ code: z.enum(PROTOTYPE_PLATFORM_ERROR_CODES), message: z.string().max(512) })
      .strict()
      .optional(),
    simulated: z.literal(true).optional(),
  })
  .strict()
  .refine((payload) => (payload.outcome === "error") === (payload.error !== undefined));

const deliveredPayloadSchema = z
  .object({
    event: qualifiedName,
    data: prototypeJsonSchema,
    truncated: z.literal(true).optional(),
    simulated: z.literal(true).optional(),
  })
  .strict();

type Named = Pick<PrototypeEvent, "kind" | "name">;

/** True for an `emit` event under the reserved platform-call name. */
export function isPrototypePlatformCallEventName(event: Named): boolean {
  return event.kind === "emit" && event.name === PROTOTYPE_PLATFORM_EVENT_NAME;
}

/** True for an `emit` event under the reserved delivered-event name. */
export function isPrototypePlatformDeliveredEventName(event: Named): boolean {
  return event.kind === "emit" && event.name === PROTOTYPE_PLATFORM_DELIVERED_EVENT_NAME;
}

/** The call an event reports, or undefined for any other event or a malformed payload. */
export function prototypePlatformCallEventOf(
  event: Pick<PrototypeEvent, "kind" | "name" | "payload">,
): PrototypePlatformCallEventPayload | undefined {
  if (!isPrototypePlatformCallEventName(event)) {
    return undefined;
  }
  const payload = callPayloadSchema.safeParse(event.payload);
  return payload.success ? payload.data : undefined;
}

/** The platform event an event reports, or undefined for any other event or a malformed payload. */
export function prototypePlatformDeliveredEventOf(
  event: Pick<PrototypeEvent, "kind" | "name" | "payload">,
): PrototypePlatformDeliveredEventPayload | undefined {
  if (!isPrototypePlatformDeliveredEventName(event)) {
    return undefined;
  }
  const payload = deliveredPayloadSchema.safeParse(event.payload);
  return payload.success ? payload.data : undefined;
}

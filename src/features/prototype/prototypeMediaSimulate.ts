import { z } from "zod";
import { toActionableError } from "../../models/ActionableError";
import { logger } from "../../utils/logger";
import {
  PROTOTYPE_MEDIA_ERROR_CODES,
  PROTOTYPE_MEDIA_ERROR_STATUS,
  PROTOTYPE_MEDIA_SIM_EVENTS,
  PROTOTYPE_MEDIA_SIM_STATUSES,
  type PrototypeFakeMediaFailure,
  type PrototypeMediaSimEvent,
  type PrototypeMediaSimRequest,
} from "./prototypeFakeMediaEngine";
import { PROTOTYPE_PUSH_ERROR_CODES } from "./prototypePushSimulate";

/**
 * The host half of `prototype {action: "simulate", event: "media.*", data}` (#14257). The payload
 * is validated before any device is asked; `advanceMs` moves the fake engine's virtual clock first
 * and is refused on a native engine, whose clock is real.
 */

export const PROTOTYPE_MEDIA_ENGINES = ["fake", "native"] as const;
export type PrototypeMediaEngineKind = (typeof PROTOTYPE_MEDIA_ENGINES)[number];

/** Every simulate event refusal: the push codes plus `unsupported` for a real-clock advance. */
export const PROTOTYPE_MEDIA_SIMULATE_ERROR_CODES = [
  ...PROTOTYPE_PUSH_ERROR_CODES,
  "unsupported",
] as const;
export type PrototypeMediaSimulateErrorCode = (typeof PROTOTYPE_MEDIA_SIMULATE_ERROR_CODES)[number];

export function isPrototypeMediaSimEvent(event: string): event is PrototypeMediaSimEvent {
  return (PROTOTYPE_MEDIA_SIM_EVENTS as readonly string[]).includes(event);
}

export interface PrototypeMediaSimReply {
  success: boolean;
  /** The engine's refusal, when it has one. */
  code?: PrototypeFakeMediaFailure;
  error?: string;
}

/** The shown prototype's media module, reached over the authenticated prototype connection. */
export interface PrototypeMediaSimRoute {
  /** The engine the prototype's players run on; `undefined` when it has no media module. */
  engine(id: string): Promise<PrototypeMediaEngineKind | undefined>;
  deliver(
    id: string,
    request: PrototypeMediaSimRequest,
    timeoutMs?: number,
  ): Promise<PrototypeMediaSimReply>;
}

export interface PrototypeMediaSimulateRequest {
  id: string;
  event: PrototypeMediaSimEvent;
  data: unknown;
  timeoutMs?: number;
}

export type PrototypeMediaSimulateResult =
  | { success: true; mediaEngine: PrototypeMediaEngineKind }
  | {
      success: false;
      code: PrototypeMediaSimulateErrorCode;
      error: string;
      mediaEngine?: PrototypeMediaEngineKind;
    };

const player = z.string().min(1).max(64);
const code = z.enum(PROTOTYPE_MEDIA_ERROR_CODES);
const advanceMs = z.number().finite().int().min(1).max(3_600_000).optional();

const payloadSchemas: Record<
  PrototypeMediaSimEvent,
  z.ZodType<Omit<PrototypeMediaSimRequest, "event">>
> = {
  "media.statusChanged": z
    .object({
      player,
      status: z.enum(PROTOTYPE_MEDIA_SIM_STATUSES),
      code: code.optional(),
      advanceMs,
    })
    .strict()
    .refine(
      (data) => (data.status === PROTOTYPE_MEDIA_ERROR_STATUS) === (data.code !== undefined),
      {
        path: ["code"],
        message: "code is required for status error and only allowed there",
      },
    ),
  "media.ended": z.object({ player, advanceMs }).strict(),
  "media.error": z.object({ player, code, advanceMs }).strict(),
};

/** The value `data` holds at `path`, or undefined when any step of it is absent. */
function valueAtPath(data: unknown, path: readonly PropertyKey[]): unknown {
  return path.reduce<unknown>(
    (value, key) =>
      typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined,
    data,
  );
}

/**
 * The message for a payload issue. Zod 4 reports an omitted field as a type or option mismatch
 * against `undefined`; callers are told the field is `Required`, as before Zod 4 (#16102).
 */
function payloadIssueMessage(issue: z.core.$ZodIssue | undefined, data: unknown): string {
  if (!issue) {
    return "invalid";
  }
  const typeOrOption = issue.code === "invalid_type" || issue.code === "invalid_value";
  return typeOrOption && issue.path.length > 0 && valueAtPath(data, issue.path) === undefined
    ? "Required"
    : issue.message;
}

/** Parse `data` for a `media.*` event; the error names the first bad field. */
export function validatePrototypeMediaSimPayload(
  event: PrototypeMediaSimEvent,
  data: unknown,
): { success: true; request: PrototypeMediaSimRequest } | { success: false; error: string } {
  const parsed = payloadSchemas[event].safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? issue.path.join(".") : "data";
    return { success: false, error: `${path}: ${payloadIssueMessage(issue, data)}` };
  }
  return { success: true, request: { event, ...parsed.data } };
}

export async function simulatePrototypeMedia(
  route: PrototypeMediaSimRoute | undefined,
  request: PrototypeMediaSimulateRequest,
): Promise<PrototypeMediaSimulateResult> {
  const validation = validatePrototypeMediaSimPayload(request.event, request.data);
  if (!validation.success) {
    return { success: false, code: "invalid_args", error: validation.error };
  }
  try {
    const engine = route ? await route.engine(request.id) : undefined;
    if (!route || engine === undefined) {
      return {
        success: false,
        code: "unavailable",
        error:
          "simulate media: the shown prototype has no media engine on this device. Show a spec that requires the media platform module on a runtime that advertises prototype_platform_media_v1.",
      };
    }
    if (engine === "native" && validation.request.advanceMs !== undefined) {
      return {
        success: false,
        code: "unsupported",
        mediaEngine: engine,
        error:
          "simulate media: advanceMs needs the fake media engine; this prototype plays on the native engine, whose clock is real. Drop advanceMs or show the prototype with the fake engine.",
      };
    }
    const reply = await route.deliver(request.id, validation.request, request.timeoutMs);
    if (!reply.success) {
      return {
        success: false,
        code: reply.code ? "invalid_args" : "platform_error",
        mediaEngine: engine,
        error: reply.error ?? `simulate media failed${reply.code ? `: ${reply.code}` : ""}`,
      };
    }
    return { success: true, mediaEngine: engine };
  } catch (error) {
    logger.warn("[prototype] simulated media event failed", error);
    return {
      success: false,
      code: "platform_error",
      error: toActionableError(error, "simulate media failed").message,
    };
  }
}

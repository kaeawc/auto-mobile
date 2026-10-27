import { z } from "zod/v4";
import type { PrototypeEvent } from "../../observe/android/ctrlProxyProtocol";
import type { NewTestSessionEvent } from "../../../db/prototypeTestSessionRepository";

const deadTapSchema = z
  .object({
    stack: z.string().nullable(),
    screen: z.string().nullable(),
    x: z.number().finite(),
    y: z.number().finite(),
  })
  .strict();
export const stepDetailSchema = z.object({
  changes: z
    .array(
      z.object({
        key: z.string(),
        valueLength: z.number().optional(),
        valueType: z.string().optional(),
        valid: z.boolean().optional(),
      }),
    )
    .optional(),
  keys: z.array(z.string()).optional(),
  path: z.string().nullable().optional(),
  op: z.string().optional(),
  stack: z.string().nullable().optional(),
  screen: z.string().nullable().optional(),
  depth: z.number().optional(),
  pager: z.string().nullable().optional(),
  page: z.number().optional(),
  reason: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
});
export type StepDetail = z.infer<typeof stepDetailSchema>;
export type RecordedStep = NewTestSessionEvent;

/** Deepest stack wins, with code-point lexicographic id ordering for ties on every host. */
export function prototypeScreenLabel(stacks: PrototypeEvent["stacks"]): string {
  const entry = Object.entries(stacks ?? {})
    .filter(([, stack]) => stack.path.length > 0)
    .sort(
      ([a, left], [b, right]) =>
        right.path.length - left.path.length || (a < b ? -1 : a > b ? 1 : 0),
    )[0];
  return entry ? `${entry[0]}/${entry[1].path.at(-1)}` : "(root)";
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function changeDetail(event: PrototypeEvent, secure: ReadonlySet<string>): StepDetail | undefined {
  const payload = object(event.payload);
  const keys =
    typeof payload.key === "string"
      ? [payload.key]
      : Array.isArray(payload.keys)
        ? payload.keys.filter((key): key is string => typeof key === "string")
        : [];
  const values = object(payload.values);
  const changes = keys
    .filter((key) => !secure.has("*") && !secure.has(key))
    .map((key) => {
      const value = typeof payload.key === "string" ? payload.value : values[key];
      return {
        key,
        ...(typeof value === "string"
          ? { valueLength: value.length }
          : { valueType: typeof value }),
        ...(typeof event.validity?.[key] === "boolean" ? { valid: event.validity[key] } : {}),
      };
    });
  return changes.length ? { changes } : undefined;
}
function emitDetail(event: PrototypeEvent, secure: ReadonlySet<string>): StepDetail | undefined {
  if (event.name === "change") {
    return changeDetail(event, secure);
  }
  if (event.name === "prototype_dead_tap") {
    const parsed = deadTapSchema.safeParse(event.payload);
    return parsed.success ? parsed.data : undefined;
  }
  return {};
}
function screenDetail(event: PrototypeEvent): StepDetail {
  const payload = object(event.payload);
  return {
    stack: event.name,
    ...(typeof payload.screen === "string" ? { screen: payload.screen } : {}),
    ...(typeof payload.depth === "number" ? { depth: payload.depth } : {}),
  };
}
function validationDetail(event: PrototypeEvent, secure: ReadonlySet<string>): StepDetail {
  return { keys: (event.keys ?? []).filter((key) => !secure.has("*") && !secure.has(key)) };
}
function detailFor(event: PrototypeEvent, secure: ReadonlySet<string>): StepDetail | undefined {
  const payload = object(event.payload);
  switch (event.kind) {
    case "appearance_changed":
    case "unknown":
      return undefined;
    case "emit":
      return emitDetail(event, secure);
    case "change":
      return { path: event.name, ...(typeof payload.op === "string" ? { op: payload.op } : {}) };
    case "validation_failed":
      return validationDetail(event, secure);
    case "screen_changed":
      return screenDetail(event);
    case "page_changed":
      return {
        pager: event.name,
        ...(typeof event.payload === "number" ? { page: event.payload } : {}),
      };
    case "dismissed":
      return typeof payload.reason === "string" ? { reason: payload.reason } : {};
    default:
      return undefined;
  }
}
/** Allowlist only: raw snapshots, text, context and payload values never cross this boundary. */
export function recordableStep(
  event: PrototypeEvent,
  secureKeys: ReadonlySet<string>,
): RecordedStep | undefined {
  const detail = detailFor(event, secureKeys);
  return detail === undefined
    ? undefined
    : {
        event_sequence: event.sequence,
        at_ms: event.timestamp,
        kind: event.kind,
        name: event.name,
        screen: prototypeScreenLabel(event.stacks),
        detail_json: JSON.stringify(detail),
      };
}

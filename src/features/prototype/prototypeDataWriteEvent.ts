import { z } from "zod";
import type { PrototypeEvent } from "../observe/android/ctrlProxyProtocol";
import { prototypeDataPathPointer } from "./prototypeData";
import { prototypeJsonSchema, type PrototypeJson } from "./prototypeJson";

/**
 * A device `/data` write (`setData`, `appendData`, `removeData`) is reported as a `change` event
 * (`prototype_data_actions_v1`) that reuses the existing wire fields, so no event field is added:
 * `name` is the `/data/<pointer>` written (repeat `{index}` segments bound; for an append, the
 * array appended to) and `payload` is this object. `validity` may accompany it; `state` and
 * `pages` are the usual snapshot.
 */
export interface PrototypeDataWriteEventPayload {
  op: "set" | "append" | "remove";
  /**
   * The written value (set, append). Absent for a remove, or when the value is too large for the
   * event: the host then cannot mirror the write and stops tracking the spec.
   */
  value?: PrototypeJson;
  /**
   * The device revision after the write. A host patch whose `baseRevision` is older and whose
   * `/data` paths overlap `name` is refused with a conflict instead of overwriting the write.
   */
  revision: number;
}

const revisionSchema = z.number().finite().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const payloadSchema = z.union([
  z
    .object({
      op: z.enum(["set", "append"]),
      value: prototypeJsonSchema.optional(),
      revision: revisionSchema,
    })
    .strict(),
  z.object({ op: z.literal("remove"), revision: revisionSchema }).strict(),
]);

export type PrototypeDataWriteEvent = PrototypeDataWriteEventPayload & { path: string };

/** A `change` event whose name is a `/data/<pointer>` reports a device data write, not validity. */
export function isPrototypeDataWriteName(name: string | null): name is string {
  return name !== null && prototypeDataPathPointer(name) !== undefined;
}

/** The write a `change` event reports, or undefined for any other event or a malformed payload. */
export function prototypeDataWriteOf(
  event: Pick<PrototypeEvent, "kind" | "name" | "payload">,
): PrototypeDataWriteEvent | undefined {
  if (event.kind !== "change" || !isPrototypeDataWriteName(event.name)) {
    return undefined;
  }
  const payload = payloadSchema.safeParse(event.payload);
  return payload.success ? { ...payload.data, path: event.name } : undefined;
}

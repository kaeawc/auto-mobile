import { z } from "zod";
import type { PrototypeEvent } from "../observe/android/ctrlProxyProtocol";
import type { PrototypeDataWrite } from "./prototypeDataWrite";
import { pointerSchema } from "./prototypeActionValues";
import { prototypeDataPathPointer } from "./prototypeData";
import contract from "../../../schemas/prototype-spec-contract.json";
import { prototypeJsonSchema, type PrototypeJson } from "./prototypeJson";

/**
 * A device `/data` write (`setData`, `appendData`, `upsertData`, `removeData`) is reported as a `change` event
 * (`prototype_data_actions_v1`) that reuses the existing wire fields, so no event field is added:
 * `name` is the `/data/<pointer>` written (repeat `{index}` segments bound; for an append, the
 * array appended to) and `payload` is this object. `validity` may accompany it; `state` and
 * `pages` are the usual snapshot.
 */
export interface PrototypeDataWriteEventPayload {
  op: "set" | "append" | "upsert" | "remove";
  /** `upsert` only (#14261): the pointer, inside each element, of the identity the write matched. */
  key?: string;
  /** `append` and `upsert` only: the cap that dropped the oldest items after the write. */
  maxItems?: number;
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

const { MAX_PROTOTYPE_DATA_ARRAY_ITEMS } = contract.limits;
const revisionSchema = z.number().finite().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const maxItemsSchema = z.number().finite().int().min(1).max(MAX_PROTOTYPE_DATA_ARRAY_ITEMS);
const payloadSchema = z.union([
  z
    .object({
      op: z.literal("set"),
      value: prototypeJsonSchema.optional(),
      revision: revisionSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("append"),
      value: prototypeJsonSchema.optional(),
      maxItems: maxItemsSchema.optional(),
      revision: revisionSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("upsert"),
      key: pointerSchema,
      value: prototypeJsonSchema.optional(),
      maxItems: maxItemsSchema.optional(),
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

/** The write a device `set`, `append` or `upsert` event reports, as the shared pure function takes it. */
export function prototypeDeviceDataWrite(
  write: PrototypeDataWriteEvent,
  value: PrototypeJson,
): PrototypeDataWrite {
  switch (write.op) {
    case "upsert":
      return { op: "upsert", path: write.path, key: write.key!, value, maxItems: write.maxItems };
    case "append":
      return { op: "append", path: write.path, value, maxItems: write.maxItems };
    default:
      return { op: "set", path: write.path, value };
  }
}

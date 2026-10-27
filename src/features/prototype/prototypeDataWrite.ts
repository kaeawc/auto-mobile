import contract from "../../../schemas/prototype-spec-contract.json";
import type { PrototypeData, PrototypeDataActionValue, PrototypeJson } from "./prototypeSpec";
import { prototypeDataPathPointer, resolvePrototypeDataPointer } from "./prototypeData";
import { applyPrototypePatch, type PrototypePatchOp } from "./prototypePatch";
import { record } from "./prototypeTemplate";
import { prototypeDataError } from "./prototypeValidation";

/**
 * The pure semantics of a `setData` / `appendData` / `removeData` action (#12519). Device runtimes
 * and the host mirror apply a write with this one function so they cannot drift; `request`
 * responses (#12523) and storage restores (#12522) write `/data` through it as well.
 *
 * `path` is `/data/<pointer>` exactly as authored in the action (repeat `{index}` segments already
 * bound), and a patch op on `/data` uses the same spelling.
 */
export type PrototypeDataWrite =
  | { op: "set"; path: string; value: unknown }
  /** `maxItems` drops the oldest items so the array stays within it (#14261). */
  | { op: "append"; path: string; value: unknown; maxItems?: number }
  /**
   * Replaces the array element whose `key` pointer value equals the new value's, else appends it
   * (#14261). `maxItems` trims the oldest items afterwards.
   */
  | { op: "upsert"; path: string; key: string; value: unknown; maxItems?: number }
  | { op: "remove"; path: string };

export type PrototypeDataWriteErrorCode =
  | "invalid_path"
  | "invalid_value"
  | "not_found"
  | "not_array"
  | "limit_exceeded";

export interface PrototypeDataWriteError {
  code: PrototypeDataWriteErrorCode;
  message: string;
}

export type PrototypeDataWriteResult =
  | { success: true; data: PrototypeData }
  | { success: false; error: PrototypeDataWriteError };

const refused = (code: PrototypeDataWriteErrorCode, message: string): PrototypeDataWriteResult => ({
  success: false,
  error: { code, message },
});

/** JSON structural equality, for the `upsert` identity comparison. */
function sameJson(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameJson(item, right[index]))
    );
  }
  const a = record(left);
  const b = record(right);
  if (a && b) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]))
    );
  }
  return left === right;
}

/** The patch ops that perform a write whose target has been checked. */
function patchOps(
  write: PrototypeDataWrite,
  pointer: string,
  current: PrototypeData,
): PrototypePatchOp[] {
  if (write.op === "remove") {
    return [{ op: "remove", path: write.path }];
  }
  const value = write.value as PrototypeJson;
  if (write.op === "set") {
    const exists = resolvePrototypeDataPointer(current, pointer) !== undefined;
    return [{ op: exists ? "replace" : "add", path: write.path, value }];
  }
  const items = resolvePrototypeDataPointer(current, pointer) as unknown[];
  const identity =
    write.op === "upsert" ? resolvePrototypeDataPointer(value, write.key) : undefined;
  const matched =
    write.op === "upsert"
      ? items.findIndex((item) => {
          const existing = resolvePrototypeDataPointer(item, write.key);
          return existing !== undefined && sameJson(existing, identity);
        })
      : -1;
  const ops: PrototypePatchOp[] =
    matched >= 0
      ? [{ op: "replace", path: `${write.path}/${matched}`, value }]
      : [{ op: "add", path: `${write.path}/-`, value }];
  // Dropping the oldest items: each removal at 0 shifts the rest down.
  const length = matched >= 0 ? items.length : items.length + 1;
  const excess = write.maxItems === undefined ? 0 : Math.max(0, length - write.maxItems);
  for (let dropped = 0; dropped < excess; dropped++) {
    ops.push({ op: "remove", path: `${write.path}/0` });
  }
  return ops;
}

/** Why the write cannot apply to `data`, or undefined when its target is acceptable. */
function targetRefusal(
  data: PrototypeData,
  pointer: string,
  write: PrototypeDataWrite,
): PrototypeDataWriteResult | undefined {
  const existing = resolvePrototypeDataPointer(data, pointer);
  if (write.op === "append" || write.op === "upsert") {
    const name = write.op === "append" ? "appendData" : "upsertData";
    if (existing === undefined) {
      return refused("not_found", `${name} target ${write.path} does not exist`);
    }
    return Array.isArray(existing)
      ? undefined
      : refused("not_array", `${name} target ${write.path} is not an array`);
  }
  if (write.op === "remove") {
    return existing === undefined
      ? refused("not_found", `removeData target ${write.path} does not exist`)
      : undefined;
  }
  const parent = resolvePrototypeDataPointer(data, pointer.slice(0, pointer.lastIndexOf("/")));
  const parentIsContainer =
    pointer.lastIndexOf("/") === 0 ? true : Array.isArray(parent) || record(parent) !== undefined;
  // An array element is replaced, never created: appending is appendData's job.
  return !parentIsContainer || (existing === undefined && Array.isArray(parent))
    ? refused("not_found", `setData target ${write.path} has no existing parent or element`)
    : undefined;
}

/**
 * Applies one write to `data` (absent data is an empty object) and returns the new data without
 * touching the input. `set` creates or replaces an object member and replaces an existing array
 * element; `append` pushes onto an existing array; `remove` deletes an existing member or element
 * (later array elements shift down). The result must still satisfy the data limits, including
 * `MAX_PROTOTYPE_DATA_WRITE_BYTES`, or nothing is written.
 */
export function applyPrototypeDataWrite(
  data: unknown,
  write: PrototypeDataWrite,
): PrototypeDataWriteResult {
  const pointer = prototypeDataPathPointer(write.path);
  if (pointer === undefined) {
    return refused("invalid_path", `${write.path} is not a /data/<pointer> path`);
  }
  if (write.op !== "remove" && write.value === undefined) {
    return refused("invalid_value", "A set or append write needs a value");
  }
  const current = (record(data) ?? {}) as PrototypeData;
  const target = targetRefusal(current, pointer, write);
  if (target) {
    return target;
  }
  if (write.op === "upsert" && resolvePrototypeDataPointer(write.value, write.key) === undefined) {
    return refused("invalid_value", `upsertData value has no member at ${write.key}`);
  }
  if (write.op !== "remove" && write.op !== "set" && write.maxItems !== undefined) {
    const { maxItems } = write;
    if (
      !Number.isInteger(maxItems) ||
      maxItems < 1 ||
      maxItems > contract.limits.MAX_PROTOTYPE_DATA_ARRAY_ITEMS
    ) {
      return refused("invalid_value", "maxItems must be an integer from 1 to the data array limit");
    }
  }
  const applied = applyPrototypePatch({ data: current }, patchOps(write, pointer, current));
  if (!applied.success) {
    return refused("not_found", `${write.path}: ${applied.error.message}`);
  }
  const next = record(applied.spec.data);
  const invalid = prototypeDataError(next, contract.limits.MAX_PROTOTYPE_DATA_WRITE_BYTES);
  if (!next || invalid) {
    const message = invalid?.message ?? "Data must stay an object";
    return refused(message.includes("limit") ? "limit_exceeded" : "invalid_value", message);
  }
  return { success: true, data: next as PrototypeData };
}

/** The binding forms a device resolves at the action; `item` and `index` are bound by repeat first. */
export type PrototypeRuntimeDataActionValue = Exclude<
  PrototypeDataActionValue,
  { item: string } | { index: true }
>;

export interface PrototypeDataWriteInputs {
  state: Readonly<Record<string, PrototypeJson>>;
  data?: unknown;
}

export type PrototypeDataWriteValueResult =
  | { success: true; value: PrototypeJson }
  | { success: false; error: PrototypeDataWriteError };

/** `{state}` and `{data}` read the committed values at the action; a missing source is an error. */
export function resolvePrototypeDataWriteValue(
  binding: PrototypeRuntimeDataActionValue,
  inputs: PrototypeDataWriteInputs,
): PrototypeDataWriteValueResult {
  if ("value" in binding) {
    return { success: true, value: binding.value };
  }
  if ("state" in binding) {
    return Object.hasOwn(inputs.state, binding.state)
      ? { success: true, value: inputs.state[binding.state] }
      : {
          success: false,
          error: { code: "invalid_value", message: `State key ${binding.state} is not set` },
        };
  }
  const value = resolvePrototypeDataPointer(inputs.data, binding.data);
  return value === undefined
    ? {
        success: false,
        error: { code: "not_found", message: `Data pointer ${binding.data} does not exist` },
      }
    : { success: true, value: value as PrototypeJson };
}

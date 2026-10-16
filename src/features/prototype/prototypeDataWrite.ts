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
  | { op: "set" | "append"; path: string; value: unknown }
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

/** The patch op that performs a write whose target has been checked. */
function patchOp(write: PrototypeDataWrite, exists: boolean): PrototypePatchOp {
  if (write.op === "remove") {
    return { op: "remove", path: write.path };
  }
  const value = write.value as PrototypeJson;
  return write.op === "append"
    ? { op: "add", path: `${write.path}/-`, value }
    : { op: exists ? "replace" : "add", path: write.path, value };
}

/** Why the write cannot apply to `data`, or undefined when its target is acceptable. */
function targetRefusal(
  data: PrototypeData,
  pointer: string,
  write: PrototypeDataWrite,
): PrototypeDataWriteResult | undefined {
  const existing = resolvePrototypeDataPointer(data, pointer);
  if (write.op === "append") {
    if (existing === undefined) {
      return refused("not_found", `appendData target ${write.path} does not exist`);
    }
    return Array.isArray(existing)
      ? undefined
      : refused("not_array", `appendData target ${write.path} is not an array`);
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
  const exists = resolvePrototypeDataPointer(current, pointer) !== undefined;
  const applied = applyPrototypePatch({ data: current }, [patchOp(write, exists)]);
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

import { isPrototypeDataPointer } from "./prototypeData";
import contract from "../../../schemas/prototype-spec-contract.json";
import type { PrototypeData, PrototypeDataActionValue, PrototypeJson } from "./prototypeSpec";
import { prototypeDataPathPointer, resolvePrototypeDataPointer } from "./prototypeData";
import { applyPrototypePatch, type PrototypePatchOp } from "./prototypePatch";
import { record } from "./prototypeTemplate";
import { prototypeDataError } from "./prototypeValidation";

/**
 * The pure semantics of a `setData` / `appendData` / `prependData` / `removeData` action (#12519). Device runtimes
 * and the host mirror apply a write with this one function so they cannot drift; `request`
 * responses (#12523) and storage restores (#12522) write `/data` through it as well.
 *
 * `path` is `/data/<pointer>` exactly as authored in the action (repeat `{index}` segments already
 * bound), and a patch op on `/data` uses the same spelling.
 */
export type PrototypeDataWrite =
  | { op: "set"; path: string; value: unknown }
  | { op: "upsert"; path: string; key: string; value: unknown; maxItems?: number }
  | { op: "append"; path: string; value: unknown; maxItems?: number }
  | { op: "prepend"; path: string; value: unknown[]; maxItems?: number }
  | { op: "extend"; path: string; value: unknown[]; maxItems?: number }
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
  | { success: true; data: PrototypeData; trimmed: number }
  | { success: false; error: PrototypeDataWriteError };

const refused = (code: PrototypeDataWriteErrorCode, message: string): PrototypeDataWriteResult => ({
  success: false,
  error: { code, message },
});

/** The patch op that performs a write whose target has been checked. */
function patchOp(
  write: Exclude<PrototypeDataWrite, { op: "append" | "extend" | "prepend" | "upsert" }>,
  exists: boolean,
): PrototypePatchOp {
  if (write.op === "remove") {
    return { op: "remove", path: write.path };
  }
  const value = write.value as PrototypeJson;
  return { op: exists ? "replace" : "add", path: write.path, value };
}

/** Why the write cannot apply to `data`, or undefined when its target is acceptable. */
function targetRefusal(
  data: PrototypeData,
  pointer: string,
  write: PrototypeDataWrite,
): PrototypeDataWriteResult | undefined {
  const existing = resolvePrototypeDataPointer(data, pointer);
  if (
    write.op === "append" ||
    write.op === "extend" ||
    write.op === "prepend" ||
    write.op === "upsert"
  ) {
    const name =
      write.op === "append"
        ? "appendData"
        : write.op === "prepend"
          ? "prependData"
          : write.op === "upsert"
            ? "upsertData"
            : "extend";
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
  return setTargetRefusal(data, pointer, write.path, existing);
}

function setTargetRefusal(
  data: PrototypeData,
  pointer: string,
  path: string,
  existing: unknown,
): PrototypeDataWriteResult | undefined {
  const parent = resolvePrototypeDataPointer(data, pointer.slice(0, pointer.lastIndexOf("/")));
  const parentIsContainer =
    pointer.lastIndexOf("/") === 0 ? true : Array.isArray(parent) || record(parent) !== undefined;
  // An array element is replaced, never created: appending is appendData's job.
  return !parentIsContainer || (existing === undefined && Array.isArray(parent))
    ? refused("not_found", `setData target ${path} has no existing parent or element`)
    : undefined;
}

function valueRefusal(write: PrototypeDataWrite): PrototypeDataWriteResult | undefined {
  if (write.op === "remove") {
    return undefined;
  }
  if (
    write.op === "upsert" &&
    (!isPrototypeDataPointer(write.key) ||
      resolvePrototypeDataPointer(write.value, write.key) === undefined)
  )
    return refused("invalid_value", "upsert needs a valid key pointer present in value");
  const name = write.op === "prepend" ? "prependData" : write.op;
  if (write.value === undefined) {
    return refused("invalid_value", `${name} write needs a value`);
  }
  if (["extend", "prepend"].includes(write.op) && !Array.isArray(write.value)) {
    return refused("invalid_value", `${name} needs an array value`);
  }
  if (
    "maxItems" in write &&
    write.maxItems !== undefined &&
    (!Number.isSafeInteger(write.maxItems) ||
      write.maxItems < 1 ||
      ((write.op === "upsert" || write.op === "append") &&
        write.maxItems > contract.limits.MAX_PROTOTYPE_DATA_ARRAY_ITEMS))
  ) {
    return refused("invalid_value", `${name} maxItems must be a positive safe integer`);
  }
  return undefined;
}

/** JSON identity compares numbers by value and strings/object keys by exact spelling. */
function sameKey(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length && left.every((value, index) => sameKey(value, right[index]))
    );
  const a = record(left),
    b = record(right);
  return (
    a !== undefined &&
    b !== undefined &&
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every((key) => Object.hasOwn(b, key) && sameKey(a[key], b[key]))
  );
}

/** Targets have already been checked; concatenate and trim before validating the final data. */
function windowedWrite(
  current: PrototypeData,
  pointer: string,
  write: PrototypeDataWrite,
): {
  effective: Exclude<PrototypeDataWrite, { op: "append" | "extend" | "prepend" | "upsert" }>;
  trimmed: number;
} {
  if (
    write.op !== "append" &&
    write.op !== "extend" &&
    write.op !== "prepend" &&
    write.op !== "upsert"
  ) {
    return { effective: write, trimmed: 0 };
  }
  const existing = resolvePrototypeDataPointer(current, pointer) as unknown[];
  let combined =
    write.op === "prepend"
      ? write.value.concat(existing)
      : existing.concat(write.op === "extend" ? write.value : [write.value]);
  if (write.op === "upsert") {
    const key = resolvePrototypeDataPointer(write.value, write.key);
    const index = existing.findIndex((item) => {
      const candidate = resolvePrototypeDataPointer(item, write.key);
      return candidate !== undefined && sameKey(candidate, key);
    });
    combined = existing.slice();
    if (index < 0) combined.push(write.value);
    else combined[index] = write.value;
  }
  const trimmed = write.maxItems === undefined ? 0 : Math.max(0, combined.length - write.maxItems);
  return {
    effective: {
      op: "set",
      path: write.path,
      value:
        write.op === "prepend"
          ? combined.slice(0, combined.length - trimmed)
          : combined.slice(trimmed),
    },
    trimmed,
  };
}

/**
 * Applies one write to `data` (absent data is an empty object) and returns the new data without
 * touching the input. `set` creates or replaces an object member and replaces an existing array
 * element; `append` pushes one element, `extend` concatenates elements, then both trim from the
 * start when maxItems is present. `prepend` inserts an ordered page at the start and trims
 * from the end, keeping the first maxItems rows; `remove` deletes an existing member or element
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
  const invalidValue = valueRefusal(write);
  if (invalidValue) {
    return invalidValue;
  }
  const current = (record(data) ?? {}) as PrototypeData;
  const target = targetRefusal(current, pointer, write);
  if (target) {
    return target;
  }
  const exists = resolvePrototypeDataPointer(current, pointer) !== undefined;
  const { effective, trimmed } = windowedWrite(current, pointer, write);
  const applied = applyPrototypePatch({ data: current }, [patchOp(effective, exists)]);
  if (!applied.success) {
    return refused("not_found", `${write.path}: ${applied.error.message}`);
  }
  const next = record(applied.spec.data);
  const invalid = prototypeDataError(next, contract.limits.MAX_PROTOTYPE_DATA_WRITE_BYTES);
  if (!next || invalid) {
    const message = invalid?.message ?? "Data must stay an object";
    return refused(message.includes("limit") ? "limit_exceeded" : "invalid_value", message);
  }
  return { success: true, data: next as PrototypeData, trimmed };
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

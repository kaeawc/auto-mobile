import { resolvePrototypeDerivedBinding } from "./prototypeDerive";
import { prototypeGeneratedForms } from "./prototypeGeneratedBindings";
import {
  resolvePrototypeGeneratedJson,
  type PrototypeActionContext,
} from "./prototypeGeneratedValues";
import { isPrototypeDataPointer } from "./prototypeData";
import contract from "../../../schemas/prototype-spec-contract.json";
import type { PrototypeData, PrototypeDataActionValue, PrototypeJson } from "./prototypeSpec";
import { prototypeDataPathPointer, resolvePrototypeDataPointer } from "./prototypeData";
import { applyPrototypePatch, type PrototypePatchOp } from "./prototypePatch";
import { record } from "./prototypeTemplate";
import { prototypeDataError } from "./prototypeValidation";
import { PROTOTYPE_BASE_BUDGET, type PrototypeRuntimeBudget } from "./prototypeRuntimeBudget";

/**
 * The pure semantics of a `setData` / `appendData` / `prependData` / `removeData` action (#12519). Device runtimes
 * and the host mirror apply a write with this one function so they cannot drift; `request`
 * responses (#12523) and storage restores (#12522) write `/data` through it as well.
 *
 * `path` is `/data/<pointer>` exactly as authored in the action (repeat `{index}` segments already
 * bound), and a patch op on `/data` uses the same spelling.
 */
export interface PrototypeDataMatch {
  field: string;
  equals: unknown;
}

export type PrototypeDataWrite =
  | { op: "set"; path: string; value: unknown; where?: PrototypeDataMatch; member?: string }
  | { op: "upsert"; path: string; key: string; value: unknown; maxItems?: number }
  | { op: "append"; path: string; value: unknown; maxItems?: number }
  | { op: "prepend"; path: string; value: unknown[]; maxItems?: number }
  | { op: "extend"; path: string; value: unknown[]; maxItems?: number }
  | { op: "remove"; path: string; where?: PrototypeDataMatch };

export type PrototypeDataWriteErrorCode =
  | "lastGenerated_unset"
  | "invalid_path"
  | "invalid_value"
  | "ambiguous_match"
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

function valueRefusal(
  write: PrototypeDataWrite,
  budget: PrototypeRuntimeBudget,
): PrototypeDataWriteResult | undefined {
  if (write.op === "remove") {
    return undefined;
  }
  if (
    write.op === "upsert" &&
    (!isPrototypeDataPointer(write.key) ||
      resolvePrototypeDataPointer(write.value, write.key) === undefined)
  ) {
    return refused("invalid_value", "upsert needs a valid key pointer present in value");
  }
  const name = write.op === "prepend" ? "prependData" : write.op;
  if (write.value === undefined) {
    return refused("invalid_value", `${name} write needs a value`);
  }
  if (["extend", "prepend"].includes(write.op) && !Array.isArray(write.value)) {
    return refused("invalid_value", `${name} needs an array value`);
  }
  return maximumRefusal(write, name, budget);
}

function maximumRefusal(
  write: PrototypeDataWrite,
  name: string,
  budget: PrototypeRuntimeBudget,
): PrototypeDataWriteResult | undefined {
  if (
    "maxItems" in write &&
    write.maxItems !== undefined &&
    (!Number.isSafeInteger(write.maxItems) ||
      write.maxItems < 1 ||
      ((write.op === "upsert" || write.op === "append") &&
        write.maxItems > budget.MAX_PROTOTYPE_DATA_ARRAY_ITEMS))
  ) {
    return refused("invalid_value", `${name} maxItems must be a positive safe integer`);
  }
  return undefined;
}

/** JSON identity compares numbers by value and strings/object keys by exact spelling. */
function sameKey(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((value, index) => sameKey(value, right[index]))
    );
  }
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
    if (index < 0) {
      combined.push(write.value);
    } else {
      combined[index] = write.value;
    }
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

function isKeyedWrite(
  write: PrototypeDataWrite,
): write is Extract<PrototypeDataWrite, { op: "set" | "remove" }> {
  return (
    (write.op === "set" || write.op === "remove") &&
    (write.where !== undefined || (write.op === "set" && write.member !== undefined))
  );
}

function keyedWrite(
  data: PrototypeData,
  pointer: string,
  write: Extract<PrototypeDataWrite, { op: "set" | "remove" }>,
  budget: PrototypeRuntimeBudget,
): PrototypeDataWriteResult {
  const { where } = write;
  const member = write.op === "set" ? write.member : undefined;
  const validName = (name: string) =>
    name.length > 0 &&
    name.length <= contract.limits.MAX_PROTOTYPE_DATA_POINTER_LENGTH &&
    !name.includes("/") &&
    !name.includes("~");
  if (!where || !validName(where.field) || (member !== undefined && !validName(member))) {
    return refused(
      "invalid_path",
      "Keyed writes need safe field and member names and a where selector",
    );
  }
  const target = resolvePrototypeDataPointer(data, pointer);
  if (target === undefined) {
    return refused("not_found", `Keyed target ${write.path} does not exist`);
  }
  if (!Array.isArray(target)) {
    return refused("not_array", `Keyed target ${write.path} is not an array`);
  }
  const matches = target.flatMap((row, index) => {
    const object = record(row);
    return object &&
      Object.hasOwn(object, where.field) &&
      sameKey(object[where.field], where.equals)
      ? [index]
      : [];
  });
  if (matches.length === 0) {
    return refused("not_found", "No element matches where");
  }
  if (matches.length > 1) {
    return refused("ambiguous_match", "More than one element matches where");
  }
  const index = matches[0];
  const changed = target.slice();
  if (write.op === "remove") {
    changed.splice(index, 1);
  } else if (member === undefined) {
    changed[index] = write.value;
  } else {
    changed[index] = { ...record(target[index]), [member]: write.value };
  }
  return applyPrototypeDataWrite(data, { op: "set", path: write.path, value: changed }, budget);
}

/**
 * Applies one write to `data` (absent data is an empty object) and returns the new data without
 * touching the input. `set` creates or replaces an object member and replaces an existing array
 * element; `append` pushes one element, `extend` concatenates elements, then both trim from the
 * start when maxItems is present. `prepend` inserts an ordered page at the start and trims
 * from the end, keeping the first maxItems rows; `remove` deletes an existing member or element
 * (later array elements shift down). The result must still satisfy the data limits, including
 * `MAX_PROTOTYPE_DATA_WRITE_BYTES`, or nothing is written. `budget` is the limits of the runtime
 * the data lives in (#18804): the base budget unless it advertises a larger one.
 */
export function applyPrototypeDataWrite(
  data: unknown,
  write: PrototypeDataWrite,
  budget: PrototypeRuntimeBudget = PROTOTYPE_BASE_BUDGET,
): PrototypeDataWriteResult {
  const pointer = prototypeDataPathPointer(write.path);
  if (pointer === undefined) {
    return refused("invalid_path", `${write.path} is not a /data/<pointer> path`);
  }
  const invalidValue = valueRefusal(write, budget);
  if (invalidValue) {
    return invalidValue;
  }
  const current = (record(data) ?? {}) as PrototypeData;
  if (isKeyedWrite(write)) {
    return keyedWrite(current, pointer, write, budget);
  }
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
  return writtenData(record(applied.spec.data), trimmed, budget);
}

/** The written data, unless it breaks the data limits of `budget`. */
function writtenData(
  next: Record<string, unknown> | undefined,
  trimmed: number,
  budget: PrototypeRuntimeBudget,
): PrototypeDataWriteResult {
  const invalid = prototypeDataError(
    next,
    budget.MAX_PROTOTYPE_DATA_WRITE_BYTES,
    budget.MAX_PROTOTYPE_DATA_ARRAY_ITEMS,
  );
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
  derived?: Readonly<Record<string, unknown>>;
  context?: PrototypeActionContext;
}

export type PrototypeDataWriteValueResult =
  | { success: true; value: PrototypeJson }
  | { success: false; error: PrototypeDataWriteError };

/** `{state}` and `{data}` read the committed values at the action; a missing source is an error. */
export function resolvePrototypeDataWriteValue(
  binding: PrototypeRuntimeDataActionValue,
  inputs: PrototypeDataWriteInputs,
): PrototypeDataWriteValueResult {
  const generated = resolveGeneratedBinding(binding, inputs.context);
  if (generated) {
    return generated;
  }
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
  if ("derived" in binding) {
    const value = resolvePrototypeDerivedBinding(inputs.derived, binding.derived);
    return value === undefined
      ? {
          success: false,
          error: { code: "not_found", message: `Derived value ${binding.derived} is not set` },
        }
      : { success: true, value };
  }
  if (!("data" in binding)) {
    return { success: false, error: { code: "invalid_value", message: "Invalid binding" } };
  }
  const value = resolvePrototypeDataPointer(inputs.data, binding.data);
  return value === undefined
    ? {
        success: false,
        error: { code: "not_found", message: `Data pointer ${binding.data} does not exist` },
      }
    : { success: true, value: value as PrototypeJson };
}

function resolveGeneratedBinding(
  binding: PrototypeRuntimeDataActionValue,
  context: PrototypeActionContext | undefined,
): PrototypeDataWriteValueResult | undefined {
  const forms = prototypeGeneratedForms(binding);
  if (forms.length > 0) {
    if (!context) {
      return {
        success: false,
        error: {
          code: forms[0] === "lastGenerated" ? "lastGenerated_unset" : "invalid_value",
          message: "Generated bindings require an action-list context",
        },
      };
    }
    let generated = context.lastGenerated !== undefined;
    for (const form of forms) {
      if (form === "generate") {
        generated = true;
      }
      if (form === "lastGenerated" && !generated) {
        return {
          success: false,
          error: {
            code: "lastGenerated_unset",
            message: "No preceding generate in this action list",
          },
        };
      }
    }
    const value = "value" in binding ? binding.value : binding;
    return { success: true, value: resolvePrototypeGeneratedJson(value, context) };
  }
  return undefined;
}

export function resolvePrototypeDataMatch(
  selector: unknown,
  inputs: PrototypeDataWriteInputs,
):
  | { success: true; where?: PrototypeDataMatch }
  | { success: false; error: PrototypeDataWriteError } {
  const where = record(selector);
  if (!where) {
    return { success: true };
  }
  const equals = resolvePrototypeDataWriteValue(
    where.equals as PrototypeRuntimeDataActionValue,
    inputs,
  );
  return equals.success
    ? { success: true, where: { field: String(where.field), equals: equals.value } }
    : equals;
}

/** Resolve at execution only; the mirror consumes the resulting write, never these bindings. */
export function applyPrototypeDataAction(
  action: Record<string, unknown>,
  inputs: PrototypeDataWriteInputs,
): PrototypeDataWriteResult {
  const path = String(action.path);
  const value =
    action.type === "removeData"
      ? undefined
      : resolvePrototypeDataWriteValue(action.value as PrototypeRuntimeDataActionValue, inputs);
  if (value && !value.success) {
    return value;
  }
  const match = resolvePrototypeDataMatch(action.where, inputs);
  if (!match.success) {
    return match;
  }
  const { where } = match;
  if (action.type === "removeData") {
    return applyPrototypeDataWrite(inputs.data, { op: "remove", path, where });
  }
  if (!value?.success) {
    return refused("invalid_value", "Missing action value");
  }
  return applyResolvedDataAction(action, inputs.data, value.value, where);
}

function applyResolvedDataAction(
  action: Record<string, unknown>,
  data: unknown,
  value: PrototypeJson,
  where?: PrototypeDataMatch,
): PrototypeDataWriteResult {
  const path = String(action.path);
  const maxItems = typeof action.maxItems === "number" ? action.maxItems : undefined;
  switch (action.type) {
    case "setData":
      return applyPrototypeDataWrite(data, {
        op: "set",
        path,
        value: value,
        where,
        member: typeof action.member === "string" ? action.member : undefined,
      });
    case "appendData":
      return applyPrototypeDataWrite(data, {
        op: "append",
        path,
        value: value,
        maxItems,
      });
    case "upsertData":
      return applyPrototypeDataWrite(data, {
        op: "upsert",
        path,
        value: value,
        key: String(action.key),
        maxItems,
      });
    case "prependData":
      return Array.isArray(value)
        ? applyPrototypeDataWrite(data, {
            op: "prepend",
            path,
            value: value,
            maxItems,
          })
        : refused("invalid_value", "prependData requires an array");
    default:
      return refused("invalid_value", "Not a data action");
  }
}

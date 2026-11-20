import {
  PROTOTYPE_DATA_ACTIONS_V2_CAPABILITY,
  PROTOTYPE_DATA_ACTIONS_V3_CAPABILITY,
  PROTOTYPE_DATA_ACTIONS_CAPABILITY,
} from "../observe/android/ctrlProxyProtocol";
import { prototypeDataPathPointer, resolvePrototypeDataPointer } from "./prototypeData";
import { prototypeFieldsOfKind } from "./prototypeEmitContext";
import { record, templateSegments, type Binding } from "./prototypeTemplate";

/**
 * Host-side rules for the `setData`, `appendData` and `removeData` actions (#12519). The contract
 * types each action's fields; this module adds what it cannot: the `/data/<pointer>` path guard,
 * `{index}` placement, a statically knowable `appendData` target and a literal value that data
 * could hold (`dataError`, the validator's data walk, is injected because the validator imports
 * this module). The write itself is {@link applyPrototypeDataWrite}.
 */
export const PROTOTYPE_DATA_ACTION_TYPES = [
  "setData",
  "appendData",
  "upsertData",
  "prependData",
  "removeData",
] as const;

/** Authored paths of every data action's `path`, including component definitions. */
export function prototypeDataActionFields(spec: unknown): string[] {
  return prototypeFieldsOfKind(spec, "dataPath");
}

export function prototypeDataActionsUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  const device = platform === "android" ? "connected CtrlProxy" : "connected iOS prototype agent";
  const update =
    platform === "android"
      ? "Update the connected CtrlProxy"
      : "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version";
  const more = fields.length > 1 ? ` (and ${fields.length - 1} more)` : "";
  return `The ${device} does not advertise ${PROTOTYPE_DATA_ACTIONS_CAPABILITY}, so it cannot run the setData, appendData, prependData or removeData action at ${fields[0]}${more}. Nothing was shown. ${update}, or answer the tap from the host with a /data patch.`;
}

export function prototypeKeyedDataActionFields(spec: unknown): string[] {
  return prototypeFieldsOfKind(spec, "keyedData");
}

export function prototypeKeyedDataActionsUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  return prototypeDataActionsUnsupportedMessage(fields, platform).replace(
    PROTOTYPE_DATA_ACTIONS_CAPABILITY,
    PROTOTYPE_DATA_ACTIONS_V2_CAPABILITY,
  );
}

/** Data actions whose `value` is an `{object}` of member bindings (#18826). */
export function prototypeObjectDataActionFields(spec: unknown): string[] {
  return prototypeFieldsOfKind(spec, "objectData");
}

export function prototypeObjectDataActionsUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  return prototypeDataActionsUnsupportedMessage(fields, platform)
    .replace(PROTOTYPE_DATA_ACTIONS_CAPABILITY, PROTOTYPE_DATA_ACTIONS_V3_CAPABILITY)
    .replace(
      ", or answer the tap from the host with a /data patch.",
      ", or write each member with its own setData action.",
    );
}

const INDEX_SEGMENT = "{index}";
// `\0` cannot occur in a repeat alias, so only `{index}` is recognised as a placeholder.
const INDEX_ONLY: Binding = { alias: "\0", index: true };

/** True when the path holds a `{index}` placeholder anywhere in it. */
export function prototypeDataPathHasIndex(path: string): boolean {
  return templateSegments(path, INDEX_ONLY).some((segment) => segment.kind === "index");
}

/**
 * The message for a path whose placeholders break the data-path grammar inside a repeat whose
 * binding is `binding`, or undefined. Only a whole `{index}` segment binds; `{alias.field}`
 * would let item content inject pointer syntax.
 */
export function prototypeDataPathPlaceholderMessage(
  path: string,
  binding: Binding,
): string | undefined {
  if (templateSegments(path, binding).some((segment) => segment.kind === "field")) {
    return "Only a whole {index} segment may be a placeholder in a data path";
  }
  return path
    .split("/")
    .some((segment) => segment.includes(INDEX_SEGMENT) && segment !== INDEX_SEGMENT)
    ? "{index} must be a whole data path segment"
    : undefined;
}

/** The path with each whole `{index}` segment bound to a row (0), for static checks. */
function staticPath(path: string): string {
  return path
    .split("/")
    .map((segment) => (segment === INDEX_SEGMENT ? "0" : segment))
    .join("/");
}

export interface PrototypeDataActionError {
  path: string;
  message: string;
}

/**
 * Static checks for one structurally valid data action at `at`. `data` is the spec's top-level
 * `data`: an `appendData` target that resolves there to something other than an array is refused;
 * a target under a `{index}` segment, or one the spec's data does not define (a device write may
 * create it first), is not statically resolvable and is left to the device.
 */
export function prototypeDataActionError(
  action: Record<string, unknown>,
  at: string,
  data: unknown,
  dataError: (data: unknown) => unknown,
): PrototypeDataActionError | undefined {
  if (
    typeof action.type !== "string" ||
    !PROTOTYPE_DATA_ACTION_TYPES.some((t) => t === action.type)
  ) {
    return undefined;
  }
  const path = typeof action.path === "string" ? action.path : "";
  const pointer = prototypeDataPathPointer(staticPath(path));
  if (pointer === undefined) {
    return {
      path: `${at}.path`,
      message: "Data action paths are /data/<RFC 6901 pointer> and address a member of data",
    };
  }
  const literal = dataActionLiteralError(action, at, dataError);
  if (literal) {
    return literal;
  }
  if (
    (["appendData", "prependData", "upsertData"].includes(action.type) ||
      action.where !== undefined) &&
    !prototypeDataPathHasIndex(path)
  ) {
    const target = resolvePrototypeDataPointer(data, pointer);
    if (target !== undefined && !Array.isArray(target)) {
      return { path: `${at}.path`, message: `${action.type} target is not an array` };
    }
  }
  return undefined;
}

/** The first data action in `actions` (located, authored form) that breaks a static rule. */
export function prototypeDataActionsError(
  actions: readonly { value: Record<string, unknown>; path: string }[],
  data: unknown,
  dataError: (data: unknown) => unknown,
): PrototypeDataActionError | undefined {
  for (const { value, path } of actions) {
    const error = prototypeDataActionError(value, path, data, dataError);
    if (error) {
      return error;
    }
  }
  return undefined;
}

/** True when an `upsertData` key names an `{object}` member that can carry its identity. */
function objectKeyNamesMember(key: string, members: Record<string, unknown>): boolean {
  const name = key.split("/")[1] ?? "";
  const member = Object.hasOwn(members, name) ? record(members[name]) : undefined;
  if (!member || !Object.hasOwn(member, "value")) {
    return member !== undefined;
  }
  const rest = key.slice(name.length + 1);
  const identity = rest === "" ? member.value : resolvePrototypeDataPointer(member.value, rest);
  return identity !== undefined && identity !== null;
}

/**
 * An `{object}` value's literal members (#18826). An `upsertData` key's first pointer segment must
 * name a member, and when that member is a literal the rest of the key must resolve non-null in it.
 */
function dataObjectLiteralError(
  action: Record<string, unknown>,
  members: Record<string, unknown>,
  at: string,
  dataError: (data: unknown) => unknown,
): PrototypeDataActionError | undefined {
  const key = typeof action.key === "string" ? action.key : "";
  if (action.type === "upsertData" && !objectKeyNamesMember(key, members)) {
    return {
      path: `${at}.key`,
      message:
        "upsertData key pointer must start with an object value member, non-null when that member is a literal",
    };
  }
  const invalid = Object.keys(members)
    .sort()
    .find((name) => {
      const member = record(members[name]);
      return (
        member !== undefined &&
        Object.hasOwn(member, "value") &&
        dataError({ value: member.value }) !== undefined
      );
    });
  return invalid === undefined
    ? undefined
    : {
        path: `${at}.value.object.${invalid}.value`,
        message: "A data write value must be a string, boolean, finite number, array or object",
      };
}

function dataActionLiteralError(
  action: Record<string, unknown>,
  at: string,
  dataError: (data: unknown) => unknown,
): PrototypeDataActionError | undefined {
  const value = (action.value ?? {}) as Record<string, unknown>;
  const members = Object.hasOwn(value, "object") ? record(value.object) : undefined;
  if (members) {
    return dataObjectLiteralError(action, members, at, dataError);
  }
  if (action.type === "upsertData" && Object.hasOwn(value, "value")) {
    const key = typeof action.key === "string" ? action.key : "";
    const identity = resolvePrototypeDataPointer(value.value, key);
    if (identity === undefined || identity === null) {
      return {
        path: `${at}.value.value`,
        message: "upsertData key pointer must be present and non-null in the literal value",
      };
    }
  }
  if (Object.hasOwn(value, "value") && dataError({ value: value.value }) !== undefined) {
    return {
      path: `${at}.value.value`,
      message: "A data write value must be a string, boolean, finite number, array or object",
    };
  }
  return undefined;
}

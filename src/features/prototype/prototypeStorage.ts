import { prototypeContractPatterns } from "./prototypeContractPatterns";
import { ActionableError } from "../../models/ActionableError";
import { z } from "zod";
import contract from "../../../schemas/prototype-spec-contract.json";
import { PROTOTYPE_STORAGE_CAPABILITY, type PrototypeStorageReport } from "./prototypeStorageWire";
import { prototypeDataPathPointer, resolvePrototypeDataPointer } from "./prototypeData";
import { record } from "./prototypeTemplate";

/**
 * The spec's root-level `storage` block (#12522, `prototype_storage_v1`):
 * `"storage": {"version": 1, "keys": ["state:darkMode", "data:/cart"]}`. The device saves the listed
 * state keys and `/data` pointers under the spec `id` after every write and restores them on the
 * next show of that id (see "Storage" in docs/design-docs/plat/android/prototype-ux.md for the
 * precedence rules). This module is the host's half: the gate, the static validation and the
 * device-to-host report parser. The restore rules live in `prototypeStorageRestore.ts`.
 */
export const { MAX_PROTOTYPE_STORAGE_BYTES, MAX_PROTOTYPE_STORAGE_KEYS } = contract.limits;

const STATE_PREFIX = "state:";
const DATA_PREFIX = "data:";
const STATE_KEY = prototypeContractPatterns.stateKey;

export interface PrototypeStorageBlock {
  version: number;
  keys: string[];
}

export type PrototypeStorageKey =
  | { kind: "state"; key: string }
  | { kind: "data"; pointer: string };

/** A storage key is `state:<key>` or `data:<RFC 6901 pointer into data>`; anything else is undefined. */
export function parsePrototypeStorageKey(storageKey: unknown): PrototypeStorageKey | undefined {
  if (typeof storageKey !== "string") {
    return undefined;
  }
  if (storageKey.startsWith(STATE_PREFIX)) {
    const key = storageKey.slice(STATE_PREFIX.length);
    return STATE_KEY.test(key) ? { kind: "state", key } : undefined;
  }
  if (storageKey.startsWith(DATA_PREFIX)) {
    const pointer = storageKey.slice(DATA_PREFIX.length);
    // `/data` + pointer is the path form every data action and patch op uses, so reuse its guard:
    // the pointer must address a member of `data`, never the whole document.
    return prototypeDataPathPointer(`/data${pointer}`) === pointer
      ? { kind: "data", pointer }
      : undefined;
  }
  return undefined;
}

/** True when `a` equals `b` or one is an ancestor of the other (`/cart` overlaps `/cart/items`). */
function pointersOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** The spec's `storage` block when it has the authored shape, else undefined. */
export function prototypeStorageBlock(spec: unknown): PrototypeStorageBlock | undefined {
  const storage = record(record(spec)?.storage);
  if (!storage || typeof storage.version !== "number" || !Array.isArray(storage.keys)) {
    return undefined;
  }
  return { version: storage.version, keys: storage.keys.map(String) };
}

/** The gate field: `storage` is the one authored path that needs `prototype_storage_v1`. */
export function prototypeStorageFields(spec: unknown): string[] {
  return record(spec)?.storage === undefined ? [] : ["storage"];
}

export function prototypeStorageUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  const device = platform === "android" ? "connected CtrlProxy" : "connected iOS prototype agent";
  const update =
    platform === "android"
      ? "Update the connected CtrlProxy"
      : "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version";
  return `The ${device} does not advertise ${PROTOTYPE_STORAGE_CAPABILITY}, so it cannot persist the ${fields[0]} block. Nothing was shown or patched. ${update}, or remove storage and keep the values on the host.`;
}

/** The refusal for `clearStorage` (and any other storage-only request) on a device without the capability. */
export function prototypeClearStorageUnsupportedMessage(platform: "android" | "ios"): string {
  const device = platform === "android" ? "connected CtrlProxy" : "connected iOS prototype agent";
  const update =
    platform === "android"
      ? "Update the connected CtrlProxy"
      : "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version";
  return `clearStorage: the ${device} does not advertise ${PROTOTYPE_STORAGE_CAPABILITY}, so it keeps no stored prototype values. Nothing was sent. ${update}.`;
}

/**
 * Refuses, before anything is sent, a storage-only request (`clear_prototype_storage`) to a CtrlProxy
 * that does not advertise `prototype_storage_v1`. `supports` answers from the handshake.
 */
export function requirePrototypeStorageSupport(
  requestType: string,
  supports: (capability: string) => boolean | undefined,
): void {
  if (
    requestType === "clear_prototype_storage" &&
    supports(PROTOTYPE_STORAGE_CAPABILITY) !== true
  ) {
    throw new ActionableError(prototypeClearStorageUnsupportedMessage("android"));
  }
}

export interface PrototypeStorageError {
  path: string;
  message: string;
}

/** Compact-JSON bytes of a stored entry: the storage key plus its value, as the device counts them. */
export function prototypeStorageEntryBytes(storageKey: string, value: unknown): number {
  return Buffer.byteLength(storageKey) + Buffer.byteLength(JSON.stringify(value) ?? "null");
}

/**
 * Cross-reference checks the structural contract cannot express, for a spec whose `storage` block
 * already passed the contract (shape, `version >= 1`, at most `MAX_PROTOTYPE_STORAGE_KEYS`
 * unique strings): every `state:` key is declared in `state`, every `data:` pointer is a nonempty
 * pointer under `/data`, no two data pointers overlap, and the values the spec itself supplies for
 * the listed keys fit `MAX_PROTOTYPE_STORAGE_BYTES`. Returns the first problem at its path.
 */
export function prototypeStorageError(spec: unknown): PrototypeStorageError | undefined {
  const block = prototypeStorageBlock(spec);
  const root = record(spec) ?? {};
  const claimed: { pointer: string; index: number }[] = [];
  let bytes = 0;
  for (const [index, storageKey] of (block?.keys ?? []).entries()) {
    const checked = checkStorageKey(storageKey, root, claimed, index);
    if ("message" in checked) {
      return { path: `storage.keys[${index}]`, message: checked.message };
    }
    bytes += checked.bytes;
  }
  return bytes > MAX_PROTOTYPE_STORAGE_BYTES
    ? { path: "storage.keys", message: "Storage byte limit exceeded" }
    : undefined;
}

/** What one listed key costs against the byte limit, or why it is refused. */
type KeyCheck = { bytes: number } | { message: string };

function checkStorageKey(
  storageKey: string,
  root: Record<string, unknown>,
  claimed: { pointer: string; index: number }[],
  index: number,
): KeyCheck {
  const parsed = parsePrototypeStorageKey(storageKey);
  if (!parsed) {
    return { message: "Storage keys are state:<key> or data:<pointer under /data, such as /cart>" };
  }
  if (parsed.kind === "state") {
    const state = record(root.state) ?? {};
    return Object.hasOwn(state, parsed.key)
      ? { bytes: prototypeStorageEntryBytes(storageKey, state[parsed.key]) }
      : { message: `Storage key ${storageKey} is not declared in state` };
  }
  const clash = claimed.find((other) => pointersOverlap(other.pointer, parsed.pointer));
  if (clash) {
    return {
      message: `Storage key ${storageKey} overlaps storage.keys[${clash.index}]; list a data pointer once, or list its parent only`,
    };
  }
  claimed.push({ pointer: parsed.pointer, index });
  const value = resolvePrototypeDataPointer(root.data, parsed.pointer);
  return { bytes: value === undefined ? 0 : prototypeStorageEntryBytes(storageKey, value) };
}

const storageKeySchema = z.string().refine((key) => parsePrototypeStorageKey(key) !== undefined);
const byteCountSchema = z.number().int().safe().nonnegative();
const storageReportSchema = z.object({
  version: z.number().int().safe().min(1),
  keys: z.array(z.object({ key: storageKeySchema, bytes: byteCountSchema })),
  totalBytes: byteCountSchema,
  skippedKeys: z.array(storageKeySchema).optional(),
});

/**
 * Reads the device's per-prototype storage report (inspect). Anything malformed is dropped, not
 * guessed at, so the host reports the field absent rather than wrong.
 */
export function parsePrototypeStorageReport(value: unknown): PrototypeStorageReport | undefined {
  const parsed = storageReportSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  const { skippedKeys, ...report } = parsed.data;
  return skippedKeys?.length ? { ...report, skippedKeys } : report;
}

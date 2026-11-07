import { resolvePrototypeDataPointer } from "./prototypeData";
import { applyPrototypeDataWrite } from "./prototypeDataWrite";
import type { PrototypeData, PrototypeJson } from "./prototypeSpec";
import { parsePrototypeStorageKey, prototypeStorageBlock } from "./prototypeStorage";
import { record } from "./prototypeTemplate";
import contract from "../../../schemas/prototype-spec-contract.json";

/** The largest secure value, in UTF-8 bytes, a `storage.secure` key may hold (#14321). */
export const { MAX_PROTOTYPE_SECURE_VALUE_BYTES } = contract.limits;

/**
 * The precedence rules for a prototype's stored values on a show (#12522), as one pure function so
 * the device runtimes and the host agree. ADOPTED DECISION (the issue was labelled needs-decision;
 * the proposal is the decision), written up in docs/design-docs/plat/android/prototype-ux.md:
 *
 * - Stored values replace the spec's values for the keys the spec lists, unless `storage.version`
 *   differs from the version the values were stored under: then every stored value is discarded
 *   and the spec's values stand.
 * - A stored key the spec no longer lists is dropped; a spec with no `storage` block drops them all.
 * - A stored value that no longer fits the spec is dropped and the spec's value stands: a state
 *   value whose type (string, number, boolean) differs from the spec's, a state key the spec no
 *   longer declares, a data value of a different JSON kind than the spec's value at that pointer,
 *   or a data value `applyPrototypeDataWrite` refuses (a missing parent, a data limit).
 *
 * `dropped` tells the device which stored entries to delete. Restoring emits no `change` event.
 *
 * Secure keys (#14321, `storage.secure`) follow the same version and listing rules, read from the
 * device's Keystore/Keychain store instead of `values`:
 *
 * - A secure value is applied only to a key `storage.secure` lists, as a string of at most
 *   `MAX_PROTOTYPE_SECURE_VALUE_BYTES` UTF-8 bytes into a declared string state key; otherwise it is
 *   dropped as a mismatch.
 * - A plaintext stored value never fills a secure key: a key in `storage.secure` is not in
 *   `storage.keys`, so a plaintext copy of it is dropped as unlisted.
 * - A biometric-bound key (`secureAuth: "biometric"`) that holds a value is not read: its state
 *   holds `""` and it is listed in `locked` until a `biometric.authenticate` unlocks it, so
 *   `/platform/secureStorage/locked` is true while `locked` is non-empty.
 * - A key the store reports `invalidated` (its hardware key was revoked by biometric re-enrolment)
 *   lost its value: it is dropped with reason `invalidated` and the spec's value stands.
 */
export interface PrototypeStoredValues {
  /** The `storage.version` the values were stored under. */
  version: number;
  /** Stored values by storage key: `state:<key>`, `data:<pointer>` or `stack:<id>`. */
  values: Readonly<Record<string, unknown>>;
  /**
   * Values the device's secure store holds, by `state:<key>`. A biometric-bound key cannot be
   * decrypted before authentication, so its entry only marks that the key holds a value; its
   * content is not read.
   */
  secure?: Readonly<Record<string, unknown>>;
  /** Secure keys whose hardware key was invalidated, so their value can no longer be decrypted. */
  invalidated?: readonly string[];
}

export type PrototypeStorageDropReason = "version" | "unlisted" | "mismatch" | "invalidated";

export interface PrototypeStorageRestore {
  state: Record<string, string | number | boolean>;
  data: PrototypeData | undefined;
  /** Storage keys of the stored values that replaced the spec's. */
  applied: string[];
  /** Stored entries to delete, with why. */
  dropped: { key: string; reason: PrototypeStorageDropReason }[];
  /** Biometric-bound secure keys holding a value that waits for `biometric.authenticate`. */
  locked: string[];
}

interface RestoreSpec {
  state?: unknown;
  data?: unknown;
  storage?: unknown;
}

function jsonKind(value: unknown): string {
  if (Array.isArray(value)) {
    return "array";
  }
  return value === null ? "null" : typeof value;
}

/** The state value to keep for a stored value, or undefined when it does not fit the spec's state. */
function fittingState(
  state: Readonly<Record<string, unknown>>,
  key: string,
  stored: unknown,
): string | number | boolean | undefined {
  const declared = state[key];
  const fits =
    Object.hasOwn(state, key) &&
    typeof stored === typeof declared &&
    (typeof stored !== "number" || Number.isFinite(stored));
  return fits ? (stored as string | number | boolean) : undefined;
}

export function restorePrototypeStorage(
  spec: RestoreSpec,
  stored: PrototypeStoredValues | undefined,
): PrototypeStorageRestore {
  const specState = record(spec.state) ?? {};
  const result: PrototypeStorageRestore = {
    state: { ...specState } as PrototypeStorageRestore["state"],
    data: spec.data === undefined ? undefined : (structuredClone(spec.data) as PrototypeData),
    applied: [],
    dropped: [],
    locked: [],
  };
  if (!stored) {
    return result;
  }
  const block = prototypeStorageBlock(spec);
  const listed = new Set(block?.keys);
  const versionChanged = block !== undefined && block.version !== stored.version;
  restoreSecure(result, stored, { spec, specState, listed: block !== undefined, versionChanged });
  for (const [key, value] of Object.entries(stored.values)) {
    if (!listed.has(key)) {
      result.dropped.push({ key, reason: "unlisted" });
    } else if (versionChanged) {
      result.dropped.push({ key, reason: "version" });
    } else if (restoreOne(result, key, value, { specState, specData: spec.data })) {
      result.applied.push(key);
    } else {
      result.dropped.push({ key, reason: "mismatch" });
    }
  }
  return result;
}

interface SecureContext {
  spec: RestoreSpec;
  specState: Readonly<Record<string, unknown>>;
  /** False when the spec has no usable `storage` block: every secure value is then unlisted. */
  listed: boolean;
  versionChanged: boolean;
}

/** The context plus the keys `storage.secure` lists. */
type SecureScope = SecureContext & { secure: ReadonlySet<string> };

/** Applies the secure store's values: dropped, locked behind biometrics, or written into state. */
function restoreSecure(
  result: PrototypeStorageRestore,
  stored: PrototypeStoredValues,
  context: SecureContext,
): void {
  const storage = record(context.spec.storage);
  const secure = new Set(context.listed ? stringList(storage?.secure) : []);
  const invalidated = new Set(stored.invalidated ?? []);
  for (const key of invalidated) {
    result.dropped.push({ key, reason: "invalidated" });
  }
  const pending = Object.entries(stored.secure ?? {}).filter(([key]) => !invalidated.has(key));
  for (const [key, value] of pending) {
    restoreSecureOne(result, key, value, { ...context, secure });
  }
}

/** Drops one secure value, locks it behind biometrics, or writes it into state. */
function restoreSecureOne(
  result: PrototypeStorageRestore,
  key: string,
  value: unknown,
  context: SecureScope,
): void {
  const stateKey = secureStateKey(key);
  const reason = secureDropReason(key, value, context);
  if (reason || stateKey === undefined) {
    result.dropped.push({ key, reason: reason ?? "mismatch" });
  } else if (isBiometric(context.spec, key)) {
    result.state[stateKey] = "";
    result.locked.push(key);
  } else {
    result.state[stateKey] = value as string;
    result.applied.push(key);
  }
}

function isBiometric(spec: RestoreSpec, key: string): boolean {
  return record(record(spec.storage)?.secureAuth)?.[key] === "biometric";
}

/** Why a secure value cannot restore, or undefined when it fits (or waits for an unlock). */
function secureDropReason(
  key: string,
  value: unknown,
  { spec, specState, versionChanged, secure }: SecureScope,
): PrototypeStorageDropReason | undefined {
  if (!secure.has(key)) {
    return "unlisted";
  }
  if (versionChanged) {
    return "version";
  }
  const stateKey = secureStateKey(key);
  if (stateKey === undefined || typeof specState[stateKey] !== "string") {
    return "mismatch";
  }
  // A biometric-bound value is sealed until authentication; only its presence is known here.
  const sealed = isBiometric(spec, key);
  const fits =
    typeof value === "string" && Buffer.byteLength(value) <= MAX_PROTOTYPE_SECURE_VALUE_BYTES;
  return sealed || fits ? undefined : "mismatch";
}

/** The state key a `state:<key>` secure storage key names; only state keys can be secure. */
function secureStateKey(storageKey: string): string | undefined {
  const parsed = parsePrototypeStorageKey(storageKey);
  return parsed?.kind === "state" ? parsed.key : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * A stored stack path (#14188) lives in the device runtime, not in state or data: only its shape is
 * checked here, and the runtime starts the stack at `start` when its screens or params no longer
 * fit.
 */
function storedStackFits(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

/** Applies one stored value onto the restore; false leaves it untouched (the value does not fit). */
function restoreOne(
  result: PrototypeStorageRestore,
  storageKey: string,
  value: unknown,
  { specState, specData }: { specState: Readonly<Record<string, unknown>>; specData: unknown },
): boolean {
  if (storageKey.startsWith("stack:")) {
    return storedStackFits(value);
  }
  const parsed = parsePrototypeStorageKey(storageKey);
  if (parsed?.kind === "state") {
    const fitting = fittingState(specState, parsed.key, value);
    if (fitting === undefined) {
      return false;
    }
    result.state[parsed.key] = fitting;
    return true;
  }
  if (parsed?.kind !== "data" || value === null || value === undefined) {
    return false;
  }
  // Compare against the spec's own value, not the restore so far: an earlier stored key must not
  // change what "the spec's value" is for a later one.
  const authored = resolvePrototypeDataPointer(specData, parsed.pointer);
  if (authored !== undefined && jsonKind(authored) !== jsonKind(value)) {
    return false;
  }
  const written = applyPrototypeDataWrite(result.data, {
    op: "set",
    path: `/data${parsed.pointer}`,
    value: value as PrototypeJson,
  });
  if (!written.success) {
    return false;
  }
  result.data = written.data;
  return true;
}

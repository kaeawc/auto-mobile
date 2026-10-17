import { resolvePrototypeDataPointer } from "./prototypeData";
import { applyPrototypeDataWrite } from "./prototypeDataWrite";
import type { PrototypeData, PrototypeJson } from "./prototypeSpec";
import { parsePrototypeStorageKey, prototypeStorageBlock } from "./prototypeStorage";
import { record } from "./prototypeTemplate";

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
 */
export interface PrototypeStoredValues {
  /** The `storage.version` the values were stored under. */
  version: number;
  /** Stored values by storage key: `state:<key>` or `data:<pointer>`. */
  values: Readonly<Record<string, unknown>>;
}

export type PrototypeStorageDropReason = "version" | "unlisted" | "mismatch";

export interface PrototypeStorageRestore {
  state: Record<string, string | number | boolean>;
  data: PrototypeData | undefined;
  /** Storage keys of the stored values that replaced the spec's. */
  applied: string[];
  /** Stored entries to delete, with why. */
  dropped: { key: string; reason: PrototypeStorageDropReason }[];
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
  };
  if (!stored) {
    return result;
  }
  const block = prototypeStorageBlock(spec);
  const listed = new Set(block?.keys);
  const versionChanged = block !== undefined && block.version !== stored.version;
  for (const [key, value] of Object.entries(stored.values)) {
    if (!listed.has(key)) {
      result.dropped.push({ key, reason: "unlisted" });
    } else if (versionChanged) {
      result.dropped.push({ key, reason: "version" });
    } else if (restoreOne(result, key, value, specState, spec.data)) {
      result.applied.push(key);
    } else {
      result.dropped.push({ key, reason: "mismatch" });
    }
  }
  return result;
}

/** Applies one stored value onto the restore; false leaves it untouched (the value does not fit). */
function restoreOne(
  result: PrototypeStorageRestore,
  storageKey: string,
  value: unknown,
  specState: Readonly<Record<string, unknown>>,
  specData: unknown,
): boolean {
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

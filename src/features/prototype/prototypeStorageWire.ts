/**
 * The wire shapes of prototype storage (#12522, `prototype_storage_v1`). Kept out of
 * ctrlProxyProtocol.ts, which re-exports them, so that file does not keep growing.
 */

/**
 * Advertised by a device that persists a spec's `storage` block, reports stored keys in inspect and
 * answers `clear_prototype_storage`. Without it a spec using `storage` is refused.
 */
export const PROTOTYPE_STORAGE_CAPABILITY = "prototype_storage_v1";

/**
 * `@SerialName("clear_prototype_storage")` -> `ClearPrototypeStorage`. Wipes every stored value the
 * device keeps for prototype `id` (the `storage` block's keys). Answered by one `prototype_result`;
 * `cleared` counts the stored keys removed. Only sent to a device advertising
 * `prototype_storage_v1`. An id with nothing stored is a success with `cleared: 0`.
 */
export interface ClearPrototypeStorageMessage {
  type: "clear_prototype_storage";
  requestId: string;
  id: string;
}

export function clearPrototypeStorageMessage(args: {
  requestId: string;
  id: string;
}): ClearPrototypeStorageMessage {
  return { type: "clear_prototype_storage", requestId: args.requestId, id: args.id };
}

/**
 * The device-to-host report of a prototype's stored values, a per-prototype field of
 * `inspect_prototypes` entries (a flat field of the iOS agent status), present only from a device
 * advertising `prototype_storage_v1` for a prototype whose spec declares `storage`. `keys` lists only
 * keys that currently hold a stored value, in storage-key form (`state:darkMode`, `data:/cart`),
 * with the bytes each occupies (UTF-8 length of the key plus its compact JSON value); `totalBytes`
 * is their sum, bounded by `MAX_PROTOTYPE_STORAGE_BYTES`. `skippedKeys` lists keys whose latest value
 * was not stored because it would have exceeded that limit (the live value still applied).
 */
export interface PrototypeStorageReport {
  version: number;
  keys: { key: string; bytes: number }[];
  totalBytes: number;
  skippedKeys?: string[];
}

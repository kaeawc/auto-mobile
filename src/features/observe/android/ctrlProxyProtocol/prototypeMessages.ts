/** Prototype lifecycle requests, results and push-event contracts. */
import type { PrototypeHiddenReason } from "../../../prototype/prototypeHidden";
import type { PrototypePatchOp } from "../../../prototype/prototypePatch";
import type { PrototypePatchConflict } from "../../../prototype/prototypePatchWire";
import type { PrototypeSpec, PrototypeJson, PrototypeData } from "../../../prototype/prototypeSpec";

export type PrototypeState = NonNullable<PrototypeSpec["state"]>;
export interface ShowPrototypeMessage {
  type: "show_prototype";
  requestId: string;
  spec: PrototypeSpec;
  /** Android logical display; omitted for the default display. Requires prototype_display_id_v2. */
  displayId?: number;
  /**
   * Only `true` is sent. A show whose spec.id is the prototype on screen replaces it in place (pages
   * and display kept); `reset` starts it fresh. A device that predates it ignores the field and
   * always starts fresh, which is what `reset` asks for.
   */
  reset?: true;
  /** Only false is sent; retaining siblings requires prototype_multi_surface_v1. */
  replaceOthers?: false;
  /**
   * What "the system setting" means for this show: `light` or `dark` pins it, without changing the
   * device. Omitted for the device's own setting. Requires prototype_appearance_v1: an older device
   * ignores the field and follows the device silently, so it is never sent to one.
   */
  appearance?: PrototypeAppearanceOverride;
}
/** A fixed mode a show takes as the system setting; following the device is the absent field. */
export type PrototypeAppearanceOverride = "light" | "dark";
/** Which step of the resolution order decided a prototype's mode, highest precedence first. */
export type PrototypeAppearanceSource =
  | "explicit"
  | "roleLuminance"
  | "authoredBackground"
  | "override"
  | "system";
/**
 * The light or dark mode a shown prototype resolved to (`prototype_appearance_v1`). `deviceDark` is
 * the device's own setting whatever decided `mode`. Absent wherever a device lacks the capability.
 */
export interface PrototypeAppearance {
  mode: "light" | "dark";
  source: PrototypeAppearanceSource;
  deviceDark: boolean;
}
export type PrototypeDismiss = { id: string; all?: never } | { all: true; id?: never };
export type DismissPrototypeMessage = {
  type: "dismiss_prototype";
  requestId: string;
} & PrototypeDismiss;
/**
 * `@SerialName("inspect_prototypes")` → `InspectPrototypes`. Answered by one `prototype_result` carrying
 * `prototypes`; events the device buffered while no host was connected arrive first, as ordinary
 * `prototype_event` frames. Only sent to a device advertising `prototype_persistence_replay_v1`.
 */
/** `@SerialName("patch_prototype")` → `PatchPrototype`. Only sent to a device advertising `prototype_patch_v1`. */
export interface PatchPrototypeMessage {
  type: "patch_prototype";
  requestId: string;
  id: string;
  baseRevision?: number;
  ops: readonly PrototypePatchOp[];
}
export const PROTOTYPE_PATCH_CAPABILITY = "prototype_patch_v1";

export const PROTOTYPE_SAVED_CAPABILITY = "prototype_saved_v1";

/** `@SerialName("save_prototype")` → `SavePrototype`. */
export interface SavePrototypeMessage {
  type: "save_prototype";
  requestId: string;
  spec: PrototypeSpec;
  label: string;
  icon?: string;
}
/** `@SerialName("list_saved_prototypes")` → `ListSavedPrototypes`. */
export interface ListSavedPrototypesMessage {
  type: "list_saved_prototypes";
  requestId: string;
}
/** `@SerialName("delete_saved_prototype")` → `DeleteSavedPrototype`. */
export interface DeleteSavedPrototypeMessage {
  type: "delete_saved_prototype";
  requestId: string;
  id: string;
}
export interface PinSavedPrototypeMessage {
  type: "pin_saved_prototype";
  requestId: string;
  id: string;
  icon?: string;
}
export interface SavedPrototypePinInfo {
  id: string;
  status: "requested" | "already_pinned";
  shortcut?: SavedPrototypeShortcutUpdate;
}
export type SavedPrototypeShortcutUpdate = "updated" | "rate_limited";
export interface SavedPrototypeInfo {
  id: string;
  slug: string;
  replaced: boolean;
  shortcut?: SavedPrototypeShortcutUpdate;
}
export interface SavedPrototypeEntry {
  id: string;
  label: string;
  slug: string;
  savedAt: number;
  pinned: boolean;
}
export const SAVED_PROTOTYPE_ERROR_CODES = [
  "pin_unsupported",
  "device_locked",
  "pin_failed",
  "invalid_id",
  "invalid_label",
  "spec_too_large",
  "invalid_spec",
  "invalid_asset_id",
  "duplicate_asset_id",
  "unsupported_mime_type",
  "empty_asset",
  "asset_too_large",
  "count_limit",
  "total_limit",
  "missing_asset",
  "saved_count_limit",
  "storage_failure",
  "unsupported_existing",
  "not_found",
  "unsupported_format",
  "internal_error",
] as const;
export type SavedPrototypeErrorCode = (typeof SAVED_PROTOTYPE_ERROR_CODES)[number];
export function isSavedPrototypeErrorCode(value: unknown): value is SavedPrototypeErrorCode {
  return (
    typeof value === "string" && (SAVED_PROTOTYPE_ERROR_CODES as readonly string[]).includes(value)
  );
}

export interface InspectPrototypesMessage {
  type: "inspect_prototypes";
  requestId: string;
}
/**
 * `@SerialName("put_prototype_asset")` → `PutPrototypeAsset`. `dataBase64` is the encoded image file
 * (PNG, JPEG or WebP) in standard base64 without line breaks, sent in the one JSON text frame like
 * screenshots. Replaces any asset with the same id. Answered by one `prototype_result`.
 */
export interface PutPrototypeAssetMessage {
  type: "put_prototype_asset";
  requestId: string;
  id: string;
  mimeType: string;
  dataBase64: string;
}
/** `@SerialName("remove_prototype_asset")` → `RemovePrototypeAsset`. Idempotent on the device. */
export interface RemovePrototypeAssetMessage {
  type: "remove_prototype_asset";
  requestId: string;
  id: string;
}

export interface AdvancePrototypeClockMessage {
  type: "advance_prototype_clock";
  requestId: string;
  id: string;
  advanceTimeMs: number;
}
export interface PrototypeResult {
  fired?: number;
  saved?: SavedPrototypeInfo;
  pin?: SavedPrototypePinInfo;
  savedPrototypes?: SavedPrototypeEntry[];
  errorCode?: SavedPrototypeErrorCode | (string & {});
  hiddenReason?: PrototypeHiddenReason;
  /** Only the reply to patch_prototype from a device advertising prototype_patch_v1. */
  revision?: number;
  /** Only the reply to patch_prototype from a device advertising prototype_patch_v1. */
  conflict?: PrototypePatchConflict;
  success: boolean;
  totalTimeMs?: number;
  error?: string | null;
  requestId?: string;
  timestamp?: number;
  /**
   * Warning, not a failure: after a successful show_prototype, the asset ids the
   * spec references that the device has no copy of (never uploaded, or cleared since), so the
   * host can re-upload them. Absent when nothing is missing and on devices that predate it.
   */
  missingAssets?: string[];
  /** Only the reply to `inspect_prototypes`: the prototypes the device is showing right now. */
  prototypes?: PrototypeStatusEntry[];
  stacks?: Record<string, { path: string[]; depth: number }>;
  /** Only with `prototypes`: events the device dropped from its offline buffer since it started. */
  droppedEvents?: number;
  /** Only a successful `show_prototype` reply from a device advertising prototype_appearance_v1. */
  appearance?: PrototypeAppearance;
  /** Only the reply to `clear_prototype_storage`: how many stored keys were removed. */
  cleared?: number;
  /**
   * Warning, not a failure (prototype_effects_v1): `style.effects` entries the device did not draw,
   * with `reason` "api" (below the effect's API floor) or "budget" (froze over the frame budget).
   * Absent when every effect renders and on devices that predate it.
   */
  degradedEffects?: PrototypeDegradedEffect[];
}

/** One `style.effects` entry the device omitted or froze (#15129). */
export interface PrototypeDegradedEffect {
  path: string;
  type: string;
  reason: string;
}

/** One prototype the device reported to `inspect_prototypes`. `id` is the prototype id (its spec id). */
export interface PrototypeStatusEntry {
  /** Agent-owned read-only content of the shown spec; absent when it has none. */
  data?: PrototypeData;
  id: string;
  /** True for `window.persistence: "device"`. */
  persistent: boolean;
  state: PrototypeState;
  pages: Record<string, number>;
  stacks?: Record<string, { path: string[]; depth: number }>;
  /** Highest `prototype_event` sequence the device allocated for this prototype; no rewind. */
  lastSequence: number;
  /** True while the prototype's app is not in front: hidden, state kept, back with the app. */
  suspended?: boolean;
  hiddenReason?: PrototypeHiddenReason;
  /** The mode it is drawn in right now; only from a device advertising prototype_appearance_v1. */
  appearance?: PrototypeAppearance;
  /** Device-reported `storage` block state (prototype_storage_v1, #12522); parsePrototypeStorageReport validates it. */
  storage?: unknown;
  timers?: unknown;
  /** Last haptic and sound calls (prototype_platform_haptics_v1, _sound_v1); parsePrototypeFeedbackLog validates it. */
  feedbackLog?: unknown;
}

/**
 * Outcome of a prototype asset upload or removal. `dispatched` is true once the frame was written
 * to the socket; `acknowledged` is true only when the device answered (success or refusal). A
 * dispatched, unacknowledged request is indeterminate: the device may or may not have applied it.
 */
export interface PrototypeAssetResult extends PrototypeResult {
  dispatched: boolean;
  acknowledged: boolean;
}

/**
 * Event kinds this host understands. `page_changed` has the pager id as `name` and the new
 * zero-based page index as its payload, on Android and iOS (#11409); the `pages` map of the event
 * carries every pager. `appearance_changed` (`prototype_appearance_v1`) has a null `name` and the
 * payload `{mode, source}`.
 */
export const PROTOTYPE_EVENT_KINDS = [
  "emit",
  "page_changed",
  "screen_changed",
  "dismissed",
  "appearance_changed",
  "change",
  "validation_failed",
] as const;
export type PrototypeEventKind = (typeof PROTOTYPE_EVENT_KINDS)[number];
/**
 * Host-side stand-in for a kind a newer device sent that this host does not know. Such an event
 * carries only `id`, `sequence` and `timestamp` from the wire: it advances the sequence ledger and
 * is never buffered, recorded or returned by awaitEvent.
 */
export const UNKNOWN_PROTOTYPE_EVENT_KIND = "unknown";

/** Id-less push; pager selection has its own namespace, separate from authored state. */
export interface PrototypeEvent {
  type: "prototype_event";
  timestamp: number;
  id: string;
  /**
   * Emitter contract: per prototype id, monotonic starting at 1; reconnects must not reset it.
   * Hosts should treat lower-or-equal sequences for the same id as duplicates.
   */
  sequence: number;
  kind: PrototypeEventKind | typeof UNKNOWN_PROTOTYPE_EVENT_KIND;
  /** change: current validity for checked state keys. */
  validity?: Record<string, boolean>;
  /** validation_failed: failing keys from an atomic requireValid guard. */
  keys?: string[];
  name: string | null;
  payload: PrototypeJson;
  context?: Record<string, PrototypeJson>;
  contextTruncated?: true;
  state: PrototypeState;
  pages: Record<string, number>;
  stacks?: Record<string, { path: string[]; depth: number }>;
}

import type { LayoutWarning, LayoutWarningsScope } from "../../../../models/ObservationInsets";
import type { ObserveResult, SkeletonElement } from "../../../../models/ObserveResult";
import type { ViewHierarchyNode } from "../../../../models/ViewHierarchyResult";

/* --------------------------------------------------------------------------
 * Observation diff (issue #2761 — `--actions-diff-observe`)
 *
 * With the flag on, a non-observe action emits only the *diff* of its
 * post-action observation against the previous one, instead of the full
 * embedded observation. Both sides are the already-sanitized ObserveResult
 * (the finalize hook stores the sanitized observation as the baseline), so the
 * diff compares like-for-like node shapes.
 * ------------------------------------------------------------------------ */

/**
 * A real, `tapOn`-usable selector recovered for a diff node/change (issue
 * #6221 item 4.3). Same vocabulary the `skeleton` rows use — `elementId`
 * (`resource-id ?? view-id`) and `label` (`text ?? content-desc`) — derived
 * with the identical precedence {@link deriveDiffSelector} applies, so a
 * client that already knows how to act on a skeleton row knows how to act on
 * a diff entry. Omitted when the node's attributes carry neither.
 */
export interface ObserveDiffSelector {
  elementId?: string;
  label?: string;
  /**
   * Replay disambiguator from the next observation's own skeleton projection.
   * Promoted children share their matching owner's slot. Omitted when the
   * selector cannot be proved to identify a projected row. Duplicate selectors
   * without a safe index carry `ambiguous: true`. Unique selectors carry neither field.
   */
  index?: number;
  /** A duplicate selector whose replay index cannot safely be emitted. */
  ambiguous?: boolean;
}

/**
 * A single node in an observation diff. `attributes` are the node's own
 * (non-child) attributes — for `added`/`removed` the full attribute set, so the
 * consumer can reconstruct the node without the baseline.
 *
 * No separate `selector` field here (issue #6221 item 4.3): `attributes`
 * already carries `resource-id` / `view-id` / `text` / `content-desc`
 * directly, so `attributes["resource-id"] ?? attributes["view-id"]` /
 * `attributes["text"] ?? attributes["content-desc"]` — the same precedence
 * `skeleton` rows use — IS the real selector. A synthesized duplicate field
 * would just double those bytes on the wire for no new information (see
 * {@link ObserveDiffNodeChange.selector}, which earns its keep precisely
 * because `changed` entries do NOT carry full attributes).
 */
export interface ObserveDiffNode {
  /**
   * INTERNAL positional identity key: `resource-id \0 bounds \0 text \0
   * sibling-index`. NOT a selector (issue #6221 item 4.3) — it is capture-order
   * plumbing for pairing nodes across two observations, not a stable handle a
   * client should act on. Read a real selector off `attributes` instead (see
   * above), or act on a `skeleton` row.
   */
  key: string;
  /**
   * Full-mode diffs retain the raw hierarchy attributes. Skeleton-mode diffs
   * carry the compact skeleton row fields instead and omit zero-affordance
   * nodes, while preserving this entry's positional {@link key}.
   */
  attributes: Record<string, unknown>;
}

/** A node matched by key whose non-key attributes changed. */
export interface ObserveDiffNodeChange {
  /** INTERNAL positional identity key — see {@link ObserveDiffNode.key}. NOT a selector. */
  key: string;
  /**
   * The node's key on the *baseline* side, present only on entries produced by
   * content-identity **re-pairing** (issue #3088 limitation 2, #3107). A re-pair
   * collapses a leftover remove+add into one `changed`; its `key` is the
   * post-move (added-side) key, so a consumer that wants to locate the node in
   * the baseline needs the pre-move key too. Absent on positionally-matched
   * entries, whose baseline and next keys are identical (so `key` already serves
   * both sides).
   */
  fromKey?: string;
  /** Real, tapOn-usable selector recovered for this entry, when available (issue #6221 item 4.3). */
  selector?: ObserveDiffSelector;
  /** Per-attribute `{ from, to }`; a missing side is `undefined`. */
  changes: Record<string, { from?: unknown; to?: unknown }>;
}

/**
 * Compact diff of one observation against a baseline. `isDiff` is a discriminant
 * so a consumer can tell a diff apart from a full `ObserveResult` (which has no
 * such marker). Empty `added`/`removed`/`changed` and absent `fields` means the
 * screen is unchanged.
 *
 * `skeleton` and `context` are populated by the `finalizeToolResponse` call site
 * — never by {@link diffObserveResult} itself, which only ever sees the full
 * sanitized tree — so that an agent-facing diff ALWAYS carries a usable
 * actionable-only selector surface alongside it (issue #6221 item 4.1), the same
 * arrays a full observation's `.skeleton` / `.context` carry (issue #6256: a
 * diff must not silently drop the non-actionable state readout `context` keeps
 * that `skeleton` alone cannot represent, e.g. a timer countdown or a toggle's
 * current state text).
 */
export interface ObserveDiff {
  keyboard?: ObserveResult["keyboard"];
  isDiff: true;
  /**
   * The post-action observation's identifier, used to join this diff to its
   * observation-scoped screenshot resource. Populated by the
   * `finalizeToolResponse` call site, not by {@link diffObserveResult}.
   */
  observationId?: string;
  /**
   * The concrete device the post-action observation ran against (issue #7018),
   * copied verbatim from the observation by the `finalizeToolResponse` call site
   * so a diff-mode client has the same `deviceId` a full observation carries and
   * can build the observation-scoped screenshot resource URI.
   */
  deviceId?: string;
  /** Physical panel represented by the post-action observation. */
  display?: ObserveResult["display"];
  /** Physical panel or posture change since the diff baseline; generation alone is ignored. */
  displayChanged?: {
    from: Pick<ObserveResult["display"], "key" | "role" | "posture">;
    to: Pick<ObserveResult["display"], "key" | "role" | "posture">;
  };
  /**
   * Fully-encoded observation-scoped screenshot resource URI for the post-action
   * observation (issue #7018), built from `deviceId` + `observationId` via the
   * shared encoder and stamped by the `finalizeToolResponse` call site, so a
   * diff-mode client gets the same ready-to-read resource URI as a full one.
   */
  observationScreenshotResourceUri?: string;
  screenshotSettled?: boolean;
  screenshotSettledError?: string;
  screenshotOrientation?: "native" | "display";
  /** Full screenshot raster as written, including encoding/downscaling. */
  screenshotImageSize?: { width: number; height: number };
  screenshotPixelsPerNativeUnit?: { x: number; y: number };
  screenshotScaleProvenance?: "raster-dimensions" | "native-scale-confirmed";
  screenshotPath?: string;
  screenshotSource?: "fresh" | "cached";
  screenshotCaptureSource?: "device" | "observation-cache";
  screenshotCapturedAt?: string;
  screenshotAgeMs?: number;
  screenshotFreshFailure?: { code: string; message: string; retryable: boolean };
  screenshotFormat?: "png" | "jpeg" | "webp";
  screenshotMimeType?: "image/png" | "image/jpeg" | "image/webp";
  /**
   * Actionable-only selector surface (issue #6221 items 1 and 4.1), ALWAYS
   * present alongside the diff — the same array a full observation's
   * `.skeleton` carries. Populated by the `finalizeToolResponse` call site from
   * the post-action observation, not by {@link diffObserveResult}.
   */
  skeleton: SkeletonElement[];
  /**
   * Non-actionable state-readout rows from the same projection as `skeleton`
   * (issue #6221 item 1, #6256), present only when at least one such row
   * survived. Populated by the `finalizeToolResponse` call site alongside
   * `skeleton`, not by {@link diffObserveResult} — without this a diff-mode
   * response (`--actions-diff-observe`) carries `skeleton` but silently drops
   * every zero-affordance readout (a timer countdown, a toggle's state text),
   * leaving a client unable to tell a failed input from a successful one.
   */
  context?: SkeletonElement[];
  /**
   * Same name/shape as a full observation's `activeWindow` (issue #6258).
   * Populated by the `finalizeToolResponse` call site from the post-action
   * observation, not by {@link diffObserveResult} — without this a client has
   * no single accessor for "what screen am I on" across full and diff modes.
   */
  activeWindow?: ObserveResult["activeWindow"];
  /**
   * Same name/shape as a full observation's `freshness` (issue #6258).
   * Populated by the `finalizeToolResponse` call site from the post-action
   * observation, not by {@link diffObserveResult} — without this a client has
   * no single accessor for "is this capture fresh" across full and diff modes.
   */
  freshness?: ObserveResult["freshness"];
  /**
   * Same name/shape as a full observation's platform-native `screenSize`.
   * Populated by the `finalizeToolResponse` call site from the post-action
   * observation, not by {@link diffObserveResult}, so diff and full modes use
   * the same coordinate space.
   */
  screenSize?: ObserveResult["screenSize"];
  /**
   * Why the accessibility audit did not run for this capture (issue #6926).
   * Populated by the `finalizeToolResponse` call site from the post-action
   * observation, not by {@link diffObserveResult}, so clients receive the
   * same capture-provenance metadata in full and diff modes.
   */
  accessibilityAuditSkipped?: ObserveResult["accessibilityAuditSkipped"];
  /**
   * Why the captured hierarchy is incomplete — the same top-level field a
   * skeleton-projected full observation carries (issue #6601). A diff REPLACES
   * the projected observation, so without this the provenance the projection
   * lifted out of `viewHierarchy` is dropped with it and a capped `skeleton`
   * reads as a complete one. Populated by the `finalizeToolResponse` call site
   * from the post-action observation, not by {@link diffObserveResult}.
   */
  truncationReasons?: string[];
  /** Window attribution from the current capture only, never the baseline. */
  windowTruncations?: ObserveResult["windowTruncations"];
  /**
   * Whether the observation this diff was computed from passed the
   * embedded-observation stability gate (issue #6866). Populated by the
   * `finalizeToolResponse` call site from the post-action observation, not by
   * {@link diffObserveResult} — without it a diff-mode client could not tell a
   * settled capture from a half-inflated one.
   */
  settled?: boolean;
  /** Same as a full observation's `settleMs` (#9591); copied from the post-action observation. */
  settleMs?: number;
  /** Same as a full observation's `settlePolls` (#9591); copied from the post-action observation. */
  settlePolls?: number;
  added: ObserveDiffNode[];
  removed: ObserveDiffNode[];
  changed: ObserveDiffNodeChange[];
  /**
   * Changed top-level fields: scalars (`rotation`, `wakefulness`, …) and the
   * Element mirror fields (`focusedElement`, `accessibilityFocusedElement`,
   * `awaitedElement` — #3052), each as `{from, to}`. In skeleton mode only,
   * `layoutWarnings` is a per-entry `{added, removed}` pair after system UI
   * status-bar chrome is excluded, with sparse envelope deltas when completeness
   * metadata changes.
   */
  fields?: Record<
    string,
    | { from?: unknown; to?: unknown }
    | {
        added: LayoutWarning[];
        removed: LayoutWarning[];
        scope?: { from?: LayoutWarningsScope; to?: LayoutWarningsScope };
        total?: { from?: number; to?: number };
      }
  >;
}

export interface DiffObserveConfig {
  /** Compact output suppresses captured IME subtrees; full/raw diffs retain them. */
  collapseKeyboard?: boolean;
  /**
   * Compact output drops the SystemUI status bar (signal, clock, battery) from the
   * diff basis: its churn is not a screen change and nothing in it is actionable (#11637).
   */
  skipStatusBar?: boolean;
  /** Skeleton-only per-warning layout diff; defaults to the full `{from,to}` envelope. */
  layoutWarningsDiffMode?: "full" | "perEntry";
  /** Skeleton-only projection for added/removed nodes; defaults to raw attributes. */
  projectAddedRemoved?: boolean;
  /**
   * Top-level scalar ObserveResult fields to diff. Defaults to
   * `DIFF_SCALAR_FIELDS`. `updatedAt` is deliberately excluded from the default
   * — it changes on every capture and would be pure noise.
   */
  scalarFields?: readonly string[];
  /**
   * Top-level Element mirror fields to diff (bounds-tolerant). Defaults to
   * `DIFF_ELEMENT_FIELDS`. Emitted into the same `fields` map as scalars.
   */
  elementFields?: readonly string[];
  /**
   * Content-hash node identity (issue #3053). Default **on**. The positional
   * `pathKey` is sensitive to reindexing: a scroll or a mid-list insert shifts
   * every following node's bounds/sibling index, so whole rows surface as
   * remove+add. When on, after positional matching, a leftover *removed* node and
   * a leftover *added* node are re-paired as a single `changed` entry when they
   * share a stable content key (`resource-id / view-id / content-desc / text` —
   * NO bounds, NO sibling index) that is **unique among the leftovers on both
   * sides**. Uniqueness-on-both-sides guarantees exactly one candidate each side,
   * so distinct content can never false-merge; an empty content key (no stable
   * identity) never re-pairs. Purely additive — it only re-pairs nodes positional
   * matching already left unpaired, so cross-subtree collisions stay disambiguated
   * by the path key. Set `false` for exact positional-only behavior.
   *
   * iOS adds one narrower repair pass under this same gate: editable controls
   * (`XCUIElementTypeTextField` / `TextView` / `SearchField`) with a stable
   * accessibility identifier and quantized screen region may re-pair across
   * text/value edits. Reused table/collection cell classes opt out.
   */
  contentIdentity?: boolean;
}

/**
 * Top-level scalar ObserveResult fields worth diffing. Intentionally excludes
 * `updatedAt` (churns every capture) and object/array fields (`viewHierarchy`
 * is covered by the node diff; `elements` mirrors the hierarchy). Advisory
 * `layoutWarnings` is the intentional exception: it has no hierarchy-diff
 * representation and must survive action observations.
 *
 * `awaitDuration` (#3052) is a scalar with no hierarchy equivalent — it is the
 * wait outcome for an `observe waitFor` surfaced through a non-observe action —
 * so it is diffed here. It is not churn like `updatedAt`: it is present only on
 * wait results, so an unchanged action carries `undefined` on both sides.
 */
export const DIFF_SCALAR_FIELDS: readonly string[] = [
  "rotation",
  "wakefulness",
  "userId",
  "intentChooserDetected",
  "notificationPermissionDetected",
  "deviceLock",
  "deviceLockUnknown",
  "awaitTimeout",
  "awaitDuration",
  "timeoutReason",
  "layoutWarnings",
  "error",
];

/**
 * Top-level Element *mirror* fields on ObserveResult (#3052). Each holds an
 * `Element` (or is absent). A focus/await change is reflected in the hierarchy
 * nodes (a node's `focused` / `accessibility-focused` attribute flips), but a
 * consumer that reads the top-level mirror off an action's diff would not see
 * it — the diff replaces the whole `.observation`. So these are diffed into the
 * same `fields` map, emitting `{from,to}` when they change (a focus gain reads
 * as `{from: undefined, to: element}`, a loss as `{from: element, to:
 * undefined}`). `awaitedElement` in particular has no wait-outcome equivalent
 * in the hierarchy, which is the primary motivation for the issue.
 */
export const DIFF_ELEMENT_FIELDS: readonly string[] = [
  "focusedElement",
  "accessibilityFocusedElement",
  "awaitedElement",
];

/** A flattened node used for keyed positional diffing. */
export interface FlatObserveNode {
  /** Captured source identity for shared selector ranking; never emitted. */
  source: ViewHierarchyNode;
  /**
   * Globally-positional match key: the chain of every ancestor's local key plus
   * this node's own (depth-joined). Two nodes in *different* subtrees that share
   * a local key — same resource-id/bounds/text/sibling index, common for
   * repeated list cells — get distinct path keys, so they never collide and
   * mis-pair. Used for matching, never emitted.
   */
  pathKey: string;
  /** This node's own local key (resource-id + bounds + text + sibling index), for display. */
  key: string;
  attributes: Record<string, unknown>;
  ancestorClasses: readonly string[];
}

export interface DiffRepairNode extends ObserveDiffNode {
  pathKey: string;
  ancestorClasses: readonly string[];
}

import { createHash } from "crypto";

/**
 * Capture-layer stable node identity for id-less Android nodes (issue #3228).
 *
 * The Android CtrlProxy runner (`ViewHierarchyExtractor.kt`) fills `view-id`
 * with the `resource-id` when one exists, and otherwise with a deterministic
 * UUID derived from the node's *tree path* (ancestor child indices +
 * resource-ids). That path is positional: a list scroll shifts every row's
 * child index, so a moved row gets a *different* UUID — and, worse, the row
 * that now occupies the old slot gets the *same* UUID as the departed one.
 * The diff layer's content-identity re-pair (`contentIdentityKey` in
 * `ObserveResultOutput.ts`) therefore can never re-pair id-less/text-less rows
 * across a scroll: their only candidate id churns with position. That is the
 * residual "opaque remove+add cascade" quantified in
 * `docs/design-docs/plat/android/actions-diff-observe-signoff.md` §4.
 *
 * This module rewrites those *generated* (UUID-shaped) `view-id`s at TS
 * ingest into a **content-derived** stable id: a Merkle-style SHA-256 over the
 * node's own stable content fields plus its children's content hashes —
 * deliberately excluding everything a scroll or interaction perturbs (bounds,
 * sibling position, `extras`, focus/checked/occlusion state). The same row
 * therefore keeps the same id before and after a scroll, and two rows with
 * different content can never share one.
 *
 * Content-identical duplicates (repeated spacer rows, empty Compose click
 * surfaces) share a hash by construction, so the k-th duplicate (document
 * order) gets an ordinal `-k` suffix — and, critically, so does the FIRST
 * (`-1`): whenever a hash occurs more than once in a capture, EVERY occurrence
 * is ordinal-suffixed, and the bare `s-<hash>` form is emitted only for a hash
 * that occurs exactly once. That keeps `view-id` unique within a capture (a
 * property the path UUIDs provided) and lets the diff layer's
 * uniqueness-on-both-sides guard re-pair duplicates in encounter order — the
 * same best-effort heuristic `diffObserveResult` already applies to identical
 * same-path siblings. Distinct rows still cannot false-merge: an ordinal only
 * ever disambiguates nodes whose *entire* stable subtree content is identical.
 *
 * Reserving the bare form for genuinely-unique content is what makes a bare id
 * safe to trust across a capture boundary (issue #6229). Previously the first
 * of a duplicate pair `[A, B]` took the bare `s-<hash>` and `B` took `-2`; when
 * `A` was then removed before the next capture, `B` became the sole survivor
 * and was reassigned that same bare `s-<hash>` — so a caller who had observed
 * `A`'s bare id silently retargeted `B` (a content-identical peer the caller
 * never selected). Emitting `-1` for `A` instead means the id a caller observes
 * for a member of a duplicate group is never the bare form, so the reassigned
 * survivor's bare id can no longer collide with it: the stale selector misses
 * (or, while ≥2 peers remain, `ElementFinder`'s ambiguity guard rejects it)
 * rather than acting on the wrong node. The bare `s-<hash>` invariant is now
 * "this content was unique when observed".
 *
 * Rewriting at ingest (rather than in the Kotlin extractor) means it applies
 * to every already-released runner — the runner APK is a pinned release, so a
 * Kotlin-side change would not reach devices until the next re-cut. If the
 * extractor later emits content-derived ids natively they just won't match
 * the UUID shape and will pass through untouched.
 */

/**
 * Shape of the runner's *generated* `view-id` (see
 * `ViewHierarchyExtractor.generateDeterministicUuid`): the first 16 bytes of a
 * SHA-256 formatted as a lowercase hex UUID. A real Android `resource-id`
 * (`package:id/name`) can never match. Only ids matching this shape are
 * rewritten, so resource-id-backed `view-id`s and any future non-UUID formats
 * pass through untouched (which also makes the rewrite idempotent — the
 * emitted `s-…` ids do not match).
 */
export const GENERATED_VIEW_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Versioned prefix for content-derived ids. The previous `s-<hash>` namespace
 * issued a bare id to the first member of a duplicate group; a later singleton
 * can reproduce that unsafe id after an upgrade. A new namespace makes every
 * post-upgrade selector disjoint from those legacy bare ids.
 */
export const STABLE_VIEW_ID_PREFIX = "s2-";

/**
 * Fixed hex-character width of the content hash this module emits (see the
 * `.slice(0, ...)` in `assign` below). Exported so consumers that need to
 * recognize the producer's exact id shape - e.g. `ElementFinder`'s
 * synthetic-vs-real-resource-id disambiguation (issue #6218 review) - read it
 * from here rather than guessing/duplicating the width.
 */
export const STABLE_VIEW_ID_HASH_LENGTH = 16;

/**
 * Node fields that participate in the content hash: the stable, position-free
 * description of what the node *is*. Everything else is deliberately excluded:
 * `bounds` and sibling order shift on scroll; `focused` / `checked` /
 * `selected` / `enabled` flip on interaction (a toggle should surface as a
 * `changed` delta, not an identity change); `extras` and
 * `occlusionState`/`occludedBy`/`occludedByViewId` churn nondeterministically
 * between captures (#3051, #3519).
 */
const CONTENT_FIELDS: readonly string[] = ["resource-id", "content-desc", "text", "test-tag"];

/** Normalize the `node` child slot (absent / single object / array) to an array. */
function toChildArray(node: Record<string, unknown>): Record<string, unknown>[] {
  const children = node["node"];
  if (!children) {
    return [];
  }
  const arr = Array.isArray(children) ? children : [children];
  return arr.filter((c): c is Record<string, unknown> => !!c && typeof c === "object");
}

/**
 * Rewrite every generated (UUID-shaped) `view-id` under `root` — in place —
 * into a content-derived stable id: `s-<hash16>` for a node whose content hash
 * is UNIQUE in the capture, and `s-<hash16>-<k>` (document-order, 1-based) for
 * EVERY node in a content-identical duplicate group — including the first,
 * which takes `-1` rather than the bare form (issue #6229). Reserving the bare
 * form for unique content keeps a reassigned survivor's bare id from silently
 * colliding with a suffixed id a caller observed for a since-removed peer.
 * Nodes whose `view-id` is absent or not UUID-shaped (resource-id-backed ids,
 * already-stable ids) are left untouched, so the pass is a no-op on
 * non-CtrlProxy hierarchies and idempotent on its own output. Accepts the
 * converted hierarchy root (or any node-like object); a non-object input is
 * ignored.
 */
export function assignStableViewIds(root: unknown): Map<string, string> {
  if (!root || typeof root !== "object") {
    return new Map();
  }
  if (Array.isArray(root)) {
    // A multi-root capture: each root is an independent tree, but duplicates
    // are still suffixed per tree here (roots are processed independently) —
    // acceptable because the Android converter emits a single root object.
    for (const item of root) {
      assignStableViewIds(item);
    }
    return new Map();
  }
  const rootNode = root as Record<string, unknown>;

  // Pass 1 (bottom-up): Merkle content hash per node — own stable fields plus
  // the *hashes* of the children, so cost stays O(n) instead of concatenating
  // whole subtrees at every level.
  const contentHash = new Map<Record<string, unknown>, string>();
  const compute = (node: Record<string, unknown>): string => {
    const childHashes = toChildArray(node).map(compute);
    // JSON-encoding the field array keeps values from straddling separator
    // boundaries (text can contain any delimiter we might pick by hand).
    const canonical = JSON.stringify([
      node["class"] ?? node.className ?? "",
      ...CONTENT_FIELDS.map((field) => node[field] ?? ""),
      childHashes,
    ]);
    const hash = createHash("sha256")
      .update(canonical)
      .digest("hex")
      .slice(0, STABLE_VIEW_ID_HASH_LENGTH);
    contentHash.set(node, hash);
    return hash;
  };
  compute(rootNode);

  // Pass 2a (pre-order): count, per content hash, how many nodes this pass will
  // actually rewrite. A hash rewritten more than once is a content-identical
  // duplicate group; one rewritten exactly once is unique content. Only
  // rewritten (generated-view-id) nodes count — a resource-id-backed node that
  // happens to share a content hash is left untouched and never competes for
  // the bare form.
  const rewrittenCounts = new Map<string, number>();
  const countRewritten = (node: Record<string, unknown>): void => {
    const viewId = node["view-id"];
    if (typeof viewId === "string" && GENERATED_VIEW_ID_PATTERN.test(viewId)) {
      const hash = contentHash.get(node)!;
      rewrittenCounts.set(hash, (rewrittenCounts.get(hash) ?? 0) + 1);
    }
    for (const child of toChildArray(node)) {
      countRewritten(child);
    }
  };
  countRewritten(rootNode);

  // Pass 2b (pre-order): assign ids. A hash that occurs once gets the bare
  // `s-<hash>` form; a content-identical duplicate group gets a 1-based
  // document-order ordinal on EVERY member — including the first (`-1`) — so
  // the bare form is reserved for unique content and can never be silently
  // reassigned to a since-removed peer's suffixed id (issue #6229). Ordinals
  // stay unique within the capture, preserving the diff layer's encounter-order
  // re-pair of duplicates.
  const occurrences = new Map<string, number>();
  const rewrittenViewIds = new Map<string, string>();
  const assign = (node: Record<string, unknown>): void => {
    const viewId = node["view-id"];
    if (typeof viewId === "string" && GENERATED_VIEW_ID_PATTERN.test(viewId)) {
      const hash = contentHash.get(node)!;
      const seen = (occurrences.get(hash) ?? 0) + 1;
      occurrences.set(hash, seen);
      const isDuplicateGroup = (rewrittenCounts.get(hash) ?? 0) > 1;
      const stableViewId = isDuplicateGroup
        ? `${STABLE_VIEW_ID_PREFIX}${hash}-${seen}`
        : `${STABLE_VIEW_ID_PREFIX}${hash}`;
      node["view-id"] = stableViewId;
      rewrittenViewIds.set(viewId, stableViewId);
    }
    for (const child of toChildArray(node)) {
      assign(child);
    }
  };
  assign(rootNode);

  // Keep occlusion links pointing at the final emitted hierarchy ids. The
  // runner fills occludedByViewId from the occluding node's pre-ingest view-id;
  // generated UUID ids are rewritten above, so references to those ids must
  // follow the same rewrite.
  applyStableViewIdRewrites(rootNode, rewrittenViewIds);
  return rewrittenViewIds;
}

/**
 * Apply a view-id rewrite map produced from a related hierarchy tree. This keeps
 * mirror nodes (for example `accessibility-focused-element`) linked to the exact
 * ids emitted in the full hierarchy rather than recomputing them in isolation.
 */
export function applyStableViewIdRewrites(
  root: unknown,
  rewrittenViewIds: ReadonlyMap<string, string>,
): void {
  if (!root || typeof root !== "object" || rewrittenViewIds.size === 0) {
    return;
  }
  if (Array.isArray(root)) {
    for (const item of root) {
      applyStableViewIdRewrites(item, rewrittenViewIds);
    }
    return;
  }
  const node = root as Record<string, unknown>;
  const viewId = node["view-id"];
  if (typeof viewId === "string") {
    const stableViewId = rewrittenViewIds.get(viewId);
    if (stableViewId) {
      node["view-id"] = stableViewId;
    }
  }
  const occludedByViewId = node.occludedByViewId;
  if (typeof occludedByViewId === "string") {
    const stableViewId = rewrittenViewIds.get(occludedByViewId);
    if (stableViewId) {
      node.occludedByViewId = stableViewId;
    }
  }
  for (const child of toChildArray(node)) {
    applyStableViewIdRewrites(child, rewrittenViewIds);
  }
}

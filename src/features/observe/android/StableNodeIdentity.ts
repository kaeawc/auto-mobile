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
 * order) gets an ordinal `-k` suffix. That keeps `view-id` unique within a
 * capture (a property the path UUIDs provided) and lets the diff layer's
 * uniqueness-on-both-sides guard re-pair duplicates in encounter order — the
 * same best-effort heuristic `diffObserveResult` already applies to identical
 * same-path siblings. Distinct rows still cannot false-merge: an ordinal only
 * ever disambiguates nodes whose *entire* stable subtree content is identical.
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

/** Prefix marking a content-derived stable id emitted by this module. */
export const STABLE_VIEW_ID_PREFIX = "s-";

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
 * into a content-derived stable id: `s-<hash16>` for the first node with a
 * given content hash in document order, `s-<hash16>-<k>` for the k-th
 * content-identical duplicate. Nodes whose `view-id` is absent or not
 * UUID-shaped (resource-id-backed ids, already-stable ids) are left untouched,
 * so the pass is a no-op on non-CtrlProxy hierarchies and idempotent on its
 * own output. Accepts the converted hierarchy root (or any node-like object);
 * a non-object input is ignored.
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
    const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
    contentHash.set(node, hash);
    return hash;
  };
  compute(rootNode);

  // Pass 2 (pre-order): assign ids, suffixing content-identical duplicates by
  // document-order occurrence so ids stay unique within the capture.
  const occurrences = new Map<string, number>();
  const rewrittenViewIds = new Map<string, string>();
  const assign = (node: Record<string, unknown>): void => {
    const viewId = node["view-id"];
    if (typeof viewId === "string" && GENERATED_VIEW_ID_PATTERN.test(viewId)) {
      const hash = contentHash.get(node)!;
      const seen = (occurrences.get(hash) ?? 0) + 1;
      occurrences.set(hash, seen);
      const stableViewId =
        seen === 1 ? `${STABLE_VIEW_ID_PREFIX}${hash}` : `${STABLE_VIEW_ID_PREFIX}${hash}-${seen}`;
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

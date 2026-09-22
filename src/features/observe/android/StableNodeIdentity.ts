import { createHash } from "crypto";
import { getToggleContentDescription } from "../../../utils/elementProperties";

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
 * node's own stable content fields plus its children's *structural* hashes —
 * deliberately excluding everything a scroll or interaction perturbs (bounds,
 * sibling position, `extras`, focus/checked/occlusion state). The same row
 * therefore keeps the same id before and after a scroll, and two rows with
 * different content can never share one.
 *
 * Descendant text stability (issue #6230). A node's id must not change merely
 * because some *descendant's* `text` ticked between captures — a row wrapping
 * a live timer child ("1 second" → "2 seconds") is still the same row, and the
 * `s2-…` id an `observe(project: "skeleton")` emitted must still resolve on the
 * fresh capture a later `tapOn`/`sendKeys` runs against. So a child contributes
 * only its **structural** hash to an ancestor — class/className, `resource-id`,
 * `content-desc`, `test-tag`, and (recursively) its own children's structural
 * hashes — with volatile display `text` omitted from that upward contribution.
 * A node's *own* id still mixes in its own `text`/`content-desc` (a node's own
 * text edit remains a new identity, matching `nodeKey`/`contentIdentityKey`
 * semantics), so leaf text nodes stay distinct and the timer leaf's own id still
 * churns — only its ancestors are shielded from descendant text. A descendant's
 * `content-desc` now deliberately restamps its ancestors: Android icon buttons
 * commonly put their accessible label on a child, so rolling that label upward
 * keeps otherwise-identical clickable containers distinct (issue #7311). That
 * accepted content-derived-id churn matches the module's existing trade-off for
 * a node's own content. Nodes that differ only by descendant text share one
 * structural identity (ordinal-suffixed as a duplicate group below); nodes
 * differing in a descendant `content-desc` or structure — a distinct
 * `resource-id`, `class`, or `test-tag` anywhere in the subtree — get distinct
 * ids.
 *
 * Content-identical duplicates (repeated spacer rows, empty Compose click
 * surfaces) share a hash by construction, so the k-th duplicate (document
 * order, scoped independently to app and IME-window subtrees) gets an ordinal
 * `-k` suffix — and, critically, so does the FIRST (`-1`): whenever a hash
 * occurs more than once in its namespace, EVERY occurrence is
 * ordinal-suffixed, and the bare `s-<hash>` form is emitted only for a hash
 * that occurs exactly once there. Separating the IME namespace means keyboard
 * nodes appearing, disappearing, or changing size cannot shift an app node's
 * ordinal (issue #7311). The scheme lets the diff layer's
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
 * Node fields that participate in a node's *own* identity: the stable,
 * position-free description of what the node *is*, including its own display
 * text. Everything else is deliberately excluded: `bounds` and sibling order
 * shift on scroll; `focused` / `checked` / `selected` / `enabled` flip on
 * interaction (a toggle should surface as a `changed` delta, not an identity
 * change); `extras` and `occlusionState`/`occludedBy`/`occludedByViewId` churn
 * nondeterministically between captures (#3051, #3519).
 */
const CONTENT_FIELDS: readonly string[] = ["resource-id", "content-desc", "text", "test-tag"];

/**
 * Node fields a child contributes *upward* to its ancestors' ids. `content-desc`
 * is intentionally included so a child accessibility label distinguishes its
 * otherwise-identical clickable ancestors (issue #7311). `text` is deliberately
 * omitted: a descendant whose visible label ticks between captures (a timer, a
 * live counter, streaming text) must not restamp its ancestors' ids (issue
 * #6230), or the `s2-…` selector an `observe(project: "skeleton")` emitted
 * stops resolving on the fresh capture a `tapOn` runs against. A node's own
 * `text`/`content-desc` still count toward *its own* id via
 * {@link CONTENT_FIELDS}. #7219 considered folding a row's first text child
 * into that row's hash, but doing so would reopen the ticking-text guarantee.
 */
const STRUCTURAL_FIELDS: readonly string[] = ["resource-id", "content-desc", "test-tag"];

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
 * Android conversion stores attributes directly on a node, while the iOS
 * CtrlProxy conversion uses the shared XML-compatible `$` attribute slot.
 * Stable identity is an ingest invariant, so operate on either representation
 * without changing the tree shape seen by their respective consumers.
 */
function attributesOf(node: Record<string, unknown>): Record<string, unknown> {
  const attributes = node["$"];
  return attributes && typeof attributes === "object" && !Array.isArray(attributes)
    ? (attributes as Record<string, unknown>)
    : node;
}

/** Whether this node is in the IME window subtree identified at Android ingest. */
function isInImeWindow(node: Record<string, unknown>, parentIsInImeWindow: boolean): boolean {
  if (parentIsInImeWindow) {
    return true;
  }
  const extras = attributesOf(node).extras;
  return (
    !!extras &&
    typeof extras === "object" &&
    !Array.isArray(extras) &&
    Boolean((extras as Record<string, unknown>)["automobile:imePackage"])
  );
}

/** Read either platform's spelling for attributes before conversion normalizes it. */
function attributeValue(attributes: Record<string, unknown>, field: string): unknown {
  switch (field) {
    case "resource-id":
      return attributes["resource-id"] ?? attributes.resourceId;
    case "content-desc":
      return attributes["content-desc"] ?? attributes.contentDesc;
    case "test-tag":
      return attributes["test-tag"] ?? attributes.testTag;
    case "view-id":
      return attributes["view-id"] ?? attributes.viewId;
    default:
      return attributes[field];
  }
}

/**
 * The public hierarchy contract uses dashed `view-id`. Normalize a generated
 * iOS `viewId` while writing its stable replacement so skeleton projection and
 * selector resolution consume the same field.
 */
function setStableViewId(attributes: Record<string, unknown>, stableViewId: string): void {
  attributes["view-id"] = stableViewId;
  delete attributes.viewId;
}

function applyStableViewIdRewrite(
  attributes: Record<string, unknown>,
  rewrittenViewIds: ReadonlyMap<string, string>,
): void {
  const viewId = attributeValue(attributes, "view-id");
  if (typeof viewId !== "string") {
    return;
  }
  const stableViewId = rewrittenViewIds.get(viewId);
  if (stableViewId) {
    setStableViewId(attributes, stableViewId);
  }
}

function applyOcclusionViewIdRewrite(
  attributes: Record<string, unknown>,
  rewrittenViewIds: ReadonlyMap<string, string>,
): void {
  for (const key of ["occludedByViewId", "occluded-by-view-id"] as const) {
    const viewId = attributes[key];
    if (typeof viewId !== "string") {
      continue;
    }
    const stableViewId = rewrittenViewIds.get(viewId);
    if (stableViewId) {
      attributes[key] = stableViewId;
    }
  }
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

  // Pass 1 (bottom-up): two Merkle-style hashes per node, each rolling up the
  // *hashes* of the children (not their raw subtrees) so cost stays O(n).
  //
  //  - structuralHash: class + STRUCTURAL_FIELDS + children's structuralHashes.
  //    This is what a node contributes to its ANCESTORS, so it includes a
  //    descendant `content-desc` to distinguish Android icon-button containers
  //    (#7311), but excludes volatile descendant `text` so a ticking label does
  //    not restamp any ancestor's id (#6230).
  //  - contentHash (emitted): class + CONTENT_FIELDS (incl. the node's OWN
  //    `text`/`content-desc`) + children's structuralHashes. The node's own
  //    display text still defines its own identity, but descendants roll up
  //    structurally only.
  //
  // Two nodes sharing a contentHash are content-identical up to descendant
  // display text; they are ordinal-suffixed as a duplicate group in pass 2b
  // exactly as fully-identical subtrees already were. A distinct descendant
  // `content-desc` or structure — a differing `resource-id`, `class`, or
  // `test-tag` anywhere in the subtree — yields distinct structuralHashes and
  // therefore distinct ids.
  const contentHash = new Map<Record<string, unknown>, string>();
  const hashCanonical = (
    fields: readonly string[],
    node: Record<string, unknown>,
    kids: string[],
  ): string => {
    const attributes = attributesOf(node);
    return (
      createHash("sha256")
        // JSON-encoding the field array keeps values from straddling separator
        // boundaries (text can contain any delimiter we might pick by hand).
        .update(
          JSON.stringify([
            attributes["class"] ?? attributes.className ?? "",
            ...fields.map((field) =>
              // A named toggle's text is state (On/Off), not identity (#6794).
              field === "text" && getToggleContentDescription(attributes)
                ? ""
                : (attributeValue(attributes, field) ?? ""),
            ),
            kids,
          ]),
        )
        .digest("hex")
        .slice(0, STABLE_VIEW_ID_HASH_LENGTH)
    );
  };
  const compute = (node: Record<string, unknown>): string => {
    const childStructuralHashes = toChildArray(node).map(compute);
    contentHash.set(node, hashCanonical(CONTENT_FIELDS, node, childStructuralHashes));
    return hashCanonical(STRUCTURAL_FIELDS, node, childStructuralHashes);
  };
  compute(rootNode);

  // Pass 2a (pre-order): count, per content hash and IME-window namespace, how
  // many nodes this pass will actually rewrite. A hash rewritten more than once
  // in its namespace is a content-identical duplicate group; one rewritten
  // exactly once there is unique content. IME nodes use an independent counter
  // so keyboard capture churn cannot change an app node's ordinal (#7311). Only
  // rewritten (generated-view-id) nodes count — a resource-id-backed node that
  // happens to share a content hash is left untouched and never competes for
  // the bare form.
  const rewrittenCounts = new Map<string, [outsideIme: number, insideIme: number]>();
  const countRewritten = (node: Record<string, unknown>, parentIsInImeWindow: boolean): void => {
    const nodeIsInImeWindow = isInImeWindow(node, parentIsInImeWindow);
    const attributes = attributesOf(node);
    const viewId = attributeValue(attributes, "view-id");
    if (typeof viewId === "string" && GENERATED_VIEW_ID_PATTERN.test(viewId)) {
      const hash = contentHash.get(node)!;
      const counts = rewrittenCounts.get(hash) ?? [0, 0];
      counts[nodeIsInImeWindow ? 1 : 0] += 1;
      rewrittenCounts.set(hash, counts);
    }
    for (const child of toChildArray(node)) {
      countRewritten(child, nodeIsInImeWindow);
    }
  };
  countRewritten(rootNode, false);

  // Pass 2b (pre-order): assign ids. A hash that occurs once in its app/IME
  // namespace gets the bare `s-<hash>` form; a content-identical duplicate
  // group gets a 1-based document-order ordinal on EVERY member — including the
  // first (`-1`) — so the bare form is reserved for unique content and can
  // never be silently reassigned to a since-removed peer's suffixed id (issue
  // #6229). Independent IME counters keep keyboard-capture changes from
  // perturbing app ordinals (#7311).
  const occurrences = new Map<string, [outsideIme: number, insideIme: number]>();
  const rewrittenViewIds = new Map<string, string>();
  const assign = (node: Record<string, unknown>, parentIsInImeWindow: boolean): void => {
    const nodeIsInImeWindow = isInImeWindow(node, parentIsInImeWindow);
    const attributes = attributesOf(node);
    const viewId = attributeValue(attributes, "view-id");
    if (typeof viewId === "string" && GENERATED_VIEW_ID_PATTERN.test(viewId)) {
      const hash = contentHash.get(node)!;
      const counts = occurrences.get(hash) ?? [0, 0];
      const namespace = nodeIsInImeWindow ? 1 : 0;
      counts[namespace] += 1;
      occurrences.set(hash, counts);
      const seen = counts[namespace];
      const isDuplicateGroup = (rewrittenCounts.get(hash)?.[namespace] ?? 0) > 1;
      const stableViewId = isDuplicateGroup
        ? `${STABLE_VIEW_ID_PREFIX}${hash}-${seen}`
        : `${STABLE_VIEW_ID_PREFIX}${hash}`;
      setStableViewId(attributes, stableViewId);
      rewrittenViewIds.set(viewId, stableViewId);
    }
    for (const child of toChildArray(node)) {
      assign(child, nodeIsInImeWindow);
    }
  };
  assign(rootNode, false);

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
  const attributes = attributesOf(node);
  applyStableViewIdRewrite(attributes, rewrittenViewIds);
  applyOcclusionViewIdRewrite(attributes, rewrittenViewIds);
  for (const child of toChildArray(node)) {
    applyStableViewIdRewrites(child, rewrittenViewIds);
  }
}

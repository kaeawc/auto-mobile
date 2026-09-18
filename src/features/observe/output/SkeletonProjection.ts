import type { Element } from "../../../models/Element";
import { isTruthy } from "../../../models/Element";
import {
  getToggleContentDescription,
  hasAccessibilityAction,
  isEditableElementProperties,
} from "../../../utils/elementProperties";
import type { Affordance, ObserveResult, SkeletonElement } from "../../../models/ObserveResult";
import {
  ElementProvenance,
  getElementProvenance,
  getCapturedKeyboard,
  getUncollectedWrappers,
  isStrictAncestor,
} from "./elementProvenance";

/**
 * Interactable Skeleton Projection (issue #4388).
 *
 * `toSkeleton` collapses the already-computed `ObserveResult.elements`
 * (`{ clickable, scrollable, text, media }`) into a flat, actionable-only list —
 * `{ elementId, label, bounds, affordances }` — dropping layout scaffolding. Embedded
 * semantic links and a Compose test tag are retained only when present, because
 * they make otherwise inaccessible link activation discoverable. It is a
 * pure merge + dedup + compaction of that structure: no device I/O, no tree
 * walk. The output is what an agent needs to decide "what can I do here, and
 * what does it say?", at a fraction of the token cost of the full hierarchy.
 *
 * A clickable container commonly carries no text of its own — the label lives on
 * descendant `TextView`s (the standard Android `clickable container > TextView`
 * preference-row layout). `hoistContainerLabels` (issue #5869) folds that
 * descendant text back onto the container's `label` / `sublabel` using the
 * already-flattened `text` category's geometry, so those rows are no longer
 * `label: null` and non-clickable state text is not lost.
 *
 * `elementId` / `label` map directly onto the `tapOn` selector union
 * (`elementId` / `text`), so a skeleton row is issued as `tapOn({ elementId })`
 * with no new selector semantics (issue #4388 acceptance criterion 2). The
 * emitted key is named `elementId` (not `id`) to literally match the selector
 * field name — see issue #6153.
 *
 * The soft keyboard is a mode, not a set of targets: the whole input-method
 * window collapses into ONE `<ime> | Keyboard (<package>) | input` row rather
 * than ~40 per-keycap tap rows burying the app's own affordances (issue #6871).
 * See {@link detectImeWindow}. `project: "full"` / `raw: true` still emit every
 * key. The same issue gives an unlabelled state container (a preference row's
 * `Switch`) its owning row's label — see {@link attributeContainerLabels} — and
 * a row with no label at all simply omits the key.
 *
 * `skeleton` is actionable-only (issue #6221 item 1): a row with zero
 * affordances never appears there. Such rows (a screen title, the
 * `com.android.systemui` status bar, a standalone notification line) instead
 * go into the sibling `context` array, so the information survives without
 * polluting the action surface — and the recurring systemui status-bar block
 * collapses to a single summarized `context` entry rather than one row per
 * icon. See {@link projectSkeleton}.
 */

type ObserveElements = NonNullable<ObserveResult["elements"]>;

/** Canonical emit order for affordances (matches the {@link Affordance} union). */
const AFFORDANCE_ORDER: readonly Affordance[] = ["tap", "long-press", "input", "scroll", "toggle"];

/** A non-empty string value, or `undefined` (empty/whitespace/non-string reads as absent). */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * `elementId = resource-id ?? view-id`. The `view-id` slot is the stable
 * content-hash id from `assignStableViewIds` (`s-…`, #3228), so a row keeps its
 * elementId across a scroll. A test tag is carried separately for Compose
 * owners that do not enable `testTagsAsResourceId`.
 */
function deriveId(el: Element): string | undefined {
  return nonEmptyString(el["resource-id"]) ?? nonEmptyString(el["view-id"]);
}

/** Named toggles use their accessibility identity; other nodes prefer visible text. */
function deriveLabel(el: Element): string | undefined {
  return (
    getToggleContentDescription(el) ?? nonEmptyString(el.text) ?? nonEmptyString(el["content-desc"])
  );
}

/** Preserve a named toggle's own state alongside its identifying label. */
function deriveSublabel(el: Element, label: string | undefined): string | undefined {
  return getToggleContentDescription(el) && el.text !== label ? nonEmptyString(el.text) : undefined;
}

/**
 * Classify a single element's affordances from its view-hierarchy attributes.
 * `tap`/`long-press` mirror the repo's canonical predicates
 * (`elementProperties.isClickableElementProperties`, `TapOnElement`): the
 * accessibility `actions` array (`"click"` / `"long_click"`) is authoritative on
 * captures that carry no `clickable` boolean (Compose, and iOS which uses
 * `longClickable`), so an element `tapOn` would act on must expose the affordance.
 */
function deriveAffordances(el: Element): Affordance[] {
  const affordances: Affordance[] = [];
  if (isTruthy(el.clickable) || hasAccessibilityAction(el.actions, "click")) {
    affordances.push("tap");
  }
  if (
    isTruthy(el["long-clickable"]) ||
    isTruthy(el.longClickable) ||
    hasAccessibilityAction(el.actions, "long_click")
  ) {
    affordances.push("long-press");
  }
  if (isEditableElementProperties(el)) {
    affordances.push("input");
  }
  if (isTruthy(el.scrollable)) {
    affordances.push("scroll");
  }
  if (isTruthy(el.checkable)) {
    affordances.push("toggle");
  }
  return affordances;
}

/** Flatten an element's object bounds to the compact `[left, top, right, bottom]` tuple. */
function boundsTuple(el: Element): SkeletonElement["bounds"] | undefined {
  const b = el.bounds;
  if (
    Array.isArray(b) &&
    b.length === 4 &&
    b.every((value) => typeof value === "number" && Number.isFinite(value))
  ) {
    return [b[0], b[1], b[2], b[3]];
  }
  if (!b || typeof b !== "object") {
    return undefined;
  }
  const { left, top, right, bottom } = b;
  if ([left, top, right, bottom].some((v) => typeof v !== "number" || !Number.isFinite(v))) {
    return undefined;
  }
  return [left, top, right, bottom];
}

/**
 * Project one already-flattened diff node into the compact skeleton row shape.
 * Unlike {@link projectSkeleton}, this deliberately has no sibling or ancestry
 * context, so it cannot hoist labels or assign duplicate indexes.
 */
export function projectSkeletonElement(element: Element): SkeletonElement | undefined {
  const bounds = boundsTuple(element);
  if (!bounds) {
    return undefined;
  }
  const affordances = deriveAffordances(element);
  const entry: SkeletonElement = { bounds, affordances };
  const elementId = deriveId(element);
  const label = deriveLabel(element);
  if (elementId !== undefined) {
    entry.elementId = elementId;
  }
  if (label !== undefined) {
    entry.label = label.trim();
  }
  if (affordances.includes("toggle")) {
    entry.checked = isTruthy(element.checked);
  }
  return entry;
}

/** Working accumulator for one merged skeleton row, keyed by `(elementId, label, bounds)`. */
interface SkeletonAccumulator {
  elementId?: string;
  label?: string;
  sublabel?: string;
  testTag?: string;
  semanticLinks?: SkeletonElement["semanticLinks"];
  bounds: SkeletonElement["bounds"];
  affordances: Set<Affordance>;
  checked?: boolean;
  /**
   * Root/window ancestry, when the collector supplied it (issue #5881). Present
   * on real captures; absent on hand-built fixtures and non-provenance producers,
   * where hoisting/suppression fall back to geometric containment.
   */
  provenance?: ElementProvenance;
  /** Disambiguator assigned by {@link assignDuplicateIndexes} (issue #6221 item 2). */
  index?: number;
}

/** NUL-joined identity so `(elementId, label, bounds)` triples dedup without straddling. */
function identityKey(
  elementId: string | undefined,
  label: string | undefined,
  bounds: SkeletonElement["bounds"],
): string {
  return [elementId ?? "", label ?? "", bounds.join(",")].join("\0");
}

function area(bounds: SkeletonElement["bounds"]): number {
  return Math.max(0, bounds[2] - bounds[0]) * Math.max(0, bounds[3] - bounds[1]);
}

/** Whether `outer` strictly contains `inner` (all edges enclosing, strictly larger area). */
function strictlyContains(
  outer: SkeletonElement["bounds"],
  inner: SkeletonElement["bounds"],
): boolean {
  return (
    outer[0] <= inner[0] &&
    outer[1] <= inner[1] &&
    outer[2] >= inner[2] &&
    outer[3] >= inner[3] &&
    area(outer) > area(inner)
  );
}

/**
 * Merge overlapping element categories into one accumulator per `(elementId, label,
 * bounds)` triple, unioning affordances. `text` overlaps `clickable`/`scrollable`
 * on real captures (a clickable node that carries text is in both), so the
 * identity key dedups them. `media` carries no actionable affordance and is
 * intentionally excluded. Elements without valid numeric bounds are skipped.
 */
function accumulateByIdentity(
  elements: ObserveElements,
  ime: ImeWindow | undefined,
): SkeletonAccumulator[] {
  const byIdentity = new Map<string, SkeletonAccumulator>();
  const appElements = allElements(elements).filter((element) => !isImeKeycap(element, ime));
  for (const el of appElements) {
    const bounds = boundsTuple(el);
    if (!bounds) {
      continue;
    }
    const elementId = deriveId(el);
    const label = deriveLabel(el);
    const affordances = deriveAffordances(el);
    const key = identityKey(elementId, label, bounds);

    let acc = byIdentity.get(key);
    if (!acc) {
      acc = {
        elementId,
        label,
        sublabel: deriveSublabel(el, label),
        bounds,
        affordances: new Set<Affordance>(),
      };
      byIdentity.set(key, acc);
    }
    if (acc.provenance === undefined) {
      acc.provenance = getElementProvenance(el);
    }
    for (const affordance of affordances) {
      acc.affordances.add(affordance);
    }
    if (affordances.includes("toggle")) {
      acc.checked = isTruthy(el.checked);
    }
    if (acc.testTag === undefined) {
      acc.testTag = nonEmptyString(el["test-tag"]);
    }
    if (acc.semanticLinks === undefined && el["semantic-links"]?.length) {
      acc.semanticLinks = el["semantic-links"];
    }
  }
  return [...byIdentity.values()];
}

/**
 * Whether `container` encloses `inner` for hoisting/suppression. When both
 * carry collector provenance (issue #5881) this is true tree ancestry — same
 * window/root and an enclosing Euler interval — so cross-window geometry never
 * matches and an exact-fill (equal-bounds) descendant still does. Without
 * provenance (hand-built fixtures, non-provenance producers) it falls back to
 * strict geometric containment, preserving the pre-#5881 behavior.
 */
function containerEnclosesText(
  container: SkeletonAccumulator,
  inner: SkeletonAccumulator,
): boolean {
  if (container.provenance && inner.provenance) {
    return isStrictAncestor(container.provenance, inner.provenance);
  }
  return strictlyContains(container.bounds, inner.bounds);
}

/**
 * Keep rule (issue #4388): a row is kept if it has ≥1 affordance, carries
 * semantic links, OR carries a non-empty label with no clickable ancestor.
 * Semantic links remain independently discoverable even when the linked text is
 * inside a generic tappable card that would otherwise suppress its text row.
 *
 * The clickable-ancestor test is scoped to same-window/same-root descendants
 * when provenance is present (issue #5881), so a labelled overlay in a topmost
 * window is no longer dropped by a geometrically-overlapping clickable in a
 * lower window.
 */
function shouldKeep(acc: SkeletonAccumulator, clickable: SkeletonAccumulator[]): boolean {
  if (acc.affordances.size > 0) {
    return true;
  }
  if (acc.semanticLinks?.length) {
    return true;
  }
  if (acc.label === undefined) {
    return false;
  }
  return !clickable.some((container) => containerEnclosesText(container, acc));
}

/**
 * Hoist descendant text onto clickable containers (issue #5869). The standard
 * Android `clickable container > TextView` preference-row layout puts the visible
 * label on descendant `TextView`s, not on the clickable node itself — so the
 * container's own `label` is `null` and, without this, every such row (most of
 * Settings and most well-built apps) is `label: null`.
 *
 * This mirrors what an accessibility service does: for each pure-text accumulator
 * (a labelled row with no affordances) that is strictly enclosed by a clickable
 * container, fold its text into that container's **smallest** enclosing clickable
 * ancestor. Texts are ordered top-to-bottom, left-to-right; the first becomes the
 * container's `label` when it has none, and the remainder join into `sublabel`
 * (so a preference summary line or an alarm's day-of-week schedule survives in the
 * compact form). Text equal to the container's own label is not duplicated.
 *
 * The folded text accumulators are left in place — {@link shouldKeep} already
 * suppresses labelled text that has a clickable ancestor, so they drop out and
 * are not re-emitted as separate rows (semantic-link rows are the deliberate
 * exception and stay discoverable).
 */
function hoistContainerLabels(
  accumulators: SkeletonAccumulator[],
  clickable: SkeletonAccumulator[],
): void {
  if (clickable.length === 0) {
    return;
  }
  for (const [container, texts] of groupTextByContainer(accumulators, clickable)) {
    texts.sort(byReadingOrder);
    applyHoistedLabels(container, distinctHoistParts(container, texts));
  }
}

/**
 * Bucket each pure-text accumulator (a label, no affordance of its own) under
 * its smallest enclosing clickable container. Nested clickable/toggle rows keep
 * their own identity and are never folded.
 */
function groupTextByContainer(
  accumulators: SkeletonAccumulator[],
  clickable: SkeletonAccumulator[],
): Map<SkeletonAccumulator, SkeletonAccumulator[]> {
  const byContainer = new Map<SkeletonAccumulator, SkeletonAccumulator[]>();
  for (const acc of accumulators) {
    if (acc.affordances.size > 0 || acc.label === undefined) {
      continue;
    }
    const container = smallestClickableAncestor(acc, clickable);
    if (!container) {
      continue;
    }
    const bucket = byContainer.get(container);
    if (bucket) {
      bucket.push(acc);
    } else {
      byContainer.set(container, [acc]);
    }
  }
  return byContainer;
}

/** Distinct descendant labels, excluding any equal to the container's own label. */
function distinctHoistParts(
  container: SkeletonAccumulator,
  texts: SkeletonAccumulator[],
): string[] {
  const parts: string[] = [];
  for (const text of texts) {
    const label = text.label;
    if (label !== undefined && label !== container.label && !parts.includes(label)) {
      parts.push(label);
    }
  }
  return parts;
}

/**
 * Whether `label` is an incomplete/templated own-label rather than a genuine
 * one (issue #6221 item 3). A real Android row label built from a
 * `"$time $name"`-style template (e.g. an alarm row) leaves its leading
 * delimiter behind when the interpolated part comes back empty — the observed
 * repro was a row whose own text/content-desc read literally `" Alarm"`
 * (leading space, no time), while a sibling row of the same type read
 * `"6:45 AM Alarm"` (own text already complete, nothing to fold in). Stray
 * leading/trailing whitespace on the RAW (untrimmed) label is a narrow, strong
 * signal of exactly that dropped-placeholder shape — unlike an ordinary clean
 * single-word label ("Wi-Fi", "Alarm" with no stray space), which must NOT be
 * clobbered by a descendant's state text (that text belongs in `sublabel`,
 * per the AC2 #5869 behavior above).
 */
function isIncompleteOwnLabel(label: string): boolean {
  return label !== label.trim();
}

/**
 * Fold `parts` onto the container: the first becomes `label` when it has none
 * — or when its existing own label is an incomplete template
 * ({@link isIncompleteOwnLabel}), in which case the first part is prepended to
 * the trimmed own label so the row keeps its generic noun ("Alarm") without
 * losing the identifying descendant text ("8:30 AM") that made the row unique
 * (issue #6221 item 3). The remainder always joins into `sublabel`. A
 * container with a genuine own label keeps it verbatim and takes every part
 * as `sublabel`.
 */
function applyHoistedLabels(container: SkeletonAccumulator, parts: string[]): void {
  if (parts.length === 0) {
    return;
  }
  if (container.label === undefined) {
    container.label = parts[0];
    if (parts.length > 1) {
      container.sublabel = parts.slice(1).join(", ");
    }
  } else if (isIncompleteOwnLabel(container.label)) {
    container.label = `${parts[0]} ${container.label.trim()}`;
    if (parts.length > 1) {
      container.sublabel = parts.slice(1).join(", ");
    }
  } else {
    container.sublabel = [...new Set([container.sublabel, ...parts].filter(Boolean))].join(", ");
  }
}

/** Order two rows top-to-bottom, then left-to-right, by their bounds tuple. */
function byReadingOrder(a: SkeletonAccumulator, b: SkeletonAccumulator): number {
  return a.bounds[1] - b.bounds[1] || a.bounds[0] - b.bounds[0];
}

/**
 * The innermost clickable accumulator that encloses `text`, or `undefined` when
 * none does. With provenance (issue #5881) "innermost" is the deepest true tree
 * ancestor (greatest `enter`), so an exact-fill descendant folds into its proven
 * parent; without it, the smallest-area geometric container, so text folds into
 * its immediate row rather than an outer clickable card or list.
 */
function smallestClickableAncestor(
  text: SkeletonAccumulator,
  clickable: SkeletonAccumulator[],
): SkeletonAccumulator | undefined {
  let best: SkeletonAccumulator | undefined;
  for (const candidate of clickable) {
    if (!containerEnclosesText(candidate, text)) {
      continue;
    }
    if (!best || isTighterContainer(candidate, best)) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Whether `candidate` is a tighter (more immediate) container than the current
 * `best`. With provenance, the deeper tree ancestor wins (greater `enter`);
 * otherwise the smaller-area geometric container.
 */
function isTighterContainer(candidate: SkeletonAccumulator, best: SkeletonAccumulator): boolean {
  if (candidate.provenance && best.provenance) {
    return candidate.provenance.enter > best.provenance.enter;
  }
  return area(candidate.bounds) < area(best.bounds);
}

/** Materialize one accumulator into an emitted skeleton row (omitting absent optionals). */
function toSkeletonEntry(acc: SkeletonAccumulator): SkeletonElement {
  const entry: SkeletonElement = {
    bounds: acc.bounds,
    affordances: AFFORDANCE_ORDER.filter((affordance) => acc.affordances.has(affordance)),
  };
  if (acc.elementId !== undefined) {
    entry.elementId = acc.elementId;
  }
  if (acc.label !== undefined) {
    // Never emit a leading/trailing space (issue #6221 item 3(b)) — a
    // templated own label whose interpolated part came back empty (e.g. an
    // alarm row's `" Alarm"`) leaves the delimiter behind even after
    // {@link applyHoistedLabels} has folded in the identifying descendant
    // text, and a container with no hoist candidates at all never runs that
    // fold in the first place.
    entry.label = acc.label.trim();
  }
  if (acc.sublabel !== undefined) {
    entry.sublabel = acc.sublabel.trim();
  }
  if (acc.testTag !== undefined) {
    entry.testTag = acc.testTag;
  }
  if (acc.semanticLinks !== undefined) {
    entry.semanticLinks = acc.semanticLinks;
  }
  if (acc.checked !== undefined) {
    entry.checked = acc.checked;
  }
  if (acc.index !== undefined) {
    entry.index = acc.index;
  }
  return entry;
}

/**
 * Order two accumulators the way `tapOn`'s own explicit-`index` resolution
 * does, so a per-entry `index` this file emits is guaranteed usable verbatim
 * as `tapOn.index` (issue #6221 item 2).
 *
 * `DefaultElementSelector.pickMatch` treats an explicit `index` as "the Nth
 * on-screen match in hierarchy order" and — critically — resolves it against
 * the RAW DFS traversal order `ElementFinder.findElementsByResourceId` returns
 * with `preserveTraversalOrder: true` (selecting by index skips the by-area
 * sort `selectionStrategy: "first"` otherwise applies). That traversal order
 * is exactly the pre-order DFS counter this file's provenance already carries:
 * `ElementProvenance.enter`, assigned once per element by
 * `DefaultObserveElementCollector` while walking the SAME root-group order
 * `ElementFinder` walks (main roots, then window roots topmost-first) — so
 * ranking duplicate entries by `enter` reproduces tapOn's index assignment
 * exactly. Provenance-less producers (hand-built fixtures, non-provenance
 * callers) fall back to the skeleton's own top-to-bottom/left-to-right reading
 * order, the closest available approximation without a real traversal to rank
 * against.
 */
function byHierarchyOrder(a: SkeletonAccumulator, b: SkeletonAccumulator): number {
  if (a.provenance && b.provenance) {
    return a.provenance.enter - b.provenance.enter;
  }
  return byReadingOrder(a, b);
}

/**
 * Emit a stable per-entry `index` (issue #6221 item 2) on every entry whose
 * `elementId` repeats within this skeleton, so a client can disambiguate with
 * `tapOn({ selector: { elementId }, index: entry.index })` instead of
 * guessing against the undocumented default `selectionStrategy: "first"`.
 * Entries with a unique `elementId` (including all entries with no
 * `elementId` at all) are left untouched — no spurious `index` on the common
 * case. See {@link byHierarchyOrder} for why ranking by `enter` reproduces
 * `tapOn.index` verbatim.
 */
function assignDuplicateIndexes(entries: SkeletonAccumulator[]): void {
  const byElementId = new Map<string, SkeletonAccumulator[]>();
  for (const entry of entries) {
    if (entry.elementId === undefined) {
      continue;
    }
    const group = byElementId.get(entry.elementId);
    if (group) {
      group.push(entry);
    } else {
      byElementId.set(entry.elementId, [entry]);
    }
  }
  for (const group of byElementId.values()) {
    if (group.length < 2) {
      continue;
    }
    group.sort(byHierarchyOrder);
    group.forEach((entry, position) => {
      entry.index = position;
    });
  }
}

/**
 * Resource-id ALLOWLIST for the actual Android status-bar chrome — the clock,
 * signal/battery icons, and their containers (`com.android.systemui:id/clock`,
 * `:id/wifi_signal`, `:id/battery`, `:id/status_bar_container`, …). This block
 * is re-emitted on EVERY observation of EVERY screen (issue #6221 item 1) and
 * carries no affordances, so {@link collapseSystemUiBlock} folds every
 * matching zero-affordance row into one summarized `context` entry instead of
 * emitting each one separately.
 *
 * Deliberately an ALLOWLIST, not a `com.android.systemui:id/` prefix match
 * (PR #6242 review PRRT_kwDOP-GF5M6fq3iH): the notification SHADE lives under
 * the same `com.android.systemui` namespace (e.g. `:id/notification_row_1`,
 * `:id/notification_stack_scroller` — see `test/server/systemTray.test.ts`),
 * and those rows are ACTIONABLE and must stay individually selectable, never
 * folded into this summary. Only genuine status-bar chrome collapses; a new
 * systemui id that isn't on this list simply stays its own `context` entry
 * (still correct, just not collapsed) rather than risking a false positive.
 */
const SYSTEMUI_STATUS_BAR_ID_PATTERN =
  /^com\.android\.systemui:id\/(status_bar[a-zA-Z_]*|clock|battery[a-zA-Z_]*|wifi_[a-zA-Z_]*|system_icons|statusIcons|notification_icon_area|notificationIcons)$/;

/** Whether `acc` is genuine status-bar chrome (never the notification shade — see the pattern's doc). */
function isSystemUiEntry(acc: SkeletonAccumulator): boolean {
  return acc.elementId !== undefined && SYSTEMUI_STATUS_BAR_ID_PATTERN.test(acc.elementId);
}

/** The smallest bounds tuple enclosing every supplied box. */
function unionBounds(
  boxes: readonly NonNullable<SkeletonElement["bounds"]>[],
): SkeletonElement["bounds"] {
  let [left, top, right, bottom] = boxes[0];
  for (const box of boxes.slice(1)) {
    left = Math.min(left, box[0]);
    top = Math.min(top, box[1]);
    right = Math.max(right, box[2]);
    bottom = Math.max(bottom, box[3]);
  }
  return [left, top, right, bottom];
}

/**
 * Synthetic elementId for the collapsed systemui summary row. Deliberately NOT
 * shaped like a real `package:id/name` resource-id (no `:id/` segment) so it
 * can never be mistaken for — or collide with — an actual selector; the row
 * carries no affordances and is not meant to be tapped.
 */
const SYSTEMUI_SUMMARY_ELEMENT_ID = "com.android.systemui:status-bar-summary";

/**
 * Collapse every zero-affordance systemui status-bar row into ONE summarized
 * `context` entry (issue #6221 item 1). The block (clock, wifi/battery icons,
 * …) reappears verbatim on every observation of every screen, so emitting each
 * icon as its own `context` row would just move the noise from `skeleton` to
 * `context` instead of removing it. Non-systemui zero-affordance entries
 * (e.g. a screen title, a standalone notification) pass through individually.
 */
function collapseSystemUiBlock(nonActionable: SkeletonAccumulator[]): SkeletonAccumulator[] {
  const systemUiEntries = nonActionable.filter(isSystemUiEntry);
  if (systemUiEntries.length === 0) {
    return nonActionable;
  }
  const other = nonActionable.filter((acc) => !isSystemUiEntry(acc));
  const summaryParts = systemUiEntries
    .map((entry) => entry.label?.trim())
    .filter((label): label is string => !!label);
  const summary: SkeletonAccumulator = {
    elementId: SYSTEMUI_SUMMARY_ELEMENT_ID,
    label:
      summaryParts.length > 0
        ? `Status bar: ${summaryParts.join(", ")}`
        : "Status bar (no readable status text)",
    bounds: unionBounds(systemUiEntries.map((entry) => entry.bounds)),
    affordances: new Set<Affordance>(),
  };
  return [...other, summary];
}

/**
 * Synthetic elementId for the collapsed IME row. Like
 * {@link SYSTEMUI_SUMMARY_ELEMENT_ID} it is deliberately NOT shaped like a real
 * `package:id/name` resource-id, so it can never be mistaken for a selector: the
 * supported way to drive a keyboard is `inputText` / `sendKeys`, never a tap per
 * keycap (issue #6871).
 */
const IME_ELEMENT_ID = "<ime>";

/**
 * The `…:id/key_pos_*` resource-id family every AOSP/Gboard-derived IME gives
 * its keycaps. The suffix is NOT a `<row>_<col>` grid coordinate — the captured
 * Gboard fixtures under `test/fixtures/observe/diff/` carry `key_pos_shift`,
 * `key_pos_space`, `key_pos_del`, `key_pos_ime_action` and
 * `key_pos_header_access_points_menu` alongside positional ones — so the prefix
 * is all that can be matched, and corroboration has to come from
 * {@link MIN_FALLBACK_KEYCAPS} rather than from the suffix shape.
 *
 * This is the FALLBACK identification path (issue #6871): the authoritative one
 * is `ElementProvenance.keyboardPackage`, which the collector inherits from the
 * control proxy's `automobile:imePackage` window extra — but that extra only
 * exists on a re-cut control proxy, so on an older on-device build (and on the
 * `uiautomator dump` path) the ~40 keycaps still reached the skeleton. The
 * capture group is the IME's own package, which is also what distinguishes a
 * keycap from the framework chrome that shares the window
 * (`android:id/input_method_nav_back`).
 */
const KEYCAP_ID_PATTERN = /^([A-Za-z0-9_.]+):id\/key_pos_/;

/**
 * How many DISTINCT `key_pos_*` resource-ids one package must own before the
 * fallback path is willing to call it a keyboard (issue #6871).
 *
 * Without this fence a single app control that merely borrows the prefix
 * (`com.app:id/key_pos_preview`) was conclusive evidence on a screen with no
 * keyboard at all: its own row was folded away, `keyboard` announced
 * `{ visible: true, package: "com.app" }`, and a synthetic `<ime>` row appeared
 * for a keyboard that was never up. Nothing authoritative exists on that path to
 * override the false marker, so the corroboration has to come from the markers
 * themselves — a keyboard is a grid of keys and always presents many, while a
 * borrowed prefix is one node. Two is the smallest threshold that rejects the
 * lone decoy; the real captures carry eight or more.
 */
const MIN_FALLBACK_KEYCAPS = 2;

/** Every collected element, in the category order the projection consumes them. */
function allElements(elements: ObserveElements): Element[] {
  return [...elements.clickable, ...elements.scrollable, ...elements.text];
}

/** The `package` half of a canonical `package:id/name` Android resource-id. */
const RESOURCE_ID_PACKAGE_PATTERN = /^([A-Za-z0-9_.]+):id\//;

/** The owning package of a `package:id/name` resource-id, when it has that shape. */
function idPackage(el: Element): string | undefined {
  return RESOURCE_ID_PACKAGE_PATTERN.exec(deriveId(el) ?? "")?.[1];
}

/**
 * The detected input-method window: its package, plus the provenance group and
 * pre-order span of the keyboard subtree — the nodes that identified it, widened
 * to the outermost node the IME owns around them (see
 * {@link widenToEnclosingImeSubtree}). The span lets an anonymous node between
 * two keycaps (a key with no resource-id) collapse too, without relaxing
 * membership to anything outside that one window's subtree.
 */
interface ImeWindow {
  package: string;
  /**
   * Whether the capture itself vouched for the package. On the fallback
   * (keycap-id) path the span may also widen to an uncollected IME-owned
   * wrapper (issue #6908 item 1); the authoritative path never needs to, since
   * inherited `keyboardPackage` provenance already decides membership.
   */
  authoritative: boolean;
  group?: number;
  spanEnter: number;
  spanExit: number;
}

/** The IME package this element announces, by provenance first and keycap id second. */
function imeMarker(el: Element): string | undefined {
  return (
    getElementProvenance(el)?.keyboardPackage ?? KEYCAP_ID_PATTERN.exec(deriveId(el) ?? "")?.[1]
  );
}

/**
 * The IME package the capture itself vouches for: the control proxy's
 * `automobile:imePackage` window extra, surfaced either as the capture-level
 * keyboard identity or as per-element provenance. This is authoritative — the
 * keycap resource-id family is only a guess (issue #6871).
 */
function authoritativeImePackage(elements: ObserveElements): string | undefined {
  const captured = getCapturedKeyboard(elements)?.package;
  if (captured) {
    return captured;
  }
  for (const el of allElements(elements)) {
    const inherited = getElementProvenance(el)?.keyboardPackage;
    if (inherited) {
      return inherited;
    }
  }
  return undefined;
}

/** A package's keycap markers, corroborated within ONE root/window group. */
interface CorroboratedKeycaps {
  package: string;
  /** The group the markers sit in; absent for provenance-less input. */
  group?: number;
}

/**
 * The first (package, root/window group) pair that owns at least
 * {@link MIN_FALLBACK_KEYCAPS} distinct `key_pos_*` resource-ids, in collection
 * order (issue #6871).
 *
 * Distinct ids, not node count: the same element can reach this through more
 * than one category of {@link allElements}, and a repeated id is one marker
 * seen twice, not two keys.
 *
 * Scoped per group, not per package (issue #6908 item 2): a keyboard app
 * showing its own `key_pos_preview` control in the main root while its IME is
 * up in a window root would otherwise corroborate the decoy with the real keys,
 * and {@link detectImeWindow} would then lock onto whichever group came first.
 * Ancestry only exists within one group, so a keyboard is only ever evidenced
 * by markers that share one.
 */
function corroboratedKeycapPackage(elements: ObserveElements): CorroboratedKeycaps | undefined {
  const keycapIdsByScope = new Map<string, { scope: CorroboratedKeycaps; ids: Set<string> }>();
  for (const el of allElements(elements)) {
    const id = deriveId(el) ?? "";
    const pkg = KEYCAP_ID_PATTERN.exec(id)?.[1];
    if (pkg === undefined) {
      continue;
    }
    const group = getElementProvenance(el)?.group;
    // `:` cannot occur in a package name (see KEYCAP_ID_PATTERN), so the key is unambiguous.
    const key = `${group ?? "-"}:${pkg}`;
    const entry = keycapIdsByScope.get(key) ?? { scope: { package: pkg, group }, ids: new Set() };
    entry.ids.add(id);
    keycapIdsByScope.set(key, entry);
  }
  for (const { scope, ids } of keycapIdsByScope.values()) {
    if (ids.size >= MIN_FALLBACK_KEYCAPS) {
      return scope;
    }
  }
  return undefined;
}

/**
 * Identify the input-method window, if one is on screen (issue #6871).
 *
 * The package is chosen in a FIRST pass that prefers authoritative identity
 * ({@link authoritativeImePackage}) and only falls back to
 * {@link corroboratedKeycapPackage} when the capture vouches for none.
 * Otherwise an app control that happens to carry that id family
 * (`com.app:id/key_pos_preview`) and is emitted before the real keyboard would
 * lock the collapse onto the app: the row would be labelled with the wrong
 * package while the real keycaps stayed exposed. A second pass then measures the
 * group/span of the nodes that actually belong to that one package.
 */
function detectImeWindow(elements: ObserveElements): ImeWindow | undefined {
  const authoritative = authoritativeImePackage(elements);
  const corroborated =
    authoritative === undefined ? corroboratedKeycapPackage(elements) : undefined;
  const detected = authoritative ?? corroborated?.package;
  if (detected === undefined) {
    return undefined;
  }
  const ime: ImeWindow = {
    package: detected,
    authoritative: authoritative !== undefined,
    // The corroborated group is the window the markers were counted in, so the
    // span can never lock onto a same-package marker in an earlier group.
    group: corroborated?.group,
    spanEnter: Infinity,
    spanExit: -Infinity,
  };
  for (const el of allElements(elements)) {
    const provenance = getElementProvenance(el);
    if (imeMarker(el) !== ime.package || !provenance) {
      continue;
    }
    ime.group ??= provenance.group;
    if (provenance.group === ime.group) {
      ime.spanEnter = Math.min(ime.spanEnter, provenance.enter);
      ime.spanExit = Math.max(ime.spanExit, provenance.exit);
    }
  }
  widenToEnclosingImeSubtree(elements, ime);
  return ime;
}

/**
 * Grow the detected span from the marker nodes to the whole keyboard subtree
 * they sit in (issue #6871).
 *
 * The markers are only the nodes carrying the `key_pos_*` id family, so on the
 * fallback path the span is a keycap-only interval that STARTS AFTER and ENDS
 * BEFORE the IME's own container (`com.ime:id/keyboard_container`, which is
 * itself clickable). Membership measured against that narrow interval left the
 * container — and any anonymous key outside it — as extra rows beside `<ime>`,
 * breaking the one-row collapse this projection exists to guarantee.
 *
 * Only a node the IME itself OWNS by `package:id/name` can widen the span, so
 * the framework window root (or the app's own decor node) can never drag the
 * whole screen into the keyboard. Candidates enclosing the marker span are
 * nested in one another by construction — they are ancestors of the same nodes
 * — so taking the widest is well defined, and measuring every candidate against
 * the ORIGINAL marker span keeps it independent of collection order.
 *
 * The candidates include the wrappers the collector parsed but placed in no
 * category (issue #6908 item 1): the usual legacy shape is a non-actionable,
 * unlabelled `com.ime:id/keyboard_view` that never reaches
 * {@link allElements}, and without it the span stayed keycap-only, leaving the
 * anonymous keys before the first / after the last marker as stray tap rows
 * and `<ime>` with a truncated box.
 */
function widenToEnclosingImeSubtree(elements: ObserveElements, ime: ImeWindow): void {
  if (ime.group === undefined) {
    return;
  }
  const markerEnter = ime.spanEnter;
  const markerExit = ime.spanExit;
  for (const el of imeCandidates(elements, ime)) {
    const provenance = getElementProvenance(el);
    if (!provenance || provenance.group !== ime.group || idPackage(el) !== ime.package) {
      continue;
    }
    if (provenance.enter <= markerEnter && provenance.exit >= markerExit) {
      ime.spanEnter = Math.min(ime.spanEnter, provenance.enter);
      ime.spanExit = Math.max(ime.spanExit, provenance.exit);
    }
  }
}

/**
 * Every node that may place or bound the IME window. The fallback path also
 * sees the collector's uncollected wrappers (issue #6908 item 1); the
 * authoritative path is deliberately left as it was — inherited provenance
 * already covers the whole IME subtree, and its row keeps the keys' own box.
 */
function imeCandidates(elements: ObserveElements, ime: ImeWindow): Element[] {
  return ime.authoritative
    ? allElements(elements)
    : [...allElements(elements), ...getUncollectedWrappers(elements)];
}

/**
 * Whether `el` sits inside the detected IME window (issue #6871).
 *
 * Inherited `keyboardPackage` provenance is authoritative on its own — the
 * collector only sets it on the IME root's own subtree. Everything else is
 * decided by the detected group/span, so an app control in ANOTHER window that
 * merely shares the keyboard's package (a keyboard app showing its own settings
 * screen while its IME is up) is not folded away and does not stretch the
 * synthetic row's bounds across two windows. The package-only match is reserved
 * for provenance-less input, where group/span ancestry does not exist; when the
 * capture vouches for an IME that no collected node places (visible keyboard,
 * no accessible keys) nothing is a member at all.
 */
function isImeMember(el: Element, ime: ImeWindow): boolean {
  const provenance = getElementProvenance(el);
  if (provenance?.keyboardPackage === ime.package) {
    return true;
  }
  if (provenance === undefined) {
    return idPackage(el) === ime.package;
  }
  return (
    ime.group !== undefined &&
    provenance.group === ime.group &&
    provenance.enter >= ime.spanEnter &&
    provenance.exit <= ime.spanExit
  );
}

/**
 * Whether `el` is a keycap that collapses into the single IME row. A member
 * whose resource-id belongs to a DIFFERENT package than the IME is framework
 * chrome sharing the window — `android:id/input_method_nav_back` is the one the
 * dogfood loop named — and stays individually actionable (issue #6871).
 *
 * Package equality is deliberately the whole test for the IME's own nodes. The
 * IME's toolbar/emoji/clipboard affordances are NOT separable from its keys:
 * the captured Gboard fixtures give them the very same keycap id family
 * (`key_pos_header_access_points_menu`, `key_pos_switch_to_symbol`,
 * `key_pos_ime_action`), and the majority of keys carry no resource-id at all,
 * so any narrower key test would re-expose the ~40-row flood #6871 exists to
 * remove while still folding the toolbar. Driving the keyboard is `inputText` /
 * `sendKeys`, never a tap inside its window, so one row is the honest shape.
 */
function isImeKeycap(el: Element, ime: ImeWindow | undefined): boolean {
  if (!ime || !isImeMember(el, ime)) {
    return false;
  }
  const owner = idPackage(el);
  return owner === undefined || owner === ime.package;
}

/**
 * The single row that replaces every keycap: `<ime> | Keyboard (<package>) |
 * input` (issue #6871). `input` is the only honest affordance — `inputText` /
 * `sendKeys` are the supported way to drive it. Absent when the IME was
 * identified but contributed no bounded node (the `keyboard` summary still
 * reports it), so the row never claims a box it does not have.
 */
function imeAccumulator(
  elements: ObserveElements,
  ime: ImeWindow | undefined,
): SkeletonAccumulator | undefined {
  if (!ime) {
    return undefined;
  }
  const boxes = imeCandidates(elements, ime)
    .filter((el) => isImeKeycap(el, ime))
    .map(boundsTuple)
    .filter((box): box is NonNullable<SkeletonElement["bounds"]> => box !== undefined);
  if (boxes.length === 0) {
    return undefined;
  }
  return {
    elementId: IME_ELEMENT_ID,
    label: `Keyboard (${ime.package})`,
    bounds: unionBounds(boxes),
    affordances: new Set<Affordance>(["input"]),
  };
}

/** Affordances whose row is a state/scroll container that commonly carries no text of its own. */
const ATTRIBUTABLE_AFFORDANCES: readonly Affordance[] = ["toggle", "scroll"];

/**
 * Attribute an owning row's label to unlabelled state containers (issue #6871).
 *
 * {@link hoistContainerLabels} folds text ONTO clickable containers, but never
 * INTO a row that has an affordance of its own — so the Android preference-row
 * `Switch` (`clickable="false"`, `checkable="true"`; it is the node carrying
 * `checked`, see issue #6257) came through with no label at all, and a client
 * saw a `checked` state with nothing tying it to the setting it belongs to.
 * Here each unlabelled toggle/scroll container takes the label of its tightest
 * labelled enclosing row, so `switchWidget` reads `Airplane mode` instead of
 * nothing. Candidates are snapshotted before any mutation, so attribution is
 * order-independent and never chains one derived label onto another. A
 * container with no labelled ancestor (a scrollable fragment root) keeps no
 * label — {@link toSkeletonEntry} then omits the key entirely rather than
 * emitting a placeholder.
 */
function attributeContainerLabels(accumulators: SkeletonAccumulator[]): void {
  const labelled = accumulators.filter((acc) => acc.label !== undefined);
  if (labelled.length === 0) {
    return;
  }
  for (const acc of accumulators) {
    if (acc.label !== undefined || !ATTRIBUTABLE_AFFORDANCES.some((a) => acc.affordances.has(a))) {
      continue;
    }
    acc.label = smallestLabelledAncestor(acc, labelled)?.label;
  }
}

/** The tightest labelled accumulator enclosing `acc`, by the same ancestry rule as hoisting. */
function smallestLabelledAncestor(
  acc: SkeletonAccumulator,
  labelled: SkeletonAccumulator[],
): SkeletonAccumulator | undefined {
  let best: SkeletonAccumulator | undefined;
  for (const candidate of labelled) {
    if (!containerEnclosesText(candidate, acc)) {
      continue;
    }
    if (!best || isTighterContainer(candidate, best)) {
      best = candidate;
    }
  }
  return best;
}

/** The `skeleton` (actionable) and `context` (non-actionable) halves of a projection. */
export interface SkeletonProjectionResult {
  keyboard?: ObserveResult["keyboard"];
  /** Actionable-only rows (`affordances.length >= 1`); the surface a client should act on. */
  skeleton: SkeletonElement[];
  /**
   * Non-actionable rows (`affordances.length === 0`) that still carry readable
   * information — a screen title, a status-bar summary, a standalone
   * notification line (issue #6221 item 1). Kept out of `skeleton` so that
   * array means what its schema says: actionable-only.
   */
  context: SkeletonElement[];
}

/**
 * Project the flattened `elements` block into the actionable `skeleton` and
 * informational `context` arrays (issue #6221 item 1): merge + dedup the
 * categories, apply the keep rule, split on affordance count, and collapse
 * the systemui status-bar block. Duplicate-id disambiguation (issue #6221 item
 * 2) runs only over the actionable set — a non-actionable duplicate is not
 * something a client will ever need to disambiguate for `tapOn`.
 */
export function projectSkeleton(elements: ObserveElements): SkeletonProjectionResult {
  const ime = detectImeWindow(elements);
  const accumulators = accumulateByIdentity(elements, ime);
  const clickable = accumulators.filter((acc) => acc.affordances.has("tap"));
  // Hoist descendant text onto labelless/underlabelled clickable rows (issue
  // #5869) before the keep filter suppresses the now-folded text accumulators.
  hoistContainerLabels(accumulators, clickable);
  // …then attribute an owning row's label to the state-carrying containers that
  // hoisting deliberately never folds into (issue #6871).
  attributeContainerLabels(accumulators);

  const kept = accumulators.filter((acc) => shouldKeep(acc, clickable));
  const actionable = kept.filter((acc) => acc.affordances.size > 0);
  const nonActionable = kept.filter((acc) => acc.affordances.size === 0);

  // One row for the whole IME window, appended last: the keyboard is a mode, not
  // a list of targets, so it must never come before the app's own affordances.
  const imeRow = imeAccumulator(elements, ime);
  if (imeRow) {
    actionable.push(imeRow);
  }

  // Disambiguate duplicate ids (issue #6221 item 2) against the FINAL emitted
  // actionable set, not the pre-filter accumulators — a duplicate suppressed by
  // the keep rule (e.g. folded/hoisted text) must not consume an index slot a
  // client will never see.
  assignDuplicateIndexes(actionable);

  return {
    // Report only observed IME identity; missing capture evidence does not mean hidden.
    keyboard:
      getCapturedKeyboard(elements) ?? (ime ? { visible: true, package: ime.package } : undefined),
    skeleton: actionable.map(toSkeletonEntry),
    context: collapseSystemUiBlock(nonActionable).map(toSkeletonEntry),
  };
}

/**
 * Project the flattened `elements` block into an actionable-only skeleton
 * (issue #4388): merge + dedup the categories, apply the keep rule, and emit
 * `{ elementId, label, bounds, affordances }` rows with compact tuple bounds.
 *
 * A thin wrapper over {@link projectSkeleton} that drops `context` (issue
 * #6221 item 1), kept for callers that only ever wanted the actionable rows
 * (e.g. the #6218 elementId round-trip coverage).
 */
export function toSkeleton(elements: ObserveElements): SkeletonElement[] {
  return projectSkeleton(elements).skeleton;
}

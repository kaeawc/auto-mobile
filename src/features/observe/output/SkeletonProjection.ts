import { isSystemUiStatusBarId } from "../../../utils/androidStatusBar";
import {
  displayedSearchableLabel,
  foldSearchableLabels,
  inheritsOwnerLabel,
} from "../../utility/SearchableLabels";
import type { SearchableEntry } from "../../utility/SearchableNode";
import { isImeKeyEntry, toSearchable } from "../../utility/SearchableNode";
import type { ViewHierarchyNode, ViewHierarchyResult } from "../../../models/ViewHierarchyResult";
import {
  applicationWindowCoverIndex,
  isFullyCoveredByApplicationWindow,
  ownPrototypeNodeSources,
  uniqueBySource,
  contains,
  type ApplicationWindowCoverIndex,
} from "../ApplicationWindowCover";
import {
  createIosVisibleTapContext,
  iosVisibleTapArea,
  type IosVisibleTapContext,
  resolveIosOwnedTapPoint,
} from "../../action/iosTapTargetOwnership";
import { visibleTapBounds } from "../../utility/ElementGeometry";
import { PROTOTYPE_LAYOUT_KINDS } from "../ownWindowFocus";
import type { Element } from "../../../models/Element";
import { isFalsy, isTruthy } from "../../../models/Element";
import {
  getToggleContentDescription,
  hasAccessibilityAction,
} from "../../utility/elementProperties";
import type { Affordance, ObserveResult, SkeletonElement } from "../../../models/ObserveResult";
import {
  getElementProvenance,
  getHierarchyNodeSource,
  getSearchableEntries,
  getCapturedKeyboard,
  isStrictAncestor,
} from "./elementProvenance";
import {
  nonEmptyString,
  boundsTuple,
  area,
  byReadingOrder,
  unionBounds,
  allElements,
  type ObserveElements,
  type SkeletonAccumulator,
} from "./skeletonProjection/rowModel";
import {
  detectImeWindow,
  isImeKeycap,
  imeAccumulator,
  getImeOccluder,
  resolveIosImeState,
  coveringImeOccluder,
  markAppRowsCoveredByIme,
  type ImeWindow,
} from "./skeletonProjection/ime";
import { assignDuplicateIndexes } from "./skeletonProjection/selectorIndexes";

export { assignDuplicateIndexes } from "./skeletonProjection/selectorIndexes";
export {
  getImeOccluder,
  getIosImeOccluder,
  getVisibleIosImeBounds,
  getImeOccluderForElement,
  tapPointOutsideIme,
} from "./skeletonProjection/ime";
export type { ImeOccluder } from "./skeletonProjection/ime";

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

/** Canonical emit order for affordances (matches the {@link Affordance} union). */
const AFFORDANCE_ORDER: readonly Affordance[] = ["tap", "long-press", "input", "scroll", "toggle"];

/** Class names alone do not make an unfocusable field an actionable input. */
function toSkeletonSearchable(el: Element): ReturnType<typeof toSearchable> {
  const searchable = toSearchable(el);
  const focusEvidence =
    isTruthy(el.focusable) || (el.focusable === undefined && isTruthy(el.clickable));
  if (!focusEvidence && !hasAccessibilityAction(el.actions, "set_text")) {
    return {
      ...searchable,
      affordances: searchable.affordances.filter((affordance) => affordance !== "input"),
    };
  }
  return searchable;
}

/** Preserve a named toggle's own state alongside its identifying label. */
function deriveSublabel(el: Element, label: string | undefined): string | undefined {
  return getToggleContentDescription(el) && el.text !== label ? nonEmptyString(el.text) : undefined;
}

/** Apply the shared disabled-only state marker to a row or its accumulator. */
function copyDisabledState(element: Element, row: Pick<SkeletonElement, "enabled">): void {
  if (isFalsy(element.enabled)) {
    row.enabled = false;
  }
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
  const { affordances, elementId, displayedLabel, testTag } = toSkeletonSearchable(element);
  const entry: SkeletonElement = { bounds, affordances };
  if (elementId !== undefined) {
    entry.elementId = elementId;
  }
  if (displayedLabel !== undefined) {
    entry.label = displayedLabel;
  }
  if (testTag !== undefined) {
    entry.testTag = testTag;
  }
  if (affordances.includes("toggle")) {
    entry.checked = isTruthy(element.checked);
  }
  copyDisabledState(element, entry);
  return entry;
}

/**
 * Surface `selected` and the state description for AutoMobile's own prototype nodes only (#10446).
 * Whether app rows should report them is an open owner decision, so app output is unchanged.
 */
function copyPrototypeState(
  element: Element,
  row: Pick<SkeletonAccumulator, "selected" | "stateDescription">,
  prototypeSources: ReadonlySet<object>,
): void {
  const source = getHierarchyNodeSource(element);
  if (!source || !prototypeSources.has(source)) {
    return;
  }
  if (isTruthy(element.selected)) {
    row.selected = true;
  }
  row.stateDescription ??= nonEmptyString(element["state-description"]);
}

/** NUL-joined identity so `(elementId, label, bounds)` triples dedup without straddling. */
function identityKey(
  elementId: string | undefined,
  label: string | undefined,
  bounds: SkeletonElement["bounds"],
): string {
  return [elementId ?? "", label ?? "", bounds.join(",")].join("\0");
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

/** Seed an accumulator from the first element seen for an identity. */
function newAccumulator(
  el: Element,
  { elementId, label, affordances, textSources }: ReturnType<typeof toSkeletonSearchable>,
  bounds: SkeletonElement["bounds"],
): SkeletonAccumulator {
  const acc: SkeletonAccumulator = {
    elementId,
    label,
    editableHint: affordances.includes("input") ? nonEmptyString(el["hint-text"]) : undefined,
    sublabel: deriveSublabel(el, label),
    bounds,
    affordances: new Set<Affordance>(),
  };
  if (textSources["hint-text"] === undefined) {
    acc.hintBesideLabel = true;
  }
  return acc;
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
  prototypeSources: ReadonlySet<object>,
): SkeletonAccumulator[] {
  const byIdentity = new Map<string, SkeletonAccumulator>();
  const appElements = allElements(elements).filter((element) => !isImeKeycap(element, ime));
  for (const el of appElements) {
    const bounds = boundsTuple(el);
    if (!bounds) {
      continue;
    }
    const searchable = toSkeletonSearchable(el);
    const { elementId, label, affordances } = searchable;
    const key = identityKey(elementId, label, bounds);

    let acc = byIdentity.get(key);
    if (!acc) {
      acc = newAccumulator(el, searchable, bounds);
      byIdentity.set(key, acc);
    }
    if (acc.provenance === undefined) {
      acc.provenance = getElementProvenance(el);
    }
    acc.target ??= el;
    for (const affordance of affordances) {
      acc.affordances.add(affordance);
    }
    if (affordances.includes("toggle")) {
      acc.checked = isTruthy(el.checked);
    }
    copyDisabledState(el, acc);
    copyPrototypeState(el, acc, prototypeSources);
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
  if (acc.stateDescription !== undefined) {
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
  prototypeSources: ReadonlySet<object>,
): void {
  if (clickable.length === 0) {
    return;
  }
  for (const [container, texts] of groupTextByContainer(accumulators, clickable)) {
    texts.sort(byReadingOrder);
    const parts = distinctHoistParts(container, texts);
    applyHoistedLabels(container, parts);
    adoptPrototypeIconLabel(container, parts, prototypeSources);
  }
}

/**
 * A tappable prototype container (a FAB) is labelled by its node kind ("box"), with its icon name
 * relegated to `sublabel`. When the icon is the container's only accessible content, the icon name
 * is the label and the kind label goes away. Only prototype rows qualify, so an app control that
 * happens to read "box" keeps its own label.
 */
function adoptPrototypeIconLabel(
  container: SkeletonAccumulator,
  parts: string[],
  prototypeSources: ReadonlySet<object>,
): void {
  const source = container.target && getHierarchyNodeSource(container.target);
  const kind = container.label?.trim();
  if (!source || !kind || !prototypeSources.has(source) || !PROTOTYPE_LAYOUT_KINDS.has(kind)) {
    return;
  }
  const content = parts.filter(
    (part) => !PROTOTYPE_LAYOUT_KINDS.has(part.trim()) && part.trim() !== "icon",
  );
  if (content.length !== 1 || content.length !== parts.length) {
    return;
  }
  container.label = content[0];
  delete container.sublabel;
}

/**
 * Use an editable field's placeholder as its label only when it has none after
 * descendant hoisting. A field that already has a label keeps it, and a distinct
 * hint is carried in `sublabel` so a filled field can still be told apart by the
 * placeholder it was addressed by before it had text (#9346). The hint is never
 * emitted as the label of a labelled field, so it cannot read as the field's value.
 */
function applyEditableHintFallback(accumulators: SkeletonAccumulator[]): void {
  for (const acc of accumulators) {
    const hint = acc.editableHint;
    if (hint === undefined || !acc.affordances.has("input")) {
      continue;
    }
    if (acc.label === undefined) {
      acc.label = hint;
    } else if (acc.hintBesideLabel && acc.label.trim() !== hint.trim()) {
      acc.sublabel = [...new Set([acc.sublabel?.trim(), hint.trim()].filter(Boolean))].join(", ");
    }
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

/** Distinct descendant labels, comparing trimmed forms including the container's own label. */
function distinctHoistParts(
  container: SkeletonAccumulator,
  texts: SkeletonAccumulator[],
): string[] {
  const parts: string[] = [];
  const seen = new Set([container.label?.trim()]);
  for (const text of texts) {
    const label = text.label;
    if (label !== undefined && !seen.has(label.trim())) {
      seen.add(label.trim());
      parts.push(label);
    }
  }
  return parts;
}

/**
 * Fold ordered descendant labels using the shared display/resolution contract.
 * An absent or whitespace-only own label takes the first part as its label.
 * Leading whitespace on a nonblank raw own label signals a dropped template
 * placeholder (" Alarm", issue #6221 item 3): prepend the first part to the
 * trimmed own label and put the remaining parts in `sublabel`. Trailing-only
 * whitespace is incidental (#6240); genuine own labels stay verbatim until
 * display trimming and take every part as `sublabel` (AC2 #5869).
 */
function applyHoistedLabels(container: SkeletonAccumulator, parts: string[]): void {
  Object.assign(container, foldSearchableLabels(container, parts));
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
  if (acc.occluded) {
    entry.occluded = true;
  }
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
    entry.label = displayedSearchableLabel(acc.label);
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
  if (acc.selected !== undefined) {
    entry.selected = acc.selected;
  }
  if (acc.stateDescription !== undefined) {
    entry.state = acc.stateDescription;
  }
  if (acc.enabled !== undefined) {
    entry.enabled = acc.enabled;
  }
  if (acc.index !== undefined) {
    entry.index = acc.index;
  }
  return entry;
}

/** Whether `acc` is genuine status-bar chrome, never the notification shade. */
function isSystemUiEntry(acc: SkeletonAccumulator): boolean {
  return isSystemUiStatusBarId(acc.elementId);
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
    if (acc.label !== undefined || !inheritsOwnerLabel(acc.affordances)) {
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
 * Mark rows that tapOn cannot reach because an application window (dialog, popup) above the
 * row's window covers it, using the same hit test as the tap path (issue #10481). Every
 * node-hosting AutoMobile prototype window above the row joins those covers, opaque, translucent,
 * sheet or floating alike (owner decision 2026-10-08, #10715): the prototype is touchable within its
 * bounds, so a tap there lands in the prototype, and default-layer tapOn refuses the row. A row with
 * an exposed part stays actionable, as tapOn taps that part. Like tapOn, the test runs on the
 * row's bounds clipped to the screen, so an off-screen remainder never counts as exposed.
 */
function markAppRowsCoveredByApplicationWindow(
  kept: SkeletonAccumulator[],
  hierarchy: ViewHierarchyResult | undefined,
  viewport: Pick<ObserveResult["screenSize"], "width" | "height"> | undefined,
): void {
  if (!hierarchy?.windows?.length) {
    return;
  }
  let coverIndex: ApplicationWindowCoverIndex | undefined;
  for (const acc of kept) {
    if (acc.occluded || !acc.target || acc.affordances.size === 0) {
      continue;
    }
    const [left, top, right, bottom] = acc.bounds;
    const bounds = visibleTapBounds({ left, top, right, bottom }, viewport);
    // Project the capture once for every row, not once per row.
    coverIndex ??= applicationWindowCoverIndex(hierarchy);
    if (
      bounds &&
      isFullyCoveredByApplicationWindow(hierarchy, acc.target, bounds, "touch", coverIndex)
    ) {
      acc.affordances.clear();
      acc.occluded = true;
    }
  }
}

/** Reuse tapOn's visible tap area and ownership verdict for iOS app affordances. */
function markIosRowsRefusedByTap(
  kept: SkeletonAccumulator[],
  elements: ObserveElements,
  viewport: ObserveResult["screenSize"] | undefined,
  hierarchy?: ViewHierarchyResult,
): void {
  const nodes = getSearchableEntries(elements);
  if (!nodes) {
    return;
  }
  const context = createIosVisibleTapContext(nodes, viewport, hierarchy);
  const bySource = new Map(uniqueBySource(nodes).map((node) => [node.source, node]));
  for (const acc of kept) {
    if (acc.occluded || !acc.target || acc.affordances.size === 0) {
      continue;
    }
    const source = getHierarchyNodeSource(acc.target);
    const target = source && bySource.get(source);
    if (!target || isImeKeyEntry(target) || acc.provenance?.keyboardPackage) {
      continue;
    }
    if (iosRowRefusedByTap(acc, nodes, target, viewport, context)) {
      acc.affordances.clear();
      acc.occluded = true;
    }
  }
}

function iosRowRefusedByTap(
  acc: SkeletonAccumulator,
  nodes: readonly SearchableEntry[],
  target: SearchableEntry,
  screen: ObserveResult["screenSize"] | undefined,
  context: IosVisibleTapContext | undefined,
): boolean {
  const [left, top, right, bottom] = acc.bounds;
  const screenBounds = visibleTapBounds({ left, top, right, bottom }, screen);
  if (!screenBounds) {
    return true;
  }
  const visibleBounds = iosVisibleTapArea({
    bounds: screenBounds,
    matched: acc.target!,
    target: acc.target!,
    nodes,
    context,
    targetNode: target,
  });
  if (!visibleBounds) {
    return true;
  }
  const point = {
    x: Math.floor((visibleBounds.left + visibleBounds.right) / 2),
    y: Math.floor((visibleBounds.top + visibleBounds.bottom) / 2),
  };
  return !!resolveIosOwnedTapPoint({
    nodes,
    target,
    matched: [target],
    screen,
    visibleBounds,
    candidates: [point],
    isValid: (candidate): candidate is { x: number; y: number } =>
      candidate !== null && contains(visibleBounds, candidate.x, candidate.y),
  }).coveredBy;
}

/**
 * Project the flattened `elements` block into the actionable `skeleton` and
 * informational `context` arrays (issue #6221 item 1): merge + dedup the
 * categories, apply the keep rule, split on affordance count, and collapse
 * the systemui status-bar block. Duplicate-id disambiguation (issue #6221 item
 * 2) runs only over the actionable set — a non-actionable duplicate is not
 * something a client will ever need to disambiguate for `tapOn`.
 */
export function projectSkeleton(
  elements: ObserveElements,
  viewport?: Pick<ObserveResult["screenSize"], "width" | "height">,
  androidHierarchy?: ViewHierarchyResult,
  options?: { ios?: boolean; iosHierarchy?: ViewHierarchyResult },
): SkeletonProjectionResult {
  const ime = detectImeWindow(elements);
  const prototypeSources = ownPrototypeNodeSources(androidHierarchy);
  const accumulators = accumulateByIdentity(elements, ime, prototypeSources);
  const clickable = accumulators.filter((acc) => acc.affordances.has("tap"));
  // Hoist descendant text onto labelless/underlabelled clickable rows (issue
  // #5869) before the keep filter suppresses the now-folded text accumulators.
  hoistContainerLabels(accumulators, clickable, prototypeSources);
  applyEditableHintFallback(accumulators);
  // …then attribute an owning row's label to the state-carrying containers that
  // hoisting deliberately never folds into (issue #6871).
  attributeContainerLabels(accumulators);

  const kept = accumulators.filter((acc) => shouldKeep(acc, clickable));
  const occluder = ime ? getImeOccluder(elements) : undefined;
  // A parked iOS keyboard is neither a covering rectangle nor a reportable keyboard.
  const iosIme = resolveIosImeState(ime, occluder, viewport);
  markAppRowsCoveredByIme(
    kept,
    coveringImeOccluder(ime, occluder, iosIme),
    occluder,
    viewport,
    options?.ios,
  );
  if (options?.ios) {
    markIosRowsRefusedByTap(kept, elements, viewport, options.iosHierarchy);
  }
  markAppRowsCoveredByApplicationWindow(kept, androidHierarchy, viewport);
  const actionable = kept.filter((acc) => acc.affordances.size > 0);
  const nonActionable = kept.filter((acc) => acc.affordances.size === 0);

  // One row for the whole IME window, appended last: the keyboard is a mode, not
  // a list of targets, so it must never come before the app's own affordances.
  const imeRow = iosIme?.parked ? undefined : imeAccumulator(elements, ime);
  if (imeRow) {
    actionable.push(imeRow);
  }

  // Number emitted rows against the same complete captured candidate set used
  // by positional resolution. Promoted sources and their owners share a slot.
  assignDuplicateIndexes(actionable, viewport, getSearchableEntries(elements));

  return {
    // Report only observed IME identity; missing capture evidence does not mean hidden.
    keyboard: iosIme?.parked
      ? undefined
      : (getCapturedKeyboard(elements) ??
        (ime ? { visible: true, package: ime.package } : undefined)),
    skeleton: actionable.map(toSkeletonEntry),
    context: collapseSystemUiBlock(nonActionable).map(toSkeletonEntry),
  };
}

/**
 * Associate the unchanged skeleton projection with captured source nodes for
 * diff replay. Bounds and identity survive label hoisting; where several rows
 * share them, the original label must select exactly one row. IME sources are
 * returned separately so collapsed keycaps cannot create duplicate groups.
 */
export function projectSkeletonReplayRows(
  elements: ObserveElements,
  projection: SkeletonProjectionResult,
): { rowsBySource: Map<ViewHierarchyNode, SkeletonElement>; imeSources: Set<ViewHierarchyNode> } {
  const rowsBySource = new Map<ViewHierarchyNode, SkeletonElement>();
  const imeSources = new Set<ViewHierarchyNode>();
  const ime = detectImeWindow(elements);
  for (const element of allElements(elements)) {
    const source = getHierarchyNodeSource(element);
    if (!source) {
      continue;
    }
    if (isImeKeycap(element, ime)) {
      imeSources.add(source);
      continue;
    }
    const bounds = boundsTuple(element);
    if (!bounds) {
      continue;
    }
    const { elementId, displayedLabel, affordances } = toSkeletonSearchable(element);
    const matches = projection.skeleton.filter(
      (row) =>
        row.elementId === elementId && row.bounds.every((edge, index) => edge === bounds[index]),
    );
    const row =
      matches.find((row) => row.label === displayedLabel) ??
      (matches.length === 1 && affordances.length > 0 ? matches[0] : undefined);
    if (row) {
      rowsBySource.set(source, row);
    }
  }
  return { rowsBySource, imeSources };
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

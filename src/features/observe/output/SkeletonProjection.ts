import type { Element } from "../../../models/Element";
import { isTruthy } from "../../../models/Element";
import { hasAccessibilityAction } from "../../../utils/elementProperties";
import type { Affordance, ObserveResult, SkeletonElement } from "../../../models/ObserveResult";

/**
 * Interactable Skeleton Projection (issue #4388).
 *
 * `toSkeleton` collapses the already-computed `ObserveResult.elements`
 * (`{ clickable, scrollable, text, media }`) into a flat, actionable-only list —
 * `{ id, label, bounds, affordances }` — dropping layout scaffolding. Embedded
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
 * `id` / `label` map directly onto the `tapOn` selector union (`elementId` /
 * `text`), so a skeleton row is issued as `tapOn({ elementId })` with no new
 * selector semantics (issue #4388 acceptance criterion 2).
 */

type ObserveElements = NonNullable<ObserveResult["elements"]>;

/** Canonical emit order for affordances (matches the {@link Affordance} union). */
const AFFORDANCE_ORDER: readonly Affordance[] = ["tap", "long-press", "input", "scroll", "toggle"];

/** A non-empty string value, or `undefined` (empty/whitespace/non-string reads as absent). */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * `id = resource-id ?? view-id`. The `view-id` slot is the stable content-hash
 * id from `assignStableViewIds` (`s-…`, #3228), so a row keeps its id across a
 * scroll. A test tag is carried separately for Compose owners that do not enable
 * `testTagsAsResourceId`.
 */
function deriveId(el: Element): string | undefined {
  return nonEmptyString(el["resource-id"]) ?? nonEmptyString(el["view-id"]);
}

/** `label = text ?? content-desc`. */
function deriveLabel(el: Element): string | undefined {
  return nonEmptyString(el.text) ?? nonEmptyString(el["content-desc"]);
}

/**
 * A focusable editable field: `focusable && (class ~ EditText || input-type
 * present)` (issue #4388 affordance table). Booleans are `boolean | string`
 * (XML yields `"true"`), so `isTruthy` handles both forms.
 */
function isInputField(el: Element): boolean {
  if (!isTruthy(el.focusable)) {
    return false;
  }
  const className = el.class;
  const isEditText = typeof className === "string" && className.includes("EditText");
  const hasInputType = nonEmptyString(el["input-type"]) !== undefined;
  return isEditText || hasInputType;
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
  if (isInputField(el)) {
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
  if (!b || typeof b !== "object") {
    return undefined;
  }
  const { left, top, right, bottom } = b;
  if ([left, top, right, bottom].some((v) => typeof v !== "number" || !Number.isFinite(v))) {
    return undefined;
  }
  return [left, top, right, bottom];
}

/** Working accumulator for one merged skeleton row, keyed by `(id, label, bounds)`. */
interface SkeletonAccumulator {
  id?: string;
  label?: string;
  sublabel?: string;
  testTag?: string;
  semanticLinks?: SkeletonElement["semanticLinks"];
  bounds: SkeletonElement["bounds"];
  affordances: Set<Affordance>;
  checked?: boolean;
}

/** NUL-joined identity so `(id, label, bounds)` triples dedup without straddling. */
function identityKey(
  id: string | undefined,
  label: string | undefined,
  bounds: SkeletonElement["bounds"],
): string {
  return [id ?? "", label ?? "", bounds.join(",")].join("\0");
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
 * Merge overlapping element categories into one accumulator per `(id, label,
 * bounds)` triple, unioning affordances. `text` overlaps `clickable`/`scrollable`
 * on real captures (a clickable node that carries text is in both), so the
 * identity key dedups them. `media` carries no actionable affordance and is
 * intentionally excluded. Elements without valid numeric bounds are skipped.
 */
function accumulateByIdentity(elements: ObserveElements): SkeletonAccumulator[] {
  const byIdentity = new Map<string, SkeletonAccumulator>();
  for (const el of [...elements.clickable, ...elements.scrollable, ...elements.text]) {
    const bounds = boundsTuple(el);
    if (!bounds) {
      continue;
    }
    const id = deriveId(el);
    const label = deriveLabel(el);
    const affordances = deriveAffordances(el);
    const key = identityKey(id, label, bounds);

    let acc = byIdentity.get(key);
    if (!acc) {
      acc = { id, label, bounds, affordances: new Set<Affordance>() };
      byIdentity.set(key, acc);
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
 * Keep rule (issue #4388): a row is kept if it has ≥1 affordance, carries
 * semantic links, OR carries a non-empty label with no clickable ancestor.
 * Semantic links remain independently discoverable even when the linked text is
 * inside a generic tappable card that would otherwise suppress its text row.
 */
function shouldKeep(
  acc: SkeletonAccumulator,
  clickableBounds: SkeletonElement["bounds"][],
): boolean {
  if (acc.affordances.size > 0) {
    return true;
  }
  if (acc.semanticLinks?.length) {
    return true;
  }
  if (acc.label === undefined) {
    return false;
  }
  return !clickableBounds.some((bounds) => strictlyContains(bounds, acc.bounds));
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
    const container = smallestClickableAncestor(acc.bounds, clickable);
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
 * Fold `parts` onto the container: the first becomes `label` when it has none,
 * and the remainder join into `sublabel`. A container with an own label keeps it
 * and takes every part as `sublabel`.
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
  } else {
    container.sublabel = parts.join(", ");
  }
}

/** Order two rows top-to-bottom, then left-to-right, by their bounds tuple. */
function byReadingOrder(a: SkeletonAccumulator, b: SkeletonAccumulator): number {
  return a.bounds[1] - b.bounds[1] || a.bounds[0] - b.bounds[0];
}

/**
 * The smallest-area clickable accumulator that strictly encloses `bounds`, or
 * `undefined` when none does. Smallest-area so text folds into its immediate row
 * rather than an outer clickable card or list that also encloses it.
 */
function smallestClickableAncestor(
  bounds: SkeletonElement["bounds"],
  clickable: SkeletonAccumulator[],
): SkeletonAccumulator | undefined {
  let best: SkeletonAccumulator | undefined;
  for (const candidate of clickable) {
    if (!strictlyContains(candidate.bounds, bounds)) {
      continue;
    }
    if (!best || area(candidate.bounds) < area(best.bounds)) {
      best = candidate;
    }
  }
  return best;
}

/** Materialize one accumulator into an emitted skeleton row (omitting absent optionals). */
function toSkeletonEntry(acc: SkeletonAccumulator): SkeletonElement {
  const entry: SkeletonElement = {
    bounds: acc.bounds,
    affordances: AFFORDANCE_ORDER.filter((affordance) => acc.affordances.has(affordance)),
  };
  if (acc.id !== undefined) {
    entry.id = acc.id;
  }
  if (acc.label !== undefined) {
    entry.label = acc.label;
  }
  if (acc.sublabel !== undefined) {
    entry.sublabel = acc.sublabel;
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
  return entry;
}

/**
 * Project the flattened `elements` block into an actionable-only skeleton
 * (issue #4388): merge + dedup the categories, apply the keep rule, and emit
 * `{ id, label, bounds, affordances }` rows with compact tuple bounds.
 */
export function toSkeleton(elements: ObserveElements): SkeletonElement[] {
  const accumulators = accumulateByIdentity(elements);
  const clickable = accumulators.filter((acc) => acc.affordances.has("tap"));
  // Hoist descendant text onto labelless/underlabelled clickable rows (issue
  // #5869) before the keep filter suppresses the now-folded text accumulators.
  hoistContainerLabels(accumulators, clickable);
  // Bounds of every tappable row, for the clickable-ancestor suppression test.
  const clickableBounds = clickable.map((acc) => acc.bounds);

  return accumulators.filter((acc) => shouldKeep(acc, clickableBounds)).map(toSkeletonEntry);
}

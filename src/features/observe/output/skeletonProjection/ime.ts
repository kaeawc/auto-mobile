import type { Element } from "../../../../models/Element";
import type { Affordance, ObserveResult, SkeletonElement } from "../../../../models/ObserveResult";
import {
  ElementProvenance,
  getElementProvenance,
  getHierarchyNodeSource,
  getSearchableEntries,
  getCapturedKeyboard,
  getUncollectedWrappers,
} from "../elementProvenance";
import {
  KEYCAP_ID_PATTERN,
  MIN_FALLBACK_KEYCAPS,
  isImeOwnedId,
  resourceIdPackage,
} from "../../android/ImeKeycapIds";
import {
  IOS_KEYBOARD_MIN_VISIBLE_HEIGHT,
  IOS_KEYBOARD_CONTAINER_CLASSES,
  clipRectToScreen,
  usableScreenExtent,
} from "../../ios/IosScreenIdentity";
import {
  allElements,
  area,
  boundsTuple,
  deriveId,
  unionBounds,
  type ObserveElements,
  type SkeletonAccumulator,
  type Bounds,
} from "./rowModel";

/**
 * Synthetic elementId for the collapsed IME row. Like
 * {@link SYSTEMUI_SUMMARY_ELEMENT_ID} it is deliberately NOT shaped like a real
 * `package:id/name` resource-id, so it can never be mistaken for a selector: the
 * supported way to drive a keyboard is `sendKeys`, never a tap per
 * keycap (issue #6871).
 */
const IME_ELEMENT_ID = "<ime>";

/** The owning package of a `package:id/name` resource-id, when it has that shape. */
function idPackage(el: Element): string | undefined {
  return resourceIdPackage(deriveId(el));
}

/**
 * The detected input-method window: its package, plus the provenance group and
 * pre-order span of the keyboard subtree — the nodes that identified it, widened
 * to the outermost node the IME owns around them (see
 * {@link widenToEnclosingImeSubtree}). The span lets an anonymous node between
 * two keycaps (a key with no resource-id) collapse too, without relaxing
 * membership to anything outside that one window's subtree.
 */
export interface ImeWindow {
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

/** A detected keyboard's measured rectangle and its window position. */
export interface ImeOccluder {
  bounds: Bounds;
  /** Docked iOS container chrome starts above the measured key union. */
  chromeTop?: number;
  /** Valid adjacent assistant subtree; its members keep the key-union cover. */
  assistantBar?: { bounds: Bounds; group: number; spanEnter: number; spanExit: number };
  group?: number;
  windowRank?: number;
  spanEnter: number;
  spanExit: number;
}

/** Share the skeleton's authoritative/keycap-corroborated IME detection with actions. */
export function getImeOccluder(elements: ObserveElements): ImeOccluder | undefined {
  const ime = detectImeWindow(elements);
  const row = imeAccumulator(elements, ime);
  if (!ime) {
    return undefined;
  }
  if (!row) {
    // Minimized iOS keyboards have no collected keys, only an inert layout wrapper.
    // Its inherited IME provenance still identifies the parked keyboard's bounds.
    const wrapper =
      ime.package === "com.apple.keyboard"
        ? getUncollectedWrappers(elements).find(
            (el) => getElementProvenance(el)?.keyboardPackage === ime.package,
          )
        : undefined;
    const bounds = wrapper && boundsTuple(wrapper);
    const provenance = wrapper && getElementProvenance(wrapper);
    return bounds && provenance
      ? {
          bounds,
          group: provenance.group,
          windowRank: provenance.windowRank,
          spanEnter: provenance.enter,
          spanExit: provenance.exit,
        }
      : undefined;
  }
  const member = imeCandidates(elements, ime).find((el) => isImeKeycap(el, ime));
  const provenance = member && getElementProvenance(member);
  return {
    bounds: measuredImeOcclusionBounds(elements, ime, row.bounds, provenance?.keyboardWindowBounds),
    group: ime.group,
    windowRank: provenance?.windowRank,
    spanEnter: ime.spanEnter,
    spanExit: ime.spanExit,
    ...(ime.package === "com.apple.keyboard" ? iosKeyboardChrome(elements, ime) : {}),
  };
}

/** Use the capture's container and adjacent assistant, never an app-sized inputView wrapper. */
function iosKeyboardChrome(elements: ObserveElements, ime: ImeWindow): Partial<ImeOccluder> {
  const nodes = getSearchableEntries(elements) ?? [];
  const container = nodes.find(
    (node) =>
      node.rootGroup === ime.group &&
      IOS_KEYBOARD_CONTAINER_CLASSES.has(node.className ?? "") &&
      node.bounds &&
      Object.values(node.bounds).every(Number.isFinite) &&
      node.bounds.bottom > node.bounds.top,
  );
  if (!container?.bounds) {
    return {};
  }
  const assistant = [...allElements(elements), ...getUncollectedWrappers(elements)].find(
    (element) => {
      const provenance = getElementProvenance(element);
      const bounds = element.bounds;
      return (
        element["resource-id"] === "SystemInputAssistantView" &&
        provenance?.group === ime.group &&
        Object.values(bounds).every(Number.isFinite) &&
        bounds.bottom > bounds.top &&
        Math.abs(bounds.bottom - container.bounds!.top) <= 1
      );
    },
  );
  const provenance = assistant && getElementProvenance(assistant);
  return {
    chromeTop: container.bounds.top,
    ...(assistant && provenance
      ? {
          assistantBar: {
            bounds: boundsTuple(assistant)!,
            group: provenance.group,
            spanEnter: provenance.enter,
            spanExit: provenance.exit,
          },
        }
      : {}),
  };
}

function isAssistantBarMember(
  provenance: ElementProvenance | undefined,
  ime: ImeOccluder,
): boolean {
  const bar = ime.assistantBar;
  return (
    !!bar &&
    provenance?.group === bar.group &&
    provenance.enter >= bar.spanEnter &&
    provenance.exit <= bar.spanExit
  );
}

/** Window frames own touches; legacy captures fall back to measured IME members. */
function measuredImeOcclusionBounds(
  elements: ObserveElements,
  ime: ImeWindow,
  fallback: Bounds,
  frame?: Element["bounds"],
): Bounds {
  if (frame) {
    return [frame.left, frame.top, frame.right, frame.bottom];
  }
  // Uncollected wrappers can span the app and cannot establish physical occlusion.
  const boxes = allElements(elements)
    .filter((el) => isImeKeycap(el, ime))
    .map(boundsTuple)
    .filter((box): box is NonNullable<Bounds> => box !== undefined);
  return boxes.length > 0 ? unionBounds(boxes) : fallback;
}

/** Action-only iOS geometry; skeleton projection retains measured keyboard bounds. */
export function getIosImeOccluder(
  occluder: ImeOccluder,
  screenSize?: ObserveResult["screenSize"],
): ImeOccluder {
  if (
    !screenSize ||
    !clipImeBounds(occluder.bounds, screenSize) ||
    occluder.bounds[2] - occluder.bounds[0] < screenSize.width * 0.9
  ) {
    return occluder;
  }
  // Docked keys omit container chrome, assistant bar, side margins and the bottom strip.
  const bar = occluder.assistantBar;
  const top =
    bar && bar.bounds[2] - bar.bounds[0] >= screenSize.width * 0.9
      ? Math.min(occluder.chromeTop ?? occluder.bounds[1], bar.bounds[1])
      : (occluder.chromeTop ?? occluder.bounds[1]);
  return { ...occluder, bounds: [0, top, screenSize.width, screenSize.height] };
}

/** Clip shared iOS action geometry to the screen; parked keyboards have no visible rectangle. */
export function getVisibleIosImeBounds(
  occluder: ImeOccluder,
  screenSize: ObserveResult["screenSize"],
): Bounds | undefined {
  if (!screenSize) {
    return undefined;
  }
  const measured = clipImeBounds(occluder.bounds, screenSize);
  if (!measured || measured[3] - measured[1] < IOS_KEYBOARD_MIN_VISIBLE_HEIGHT) {
    return undefined;
  }
  const clipped = clipImeBounds(getIosImeOccluder(occluder, screenSize).bounds, screenSize);
  return clipped && clipped[3] - clipped[1] >= IOS_KEYBOARD_MIN_VISIBLE_HEIGHT
    ? clipped
    : undefined;
}

function clipImeBounds(
  bounds: Bounds,
  screenSize: NonNullable<ObserveResult["screenSize"]>,
): Bounds | undefined {
  return clipRectToScreen(bounds, screenSize);
}

function isBelowImeWindow(provenance: ElementProvenance | undefined, ime: ImeOccluder): boolean {
  if (
    ime.group !== undefined &&
    provenance?.group === ime.group &&
    provenance.enter >= ime.spanEnter &&
    provenance.exit <= ime.spanExit
  ) {
    return false;
  }
  return !(
    provenance?.windowRank !== undefined &&
    ime.windowRank !== undefined &&
    provenance.windowRank < ime.windowRank
  );
}

function isSameHierarchyNode(candidate: Element, target: Element): boolean {
  if (candidate === target) {
    return true;
  }
  const candidateSource = getHierarchyNodeSource(candidate);
  const targetSource = getHierarchyNodeSource(target);
  if (candidateSource && targetSource) {
    return candidateSource === targetSource;
  }
  return (
    candidate.bounds.left === target.bounds.left &&
    candidate.bounds.top === target.bounds.top &&
    candidate.bounds.right === target.bounds.right &&
    candidate.bounds.bottom === target.bounds.bottom &&
    candidate["resource-id"] === target["resource-id"]
  );
}

/** Resolve occlusion only for a lower-window app target, never for an IME member. */
export function getImeOccluderForElement(
  elements: ObserveElements,
  element: Element,
): ImeOccluder | undefined {
  const ime = detectImeWindow(elements);
  const occluder = getImeOccluder(elements);
  if (!ime || !occluder) {
    return undefined;
  }
  const candidates = occluder.assistantBar
    ? [...allElements(elements), ...getUncollectedWrappers(elements)]
    : allElements(elements);
  const match = candidates.find((candidate) => isSameHierarchyNode(candidate, element));
  if (match && isImeKeycap(match, ime)) {
    return undefined;
  }
  const provenance = match && getElementProvenance(match);
  if (isAssistantBarMember(provenance, occluder)) {
    // Predictions are keyboard chrome themselves; only the original key union covers them.
    return { ...occluder, chromeTop: undefined, assistantBar: undefined };
  }
  return isBelowImeWindow(provenance, occluder) ? occluder : undefined;
}

/**
 * Keep the ordinary center when exposed. Otherwise choose the center of the
 * largest remaining rectangle; equal areas prefer top, bottom, left, right.
 */
export function tapPointOutsideIme(bounds: Bounds, ime: Bounds): { x: number; y: number } | null {
  const center = (box: Bounds) => ({
    x: Math.floor((box[0] + box[2]) / 2),
    y: Math.floor((box[1] + box[3]) / 2),
  });
  const original = center(bounds);
  const contains = (point: { x: number; y: number }) =>
    point.x >= ime[0] && point.x < ime[2] && point.y >= ime[1] && point.y < ime[3];
  if (!contains(original)) {
    return original;
  }
  const candidates: Bounds[] = [
    [bounds[0], bounds[1], bounds[2], Math.min(bounds[3], ime[1])],
    [bounds[0], Math.max(bounds[1], ime[3]), bounds[2], bounds[3]],
    [bounds[0], bounds[1], Math.min(bounds[2], ime[0]), bounds[3]],
    [Math.max(bounds[0], ime[2]), bounds[1], bounds[2], bounds[3]],
  ];
  const visible = candidates
    .filter((box) => area(box) > 0)
    .sort((a, b) => area(b) - area(a))
    .find((box) => !contains(center(box)));
  return visible ? center(visible) : null;
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
export function detectImeWindow(elements: ObserveElements): ImeWindow | undefined {
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
 * remove while still folding the toolbar. Driving the keyboard is `sendKeys`,
 * never a tap inside its window, so one row is the honest shape.
 */
export function isImeKeycap(el: Element, ime: ImeWindow | undefined): boolean {
  if (!ime || !isImeMember(el, ime)) {
    return false;
  }
  return isImeOwnedId(deriveId(el), ime.package);
}

/**
 * The single row that replaces every keycap: `<ime> | Keyboard (<package>) |
 * input` (issue #6871). `input` is the only honest affordance — `sendKeys` is
 * the supported way to drive it. Absent when the IME was
 * identified but contributed no bounded node (the `keyboard` summary still
 * reports it), so the row never claims a box it does not have.
 */
export function imeAccumulator(
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

const IOS_KEYBOARD_PACKAGE = "com.apple.keyboard";

/**
 * Whether the iOS keyboard the capture identified is on screen. Absent when it
 * cannot be judged (Android, no measured keyboard rectangle, or no usable
 * screen size) — callers then keep the evidence-only reading.
 */
type IosImeState = { parked: true } | { parked: false; bounds: Bounds };

export function resolveIosImeState(
  ime: ImeWindow | undefined,
  occluder: ImeOccluder | undefined,
  viewport: Pick<ObserveResult["screenSize"], "width" | "height"> | undefined,
): IosImeState | undefined {
  if (ime?.package !== IOS_KEYBOARD_PACKAGE || !occluder || !viewport) {
    return undefined;
  }
  const screen = usableScreenExtent(viewport.width, viewport.height);
  if (!screen) {
    return undefined;
  }
  // The same clip + minimum-height rule as isIosKeyboardVisible, on the measured union.
  const bounds = getVisibleIosImeBounds(occluder, screen);
  return bounds ? { parked: false, bounds } : { parked: true };
}

/** The rectangle that physically covers app rows; a parked iOS keyboard covers nothing. */
export function coveringImeOccluder(
  ime: ImeWindow | undefined,
  occluder: ImeOccluder | undefined,
  iosIme: IosImeState | undefined,
): ImeOccluder | undefined {
  if (ime?.package !== IOS_KEYBOARD_PACKAGE) {
    return occluder;
  }
  return occluder && iosIme && !iosIme.parked ? { ...occluder, bounds: iosIme.bounds } : undefined;
}

export function markAppRowsCoveredByIme(
  kept: SkeletonAccumulator[],
  occluder: ImeOccluder | undefined,
  {
    measured,
    screen,
    ios = false,
  }: { measured?: ImeOccluder; screen?: ObserveResult["screenSize"]; ios?: boolean } = {},
): void {
  if (!occluder) {
    return;
  }
  for (const acc of kept) {
    if (!isBelowImeWindow(acc.provenance, occluder)) {
      continue;
    }
    const cover: Bounds =
      measured && isAssistantBarMember(acc.provenance, occluder)
        ? [occluder.bounds[0], measured.bounds[1], occluder.bounds[2], occluder.bounds[3]]
        : occluder.bounds;
    const bounds = ios && screen ? clipRectToScreen(acc.bounds, screen) : acc.bounds;
    if (bounds && tapPointOutsideIme(bounds, cover) !== null) {
      continue;
    }
    // Every advertised action on a fully covered row requires a coordinate or
    // focus there; keep its label/state in context without promising an action.
    acc.affordances.clear();
    acc.occluded = true;
  }
}

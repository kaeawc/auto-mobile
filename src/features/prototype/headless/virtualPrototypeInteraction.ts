import type { PrototypeEvent, PrototypeState } from "../../observe/android/ctrlProxyProtocol";
import { resolveEmitContext } from "../prototypeEmitContext";
import { prototypeNodeChildren } from "../prototypeNodeChildren";
import type { PrototypeJson } from "../prototypeSpec";
import { record, renderScalar, type Raw } from "../prototypeTemplate";
import { validatePrototypeSpec } from "../prototypeValidation";
import { decide } from "../web/webCondition";
import { boundPages, normalizePagerState } from "./virtualPrototypePagers";
import contract from "../../../../schemas/prototype-spec-contract.json";

/**
 * Host-side input on the headless virtual device (#18360): finds the node a `tapOn` names in the
 * shown spec and runs its interaction with the device runtime's ordering (`PrototypeRuntime.control`
 * and `run`): a control's own write and its `change` first, then the action list, where `emit`
 * carries the state as it is at that point and one trailing `change` names every key the list
 * changed. Actions the virtual device cannot run are refused before anything changes.
 */

type PrototypeStacks = NonNullable<PrototypeEvent["stacks"]>;

/** What the virtual device holds for one shown prototype, read and never mutated here. */
export interface VirtualPrototypeSnapshot {
  spec: Raw;
  state: PrototypeState;
  pages: Record<string, number>;
  stacks: PrototypeStacks;
}

/** A `tapOn` selector the virtual device can resolve. */
export interface VirtualTapSelector {
  text?: string;
  elementId?: string;
  testTag?: string;
  /** Only an exact, case-insensitive text match counts; otherwise a substring is the fallback. */
  exactText?: boolean;
}

/** One event the interaction raises, with the state, pages and stacks it carries. */
export interface VirtualPrototypeStep {
  kind: PrototypeEvent["kind"];
  name: string | null;
  payload: PrototypeJson;
  context?: Record<string, PrototypeJson>;
  /** The context was cut to the shared emit byte budget, as the device runtime cuts it. */
  contextTruncated?: true;
  state: PrototypeState;
  pages: Record<string, number>;
  stacks: PrototypeStacks;
}

/** What a tap on a node does, as the device runtime classifies it. */
export type VirtualInteraction =
  | { type: "tap"; actions: Raw[] }
  | { type: "toggle"; key: string; actions: Raw[] }
  /** A tab or bottom-nav item with no pager: writes its index to the bar's `stateKey`. */
  | { type: "select"; key: string; index: number; actions: Raw[] }
  | { type: "focus"; key: string; actions: Raw[] }
  | { type: "close"; condition: Raw; actions: Raw[] };

/** The node a selector matched and the interaction its tap runs, if anything handles it. */
export interface VirtualTapTarget {
  node: Raw;
  /** Undefined for a dead tap: nothing on the path to the root handles it. */
  interaction?: VirtualInteraction;
  /** False when the handling control's `enabledWhen` does not hold: the tap does nothing. */
  enabled: boolean;
  /**
   * The condition on the path to the target the virtual device cannot decide (a `data`,
   * `platform` or `valid` condition), if any: the input is refused rather than guessed.
   */
  undecidable?: string;
}

export interface VirtualInteractionPlan {
  steps: VirtualPrototypeStep[];
  /** A `dismiss` action ran: the prototype is gone after its `dismissed` event. */
  dismissed: boolean;
  /** A `hideKeyboard` action ran: the focused field loses focus. */
  blurred: boolean;
  /** The state, pages and stacks the interaction leaves, whether or not an event carries them. */
  state: PrototypeState;
  pages: Record<string, number>;
  stacks: PrototypeStacks;
  /**
   * Keys a write changed that no delivered event records, such as a key set and restored with no
   * event in between: the device still stamps them with the input's revision.
   */
  unrecordedWrites: string[];
  /** Why the device runtime's validator rejects a write: nothing is applied or emitted. */
  rejection?: string;
}

const TEXT_FIELDS = ["text", "label", "headline", "title", "placeholder", "contentDescription"];
const OPEN_WHEN_NODES = new Set(["dialog", "bottomSheet", "snackbar", "drawer", "tooltip", "menu"]);
/**
 * Open layers drawn over the whole tree that take every touch outside them: the device hoists
 * these above the author tree, and only the topmost one, and layers above it, can be tapped.
 * A snackbar and a tooltip pass touches through, so they never block the tree below.
 */
const BLOCKING_LAYERS = new Set(["dialog", "bottomSheet", "drawer", "menu"]);
const TOGGLE_NODES = new Set(["switch", "checkbox", "chip"]);
const FOCUS_NODES = new Set(["textField", "searchBar"]);
const RUNNABLE_ACTIONS = new Set([
  "emit",
  "setState",
  "toggle",
  "increment",
  "decrement",
  "setPage",
  "dismiss",
  "hideKeyboard",
  "push",
  "pop",
  "popToRoot",
  "replace",
]);
const STACK_ACTIONS = new Set(["push", "pop", "popToRoot", "replace"]);
const CONTEXT_BINDINGS = new Set(["state", "page", "data", "value"]);
/** Fields the device interpolates `{key}` state tokens into before it renders them. */
const INTERPOLATED_FIELDS = new Set(["text", "title"]);
const STATE_TOKEN = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
/** Placeholders only a pager page binds; elsewhere the device renders them literally. */
const PAGER_TOKENS = new Set(["page", "pageCount"]);

/** The objects among `values`, in order. */
const records = (values: readonly unknown[]): Raw[] =>
  values.map((value) => record(value)).filter((value): value is Raw => value !== undefined);

const actionList = (value: unknown): Raw[] => (Array.isArray(value) ? records(value) : []);

const isOpen = (node: Raw, state: PrototypeState): boolean => {
  const condition = record(node.openWhen);
  return !condition || state[String(condition.key)] === condition.equals;
};

/** The boolean key a `listItem`'s trailing switch or checkbox binds; the row toggles it. */
function listItemToggleKey(node: Raw): string | undefined {
  const trailing = node.type === "listItem" ? record(node.trailing) : undefined;
  return trailing &&
    (trailing.type === "switch" || trailing.type === "checkbox") &&
    typeof trailing.stateKey === "string"
    ? trailing.stateKey
    : undefined;
}

/** The interaction a node itself handles, if any. */
function ownInteraction(node: Raw): VirtualInteraction | undefined {
  const actions = actionList(node.onTap);
  const toggled = listItemToggleKey(node);
  if (toggled !== undefined) {
    return { type: "toggle", key: toggled, actions };
  }
  const key = typeof node.stateKey === "string" ? node.stateKey : undefined;
  if (key !== undefined && FOCUS_NODES.has(String(node.type))) {
    return { type: "focus", key, actions };
  }
  if (key !== undefined && TOGGLE_NODES.has(String(node.type))) {
    return { type: "toggle", key, actions };
  }
  return actions.length > 0 ? { type: "tap", actions } : undefined;
}

/** A search bar renders its results only while its `activeKey` holds true. */
const isExpanded = (node: Raw, state: PrototypeState): boolean =>
  typeof node.activeKey === "string" && state[node.activeKey] === true;

/** A pager's current page: the only one a tap reaches. */
function pagerChildren(node: Raw, id: string, snapshot: VirtualPrototypeSnapshot): Raw[] {
  return Array.isArray(node.children) ? records([node.children[snapshot.pages[id] ?? 0]]) : [];
}

/** A stack's top screen: the only one it renders. */
function stackChildren(node: Raw, id: string, snapshot: VirtualPrototypeSnapshot): Raw[] {
  const top = snapshot.stacks[id]?.path.at(-1) ?? String(node.start);
  const screens = record(node.screens) ?? {};
  return Object.hasOwn(screens, top) ? records([screens[top]]) : [];
}

/** The children a tap can reach: only open, visible content, a pager's page and a stack's top. */
function visibleChildren(node: Raw, snapshot: VirtualPrototypeSnapshot): Raw[] {
  if (node.repeat !== undefined) {
    // Repeat templates are bound on the device; their instances are not modelled here.
    return [];
  }
  const id = typeof node.id === "string" ? node.id : undefined;
  if (node.type === "pager" && id !== undefined) {
    return pagerChildren(node, id, snapshot);
  }
  if (node.type === "stack" && id !== undefined) {
    return stackChildren(node, id, snapshot);
  }
  if (node.type === "searchBar" && !isExpanded(node, snapshot.state)) {
    return [];
  }
  return records(prototypeNodeChildren(node).map(({ value }) => value));
}

type Decision = boolean | undefined;

function allOf(decisions: Decision[]): Decision {
  if (decisions.includes(false)) {
    return false;
  }
  return decisions.includes(undefined) ? undefined : true;
}

function anyOf(decisions: Decision[]): Decision {
  if (decisions.includes(true)) {
    return true;
  }
  return decisions.includes(undefined) ? undefined : false;
}

/** A string operator as `PrototypeCondition.holds` reads it: a non-string value never holds. */
function stringOperator(raw: Raw, value: unknown): Decision {
  const text = typeof value === "string" ? value : undefined;
  if (typeof raw.contains === "string") {
    return text !== undefined && text.includes(raw.contains);
  }
  if (typeof raw.startsWith === "string") {
    return text !== undefined && text.startsWith(raw.startsWith);
  }
  if (typeof raw.lengthGt === "number") {
    return text !== undefined && text.length > raw.lengthGt;
  }
  if (typeof raw.lengthLt === "number") {
    return text !== undefined && text.length < raw.lengthLt;
  }
  return undefined;
}

/**
 * A `visibleWhen` or `enabledWhen` condition as the device runtime decides it, string operators
 * included; undefined for what the virtual device does not model (`data`, `platform`, `valid`).
 */
export function decideVirtualCondition(condition: unknown, state: PrototypeState): Decision {
  const raw = record(condition);
  if (!raw) {
    return undefined;
  }
  if (Array.isArray(raw.all)) {
    return allOf(raw.all.map((entry) => decideVirtualCondition(entry, state)));
  }
  if (Array.isArray(raw.any)) {
    return anyOf(raw.any.map((entry) => decideVirtualCondition(entry, state)));
  }
  if (raw.not !== undefined) {
    const inner = decideVirtualCondition(raw.not, state);
    return inner === undefined ? undefined : !inner;
  }
  if (typeof raw.key === "string") {
    const text = stringOperator(raw, state[raw.key]);
    if (text !== undefined) {
      return text;
    }
  }
  return decide(raw, { state, platform: "android" });
}

/** Whether a node is shown; undefined when its `visibleWhen` cannot be decided here. */
function isShown(node: Raw, state: PrototypeState): Decision {
  if (OPEN_WHEN_NODES.has(String(node.type)) && !isOpen(node, state)) {
    return false;
  }
  return node.visibleWhen === undefined ? true : decideVirtualCondition(node.visibleWhen, state);
}

function interpolated(text: string, state: PrototypeState): string {
  return text.replace(STATE_TOKEN, (whole, key: string) =>
    !PAGER_TOKENS.has(key) && Object.hasOwn(state, key) ? renderScalar(state[key]) : whole,
  );
}

/**
 * The text a node shows, as `prototypeNodeText` renders it: `{key}` state tokens interpolated in
 * text and titles, and a text field's or search bar's current value from its bound key.
 */
function renderedTexts(node: Raw, state: PrototypeState): string[] {
  const authored = TEXT_FIELDS.flatMap((field) => {
    const value = node[field];
    if (typeof value !== "string") {
      return [];
    }
    return [INTERPOLATED_FIELDS.has(field) ? interpolated(value, state) : value];
  });
  const key = typeof node.stateKey === "string" ? node.stateKey : undefined;
  const bound = key === undefined ? undefined : state[key];
  return FOCUS_NODES.has(String(node.type)) && typeof bound === "string" && bound !== ""
    ? [...authored, bound]
    : authored;
}

function textMatches(node: Raw, text: string, exact: boolean, state: PrototypeState): boolean {
  const wanted = text.trim().toLowerCase();
  return renderedTexts(node, state).some((value) => {
    const own = value.trim().toLowerCase();
    return exact ? own === wanted : own.includes(wanted);
  });
}

function selectorMatches(
  node: Raw,
  selector: VirtualTapSelector,
  exact: boolean,
  state: PrototypeState,
): boolean {
  if (selector.elementId !== undefined || selector.testTag !== undefined) {
    const wanted = selector.elementId ?? selector.testTag;
    return node.id === wanted || node.testTag === wanted;
  }
  return selector.text !== undefined && textMatches(node, selector.text, exact, state);
}

/**
 * A dialog's confirm and dismiss buttons and a snackbar's action button close it, then run their
 * own actions, as `CloseModal` does on the device.
 */
function closingButtonTargets(node: Raw): Raw[] {
  const buttons =
    node.type === "dialog"
      ? [node.confirm, node.dismiss]
      : node.type === "snackbar"
        ? [node.action]
        : [];
  const condition = record(node.openWhen) ?? {};
  const type = node.type === "dialog" ? "dialogButton" : "snackbarAction";
  return records(buttons).map((button) => ({ ...button, type, closes: condition }) satisfies Raw);
}

const NAV_BARS = new Set(["tabBar", "bottomNav"]);

/**
 * A tab bar's or bottom nav's items, each a target selecting its index as `Select` does: with a
 * pager, a `setPage` before the bar's `onTap`; otherwise a write of the index to its `stateKey`.
 */
function navItemTargets(node: Raw): Raw[] {
  if (!NAV_BARS.has(String(node.type)) || !Array.isArray(node.items)) {
    return [];
  }
  return node.items.flatMap((value, index) => {
    const item = record(value);
    return item
      ? [
          {
            ...item,
            type: `${String(node.type)}Item`,
            selects: { bar: node, index },
            ...(node.enabledWhen === undefined ? {} : { enabledWhen: node.enabledWhen }),
          } satisfies Raw,
        ]
      : [];
  });
}

function selectInteraction(selects: Raw): VirtualInteraction | undefined {
  const bar = record(selects.bar) ?? {};
  const index = Number(selects.index);
  const actions = actionList(bar.onTap);
  if (typeof bar.pager === "string") {
    return {
      type: "tap",
      actions: [{ type: "setPage", pager: bar.pager, page: index }, ...actions],
    };
  }
  if (typeof bar.stateKey === "string") {
    return { type: "select", key: bar.stateKey, index, actions };
  }
  return actions.length > 0 ? { type: "tap", actions } : undefined;
}

interface Visit {
  node: Raw;
  handler?: { node: Raw; interaction: VirtualInteraction };
  /** The undecidable `visibleWhen` on the path to this node, if any. */
  undecidable?: string;
  /** The preorder index of the innermost hoisted layer around this node; 0 is the author tree. */
  layer: number;
}

function handlerFor(node: Raw, inherited: Visit["handler"]): Visit["handler"] {
  if (node.type === "dialogButton" || node.type === "snackbarAction") {
    const condition = record(node.closes) ?? {};
    return { node, interaction: { type: "close", condition, actions: actionList(node.onTap) } };
  }
  const selects = record(node.selects);
  if (selects !== undefined) {
    const interaction = selectInteraction(selects);
    return interaction ? { node, interaction } : inherited;
  }
  const own = ownInteraction(node);
  return own ? { node, interaction: own } : inherited;
}

const nodeName = (node: Raw): string =>
  typeof node.id === "string" ? `${String(node.type)} ${node.id}` : `a ${String(node.type)}`;

/**
 * Every tappable node in render order, each with the nearest ancestor-or-self that handles it.
 * While a blocking layer is open, only nodes in the topmost one, or in a layer drawn above it,
 * are reachable: the device hoists open layers above the tree in tree order.
 */
function visibleNodes(snapshot: VirtualPrototypeSnapshot): Visit[] {
  const root = record(snapshot.spec.root);
  const pending: Visit[] = root ? [{ node: root, layer: 0 }] : [];
  const visits: Visit[] = [];
  let layers = 0;
  let topBlocking = 0;
  while (pending.length > 0) {
    const { node, handler: inherited, undecidable: above, layer: outer } = pending.shift()!;
    const shown = isShown(node, snapshot.state);
    if (shown === false) {
      continue;
    }
    const undecidable =
      above ?? (shown === undefined ? `visibleWhen on ${nodeName(node)}` : undefined);
    const hoisted = OPEN_WHEN_NODES.has(String(node.type));
    const layer = hoisted ? ++layers : outer;
    if (hoisted && BLOCKING_LAYERS.has(String(node.type))) {
      topBlocking = layer;
    }
    const handler = handlerFor(node, inherited);
    visits.push({ node, handler, layer, ...(undecidable ? { undecidable } : {}) });
    const children = [
      ...closingButtonTargets(node),
      ...navItemTargets(node),
      ...visibleChildren(node, snapshot),
    ];
    pending.unshift(...children.map((child) => ({ node: child, handler, undecidable, layer })));
  }
  return visits.filter((visit) => visit.layer >= topBlocking);
}

/** The first visible node the selector names: an exact text match first, then a substring. */
export function findVirtualTapTarget(
  snapshot: VirtualPrototypeSnapshot,
  selector: VirtualTapSelector,
): VirtualTapTarget | undefined {
  const visits = visibleNodes(snapshot);
  const matches = (exact: boolean) => (visit: Visit) =>
    selectorMatches(visit.node, selector, exact, snapshot.state);
  const match =
    visits.find(matches(true)) ??
    (selector.exactText === true ? undefined : visits.find(matches(false)));
  return match ? tapTarget(match, snapshot.state) : undefined;
}

function tapTarget(visit: Visit, state: PrototypeState): VirtualTapTarget {
  const handler = visit.handler;
  const enabledWhen = handler?.node.enabledWhen;
  const enabled = enabledWhen === undefined ? true : decideVirtualCondition(enabledWhen, state);
  const undecidable =
    visit.undecidable ??
    (enabled === undefined ? `enabledWhen on ${nodeName(handler!.node)}` : undefined);
  return {
    node: visit.node,
    interaction: handler?.interaction,
    enabled: enabled === true,
    ...(undecidable ? { undecidable } : {}),
  };
}

/**
 * The text field bound to `key` while it is still shown, reachable, decidably visible and enabled,
 * so it can take input: a field hidden, patched away, covered by a modal or left behind on another
 * stack screen cannot. Returned as it is now, so a patched `maxLength` applies.
 */
export function virtualFocusableField(
  snapshot: VirtualPrototypeSnapshot,
  key: string,
): Raw | undefined {
  return visibleNodes(snapshot).find((visit) => {
    const handler = visit.handler;
    if (handler?.node !== visit.node || handler.interaction.type !== "focus") {
      return false;
    }
    const target = tapTarget(visit, snapshot.state);
    return handler.interaction.key === key && target.enabled && !target.undecidable;
  })?.node;
}

function findNode(spec: Raw, type: string, id: string): Raw | undefined {
  const pending = records([spec.root]);
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.type === type && node.id === id) {
      return node;
    }
    pending.push(...records(prototypeNodeChildren(node).map(({ value }) => value)));
  }
  return undefined;
}

function unsupportedContext(action: Raw): string | undefined {
  const context = record(action.context) ?? {};
  const binding = records(Object.values(context)).find(
    (value) => !Object.keys(value).every((key) => CONTEXT_BINDINGS.has(key)),
  );
  return binding ? `emit context ${Object.keys(binding).join(",")}` : undefined;
}

function unsupportedStackAction(action: Raw, spec: Raw): string | undefined {
  const stack = findNode(spec, "stack", String(action.stack));
  if (stack?.routes !== undefined || action.params !== undefined) {
    return `${String(action.type)} on a stack with routes or params`;
  }
  return undefined;
}

/** Why the virtual device cannot run one action, or undefined when it can. */
function unsupportedAction(action: Raw, spec: Raw): string | undefined {
  const type = String(action.type);
  if (!RUNNABLE_ACTIONS.has(type)) {
    return type;
  }
  if (type === "emit") {
    return action.requireValid !== undefined ? "emit requireValid" : unsupportedContext(action);
  }
  if (type === "setState" && record(action.value) !== undefined) {
    return `setState with a ${Object.keys(record(action.value)!).join(",")} value`;
  }
  return STACK_ACTIONS.has(type) ? unsupportedStackAction(action, spec) : undefined;
}

/** Why the virtual device refuses an action list before running any of it. */
export function virtualInteractionRefusal(actions: Raw[], spec: Raw): string | undefined {
  const reason = actions.map((action) => unsupportedAction(action, spec)).find(Boolean);
  return reason === undefined
    ? undefined
    : `The headless virtual device cannot run ${reason} yet; run the tap on a device.`;
}

/** The `{key, value}` payload of one changed key, or `{keys, values}` of several. */
function changePayload(keys: string[], state: PrototypeState): PrototypeJson {
  return keys.length === 1
    ? { key: keys[0]!, value: state[keys[0]!] ?? null }
    : { keys, values: Object.fromEntries(keys.map((key) => [key, state[key] ?? null])) };
}

/** The value a state action writes, or undefined when it is a no-op for the stored type. */
function stateWrite(action: Raw, state: PrototypeState): PrototypeState[string] | undefined {
  const current = state[String(action.key)];
  const by = typeof action.by === "number" ? action.by : 1;
  switch (action.type) {
    case "setState":
      return action.value as PrototypeState[string];
    case "toggle":
      return typeof current === "boolean" ? !current : undefined;
    case "increment":
    case "decrement": {
      const next =
        typeof current === "number" ? current + (action.type === "increment" ? by : -by) : NaN;
      return Number.isFinite(next) ? next : undefined;
    }
    default:
      return undefined;
  }
}

/** The draft an interaction changes, and the events it raises in order. */
class Draft {
  readonly steps: VirtualPrototypeStep[] = [];
  dismissed = false;
  blurred = false;
  state: PrototypeState;
  pages: Record<string, number>;
  stacks: PrototypeStacks;

  constructor(
    readonly spec: Raw,
    snapshot: VirtualPrototypeSnapshot,
  ) {
    this.state = { ...snapshot.state };
    this.recorded = { ...snapshot.state };
    this.pages = { ...snapshot.pages };
    this.stacks = structuredClone(snapshot.stacks);
  }

  /** Keys a write changed since the last event that its state snapshot does not show changed. */
  readonly unrecorded = new Set<string>();
  private recorded: PrototypeState;

  event(kind: PrototypeEvent["kind"], name: string | null, payload: PrototypeJson): void {
    // Delivery stamps a key only when its value differs from the last delivered state.
    [...this.unrecorded]
      .filter((key) => this.state[key] !== this.recorded[key])
      .forEach((key) => this.unrecorded.delete(key));
    this.recorded = { ...this.state };
    this.steps.push({
      kind,
      name,
      payload,
      state: { ...this.state },
      pages: { ...this.pages },
      stacks: structuredClone(this.stacks),
    });
  }

  /** Why the validator rejected a write, once one was: later writes and actions do nothing. */
  rejection: string | undefined = undefined;

  /**
   * Writes `values` as `writeInteractionSpec` does: validated against the spec first, pager-bound
   * keys clamped to their pages and each bound pager moved to the written page. Returns the keys
   * that changed; a rejected write changes nothing and records why.
   */
  write(values: PrototypeState): string[] {
    if (this.rejection !== undefined || Object.keys(values).length === 0) {
      return [];
    }
    const state = normalizePagerState(this.spec, { ...this.state, ...values });
    const checked = validatePrototypeSpec({ ...this.spec, state });
    if (!checked.success) {
      this.rejection = `The prototype rejects writing ${Object.keys(values).join(", ")}: ${checked.error.path}: ${checked.error.message}. Nothing was applied.`;
      return [];
    }
    const moved = Object.keys(state).filter((key) => this.state[key] !== state[key]);
    for (const key of moved) {
      this.unrecorded.add(key);
    }
    this.state = state;
    this.pages = boundPages(this.spec, state, this.pages);
    return moved;
  }

  change(keys: string[]): void {
    if (keys.length > 0) {
      this.event("emit", "change", changePayload(keys, this.state));
    }
  }
}

type EmitBindings = Parameters<typeof resolveEmitContext>[0];

/** An emit, its context resolved and cut to the shared emit byte budget as on the device. */
function runEmit(action: Raw, draft: Draft): void {
  const bindings = record(action.context);
  draft.event("emit", String(action.name), (action.payload ?? null) as PrototypeJson);
  if (bindings) {
    // `unsupportedContext` admits only state, page, data and value bindings.
    const resolved = resolveEmitContext(bindings as EmitBindings, {
      state: draft.state,
      pages: draft.pages,
      data: draft.spec.data as PrototypeJson | undefined,
    });
    Object.assign(draft.steps.at(-1)!, resolved);
  }
}

function runSetPage(action: Raw, draft: Draft): void {
  const id = String(action.pager);
  const pager = findNode(draft.spec, "pager", id);
  const current = draft.pages[id];
  if (!pager || current === undefined) {
    return;
  }
  const count = Array.isArray(pager.children) ? pager.children.length : 0;
  const requested =
    action.page === "next"
      ? current + 1
      : action.page === "prev"
        ? current - 1
        : Number(action.page);
  const page = Math.min(Math.max(requested, 0), Math.max(count - 1, 0));
  if (page === current) {
    return;
  }
  const key = typeof pager.stateKey === "string" ? pager.stateKey : undefined;
  const moved = key === undefined ? [] : draft.write({ [key]: page });
  draft.pages = { ...draft.pages, [id]: page };
  draft.event("page_changed", id, page);
  draft.change(moved);
}

function nextStackPath(action: Raw, stack: Raw, path: string[]): string[] {
  const screens = record(stack.screens) ?? {};
  const screen = String(action.screen);
  const known = Object.hasOwn(screens, screen);
  switch (action.type) {
    case "push":
      return known && path.length < contract.limits.MAX_PROTOTYPE_STACK_DEPTH
        ? [...path, screen]
        : path;
    case "replace":
      return known ? [...path.slice(0, -1), screen] : path;
    case "pop":
      return path.length > 1 ? path.slice(0, -1) : path;
    default:
      return [String(stack.start)];
  }
}

function runStackAction(action: Raw, draft: Draft): void {
  const id = String(action.stack);
  const stack = findNode(draft.spec, "stack", id);
  const before = draft.stacks[id];
  if (!stack || !before) {
    return;
  }
  const path = nextStackPath(action, stack, before.path);
  if (path.at(-1) === before.path.at(-1) && path.length === before.depth) {
    return;
  }
  draft.stacks = { ...draft.stacks, [id]: { path, depth: path.length } };
  draft.event("screen_changed", id, { screen: path.at(-1)!, depth: path.length });
}

/** Runs one action; true when the list must stop (a dismiss). */
function runAction(action: Raw, draft: Draft, touched: Set<string>): boolean {
  const type = String(action.type);
  if (type === "emit") {
    runEmit(action, draft);
  } else if (type === "setPage") {
    runSetPage(action, draft);
  } else if (STACK_ACTIONS.has(type)) {
    runStackAction(action, draft);
  } else if (type === "dismiss") {
    draft.dismissed = true;
    return true;
  } else if (type === "hideKeyboard") {
    draft.blurred = true;
  } else {
    const value = stateWrite(action, draft.state);
    if (value !== undefined) {
      draft.write({ [String(action.key)]: value });
      touched.add(String(action.key));
    }
  }
  return false;
}

/**
 * The events a control raises: its own `own` write and `change`, then `actions` in order with
 * one trailing `change` for the keys the list changed, then `dismissed` when the list dismissed.
 * Call `virtualInteractionRefusal` first: this assumes every action is runnable.
 */
export function planVirtualInteraction(
  snapshot: VirtualPrototypeSnapshot,
  own: PrototypeState,
  actions: Raw[],
): VirtualInteractionPlan {
  const draft = new Draft(snapshot.spec, snapshot);
  draft.change(draft.write(own));
  const baseline = { ...draft.state };
  const touched = new Set<string>();
  actions.some((action) => draft.rejection !== undefined || runAction(action, draft, touched));
  if (draft.rejection !== undefined) {
    // Planned before anything is delivered, so a rejected write leaves the device untouched.
    return {
      steps: [],
      dismissed: false,
      blurred: false,
      state: snapshot.state,
      pages: snapshot.pages,
      stacks: snapshot.stacks,
      unrecordedWrites: [],
      rejection: draft.rejection,
    };
  }
  if (draft.dismissed) {
    // A dismissed prototype is no longer active, so no trailing change follows its event.
    draft.event("dismissed", null, { reason: "user" });
  } else {
    draft.change([...touched].filter((key) => baseline[key] !== draft.state[key]));
  }
  return {
    steps: draft.steps,
    dismissed: draft.dismissed,
    blurred: draft.blurred,
    state: draft.state,
    pages: draft.pages,
    stacks: draft.stacks,
    unrecordedWrites: [...draft.unrecorded],
  };
}

/** The own write a tap's interaction makes before its actions. */
export function interactionOwnWrite(
  interaction: VirtualInteraction,
  state: PrototypeState,
): PrototypeState {
  if (interaction.type === "toggle") {
    const stored = state[interaction.key];
    return typeof stored === "boolean" ? { [interaction.key]: !stored } : {};
  }
  if (interaction.type === "select") {
    return { [interaction.key]: interaction.index };
  }
  if (interaction.type === "close") {
    const key = String(interaction.condition.key);
    return state[key] === interaction.condition.equals
      ? { [key]: !interaction.condition.equals }
      : {};
  }
  return {};
}

/** A toggle whose key no longer holds a boolean leaves the control inert, as on the device. */
export function isInertInteraction(
  interaction: VirtualInteraction,
  state: PrototypeState,
): boolean {
  return interaction.type === "toggle" && typeof state[interaction.key] !== "boolean";
}

import type { PrototypeEvent, PrototypeState } from "../../observe/android/ctrlProxyProtocol";
import { resolvePrototypeDataPointer } from "../prototypeData";
import { prototypeNodeChildren } from "../prototypeNodeChildren";
import type { PrototypeJson } from "../prototypeSpec";
import { record, type Raw } from "../prototypeTemplate";
import { conditionHolds } from "../web/webCondition";
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
  state: PrototypeState;
  pages: Record<string, number>;
  stacks: PrototypeStacks;
}

/** What a tap on a node does, as the device runtime classifies it. */
export type VirtualInteraction =
  | { type: "tap"; actions: Raw[] }
  | { type: "toggle"; key: string; actions: Raw[] }
  | { type: "focus"; key: string; actions: Raw[] }
  | { type: "close"; condition: Raw; actions: Raw[] };

/** The node a selector matched and the interaction its tap runs, if anything handles it. */
export interface VirtualTapTarget {
  node: Raw;
  /** Undefined for a dead tap: nothing on the path to the root handles it. */
  interaction?: VirtualInteraction;
  /** False when the handling control's `enabledWhen` does not hold: the tap does nothing. */
  enabled: boolean;
}

export interface VirtualInteractionPlan {
  steps: VirtualPrototypeStep[];
  /** A `dismiss` action ran: the prototype is gone after its `dismissed` event. */
  dismissed: boolean;
  /** A `hideKeyboard` action ran: the focused field loses focus. */
  blurred: boolean;
}

const TEXT_FIELDS = ["text", "label", "headline", "title", "placeholder", "contentDescription"];
const OPEN_WHEN_NODES = new Set(["dialog", "bottomSheet", "snackbar", "drawer", "tooltip", "menu"]);
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

/** The objects among `values`, in order. */
const records = (values: readonly unknown[]): Raw[] =>
  values.map((value) => record(value)).filter((value): value is Raw => value !== undefined);

const actionList = (value: unknown): Raw[] => (Array.isArray(value) ? records(value) : []);

const isOpen = (node: Raw, state: PrototypeState): boolean => {
  const condition = record(node.openWhen);
  return !condition || state[String(condition.key)] === condition.equals;
};

/** The interaction a node itself handles, if any. */
function ownInteraction(node: Raw): VirtualInteraction | undefined {
  const actions = actionList(node.onTap);
  const key = typeof node.stateKey === "string" ? node.stateKey : undefined;
  if (key !== undefined && FOCUS_NODES.has(String(node.type))) {
    return { type: "focus", key, actions };
  }
  if (key !== undefined && TOGGLE_NODES.has(String(node.type))) {
    return { type: "toggle", key, actions };
  }
  return actions.length > 0 ? { type: "tap", actions } : undefined;
}

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
  return records(prototypeNodeChildren(node).map(({ value }) => value));
}

function isShown(node: Raw, state: PrototypeState): boolean {
  const visible =
    node.visibleWhen === undefined ||
    conditionHolds(node.visibleWhen, { state, platform: "android" });
  return visible && (!OPEN_WHEN_NODES.has(String(node.type)) || isOpen(node, state));
}

function textMatches(node: Raw, text: string, exact: boolean): boolean {
  const wanted = text.trim().toLowerCase();
  return TEXT_FIELDS.some((field) => {
    const value = node[field];
    if (typeof value !== "string") {
      return false;
    }
    const own = value.trim().toLowerCase();
    return exact ? own === wanted : own.includes(wanted);
  });
}

function selectorMatches(node: Raw, selector: VirtualTapSelector, exact: boolean): boolean {
  if (selector.elementId !== undefined || selector.testTag !== undefined) {
    const wanted = selector.elementId ?? selector.testTag;
    return node.id === wanted || node.testTag === wanted;
  }
  return selector.text !== undefined && textMatches(node, selector.text, exact);
}

/** A dialog's confirm and dismiss buttons close it, then run their own actions. */
function dialogButtonTargets(node: Raw): Raw[] {
  if (node.type !== "dialog") {
    return [];
  }
  const condition = record(node.openWhen) ?? {};
  return [node.confirm, node.dismiss].flatMap((value) => {
    const button = record(value);
    return button ? [{ ...button, type: "dialogButton", closes: condition } satisfies Raw] : [];
  });
}

interface Visit {
  node: Raw;
  handler?: { node: Raw; interaction: VirtualInteraction };
}

function handlerFor(node: Raw, inherited: Visit["handler"]): Visit["handler"] {
  if (node.type === "dialogButton") {
    const condition = record(node.closes) ?? {};
    return { node, interaction: { type: "close", condition, actions: actionList(node.onTap) } };
  }
  const own = ownInteraction(node);
  return own ? { node, interaction: own } : inherited;
}

/** Every tappable node in render order, each with the nearest ancestor-or-self that handles it. */
function visibleNodes(snapshot: VirtualPrototypeSnapshot): Visit[] {
  const root = record(snapshot.spec.root);
  const pending: Visit[] = root ? [{ node: root }] : [];
  const visits: Visit[] = [];
  while (pending.length > 0) {
    const { node, handler: inherited } = pending.shift()!;
    if (!isShown(node, snapshot.state)) {
      continue;
    }
    const handler = handlerFor(node, inherited);
    visits.push({ node, handler });
    const children = [...dialogButtonTargets(node), ...visibleChildren(node, snapshot)];
    pending.unshift(...children.map((child) => ({ node: child, handler })));
  }
  return visits;
}

/** The first visible node the selector names: an exact text match first, then a substring. */
export function findVirtualTapTarget(
  snapshot: VirtualPrototypeSnapshot,
  selector: VirtualTapSelector,
): VirtualTapTarget | undefined {
  const visits = visibleNodes(snapshot);
  const match =
    visits.find((visit) => selectorMatches(visit.node, selector, true)) ??
    (selector.exactText === true
      ? undefined
      : visits.find((visit) => selectorMatches(visit.node, selector, false)));
  if (!match) {
    return undefined;
  }
  const handler = match.handler;
  const enabledWhen = handler?.node.enabledWhen;
  return {
    node: match.node,
    interaction: handler?.interaction,
    enabled:
      enabledWhen === undefined ||
      conditionHolds(enabledWhen, { state: snapshot.state, platform: "android" }),
  };
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
    this.pages = { ...snapshot.pages };
    this.stacks = structuredClone(snapshot.stacks);
  }

  event(kind: PrototypeEvent["kind"], name: string | null, payload: PrototypeJson): void {
    this.steps.push({
      kind,
      name,
      payload,
      state: { ...this.state },
      pages: { ...this.pages },
      stacks: structuredClone(this.stacks),
    });
  }

  write(values: PrototypeState): string[] {
    const moved = Object.keys(values).filter((key) => this.state[key] !== values[key]);
    this.state = { ...this.state, ...values };
    return moved;
  }

  change(keys: string[]): void {
    if (keys.length > 0) {
      this.event("emit", "change", changePayload(keys, this.state));
    }
  }
}

function contextValue(binding: Raw, draft: Draft): PrototypeJson {
  if (typeof binding.state === "string") {
    return draft.state[binding.state] ?? null;
  }
  if (typeof binding.page === "string") {
    return draft.pages[binding.page] ?? null;
  }
  if (typeof binding.data === "string") {
    return (resolvePrototypeDataPointer(draft.spec.data, binding.data) ?? null) as PrototypeJson;
  }
  return (binding.value ?? null) as PrototypeJson;
}

function runEmit(action: Raw, draft: Draft): void {
  const bindings = record(action.context);
  draft.event("emit", String(action.name), (action.payload ?? null) as PrototypeJson);
  if (bindings) {
    draft.steps.at(-1)!.context = Object.fromEntries(
      Object.entries(bindings).map(([name, value]) => [name, contextValue(record(value)!, draft)]),
    );
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
  actions.some((action) => runAction(action, draft, touched));
  if (draft.dismissed) {
    // A dismissed prototype is no longer active, so no trailing change follows its event.
    draft.event("dismissed", null, { reason: "user" });
  } else {
    draft.change([...touched].filter((key) => baseline[key] !== draft.state[key]));
  }
  return { steps: draft.steps, dismissed: draft.dismissed, blurred: draft.blurred };
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

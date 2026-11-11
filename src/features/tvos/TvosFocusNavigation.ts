import { ActionableError } from "../../models/ActionableError";
import type { Element, TapOnElementOptions, TapOnElementResult } from "../../models";
import { isTruthy } from "../../models/Element";
import { boundsArea } from "../../utils/bounds";
import { DefaultElementParser } from "../utility/ElementParser";
import { compareSelectionRank, selectableCandidates } from "../utility/selectionRank";
import { normalizeTvosHierarchy } from "./TvosHierarchy";
import type { TvosRunnerClient } from "./TvosRunnerClient";
import { tvosRunners } from "./TvosRunnerRegistry";

type Direction = "up" | "down" | "left" | "right";

function focusKey(element: Element): string {
  const { left, top, right, bottom } = element.bounds;
  return JSON.stringify([element["resource-id"], left, top, right, bottom]);
}

function sameBounds(a: Element, b: Element): boolean {
  return (
    a.bounds.left === b.bounds.left &&
    a.bounds.top === b.bounds.top &&
    a.bounds.right === b.bounds.right &&
    a.bounds.bottom === b.bounds.bottom
  );
}

function directions(focus: Element, target: Element): Direction[] {
  const a = focus.bounds;
  const b = target.bounds;
  const dx = (b.left + b.right - a.left - a.right) / 2;
  const dy = (b.top + b.bottom - a.top - a.bottom) / 2;
  const horizontal: Direction[] = dx === 0 ? [] : [dx > 0 ? "right" : "left"];
  const vertical: Direction[] = dy === 0 ? [] : [dy > 0 ? "down" : "up"];
  const overlapsX = a.left < b.right && b.left < a.right;
  const overlapsY = a.top < b.bottom && b.top < a.bottom;
  const horizontalFirst = overlapsY ? true : overlapsX ? false : Math.abs(dx) >= Math.abs(dy);
  return horizontalFirst ? [...horizontal, ...vertical] : [...vertical, ...horizontal];
}

/** Internal navigation budgets; the public tapOn schema is unchanged. */
export interface TvosTapBudgets {
  /** Directional presses toward a target that is in the hierarchy. */
  maxMoves?: number;
  /** Presses spent sweeping rows for a target that is not in the hierarchy yet. */
  maxSearchMoves?: number;
}

function validateBudgets({
  maxMoves = 30,
  maxSearchMoves = 60,
}: TvosTapBudgets): Required<TvosTapBudgets> {
  if (!Number.isInteger(maxMoves) || maxMoves < 0) {
    throw new ActionableError("tvOS maxMoves must be a non-negative integer.");
  }
  if (!Number.isInteger(maxSearchMoves) || maxSearchMoves < 0) {
    throw new ActionableError("tvOS maxSearchMoves must be a non-negative integer.");
  }
  return { maxMoves, maxSearchMoves };
}

function validateOptions(
  options: TapOnElementOptions,
  budgets: TvosTapBudgets,
): Required<TvosTapBudgets> {
  const refused = Object.entries(options).filter(
    ([key, value]) =>
      value !== undefined &&
      (value !== false || key === "ensureChecked") &&
      !["action", "elementId", "text", "index"].includes(key),
  );
  if (options.action !== "tap" || refused.length) {
    throw new ActionableError(
      `tvOS tapOn supports only action tap and elementId, text, index; unsupported: ${
        options.action !== "tap" ? options.action : refused.map(([key]) => key).join(", ")
      }.`,
    );
  }
  if (options.index !== undefined && (!Number.isInteger(options.index) || options.index < 0)) {
    throw new ActionableError("tvOS tap index must be a non-negative integer.");
  }
  return validateBudgets(budgets);
}

function matches(element: Element, options: TapOnElementOptions): boolean {
  return (
    (options.elementId !== undefined || options.text !== undefined) &&
    (options.elementId === undefined ||
      element["resource-id"] === options.elementId ||
      element["view-id"] === options.elementId) &&
    (options.text === undefined || element.text === options.text)
  );
}

/** Matching labels share the outermost matching focus owner that contains their bounds. */
function focusOwner(target: Element, matches: Element[]): Element {
  return matches.reduce((owner, candidate) => {
    const outer = candidate.bounds;
    const inner = target.bounds;
    return outer.left <= inner.left &&
      outer.top <= inner.top &&
      outer.right >= inner.right &&
      outer.bottom >= inner.bottom &&
      boundsArea(outer) > boundsArea(owner.bounds)
      ? candidate
      : owner;
  }, target);
}

/** A row can select its non-focusable child without another focus move. */
function canSelectAtFocus(focus: Element, target: Element): boolean {
  return (
    sameBounds(focus, target) ||
    (!isTruthy(target.focusable) && focusOwner(target, [focus]) === focus)
  );
}

interface TargetIdentity {
  key: string;
  ordinal: number;
  count: number;
}

function identityKey(element: Element): string {
  return JSON.stringify([element["resource-id"], element["view-id"], element.text, element.class]);
}

interface ScreenRead {
  focus?: Element;
  target?: Element;
  identity?: TargetIdentity;
  /** Changes when a press moved focus or scrolled; equal reads mean the press was refused. */
  signature: string;
}

/** Identity without text, so cells of one row share a kind even when their labels differ. */
function kindKey(element: Element): string {
  return JSON.stringify([element["resource-id"], element["view-id"], element.class]);
}

/**
 * Where focus is. A scrolled row keeps the focused cell at the viewport edge, so successive cells
 * can share bounds; the scroll shows in the frames and labels of the cells of the same kind as the
 * focused one. Elements of other kinds, such as a ticking status label, are left out.
 */
function focusSignature(all: Element[], focus: Element | undefined): string {
  if (!focus) {
    return "[]";
  }
  const key = kindKey(focus);
  return JSON.stringify([
    focusKey(focus),
    all
      .filter((element) => kindKey(element) === key)
      .map((element) => [focusKey(element), element.text]),
  ]);
}

function onScreen(element: Element, width: number, height: number): boolean {
  const { left, top, right, bottom } = element.bounds;
  return left >= 0 && top >= 0 && right <= width && bottom <= height;
}

/**
 * Matches anywhere in the hierarchy are eligible: a row the crawl scrolled keeps its far items
 * outside the screen bounds until focus reaches them. On-screen matches rank first so index
 * keeps its on-screen meaning.
 */
async function readScreen(
  client: TvosRunnerClient,
  options: TapOnElementOptions,
  signal?: AbortSignal,
  identity?: TargetIdentity,
): Promise<ScreenRead> {
  const hierarchy = normalizeTvosHierarchy(await client.hierarchy(signal));
  signal?.throwIfAborted();
  const all = new DefaultElementParser()
    .flattenViewHierarchy(hierarchy)
    .map(({ element }) => element);
  const focus = all.find((element) => element.focused === "true");
  const signature = focusSignature(all, focus);
  const peers = identity ? all.filter((element) => identityKey(element) === identity.key) : [];
  if (identity && peers.length !== identity.count) {
    throw new ActionableError(
      "The tvOS tapOn target disappeared or became ambiguous; observe and retry with its current identifier or exact text.",
    );
  }
  const matching = all.filter(
    (element) =>
      element.bounds.right > element.bounds.left &&
      element.bounds.bottom > element.bounds.top &&
      matches(element, options),
  );
  const ranked = matching
    .map((element, order) => ({
      element,
      windowRank: onScreen(element, hierarchy.screenWidth!, hierarchy.screenHeight!) ? 0 : 1,
      area: boundsArea(element.bounds),
      order,
      interactive: false,
    }))
    .sort(compareSelectionRank)
    .map(({ element }) => element);
  const target = identity
    ? peers[identity.ordinal]
    : selectableCandidates(ranked, (element) => focusOwner(element, matching))[options.index ?? 0];
  if (!target || identity) {
    return { focus, target, identity, signature };
  }
  // Bounds and focus change during navigation; identical peers retain hierarchy order.
  const key = identityKey(target);
  const targetPeers = all.filter((element) => identityKey(element) === key);
  return {
    focus,
    target,
    identity: { key, ordinal: targetPeers.indexOf(target), count: targetPeers.length },
    signature,
  };
}

function requireFocus(read: ScreenRead): Element {
  if (!read.focus) {
    throw new ActionableError(
      "Nothing is focused on tvOS; use pressButton to establish focus and observe before retrying tapOn.",
    );
  }
  return read.focus;
}

/**
 * A row that has not scrolled yet may not contain the target at all: tvOS loads cells as focus
 * reaches them. Sweep the focused row right then left, then step down (or up once down is
 * refused) and sweep again, re-reading after every press, until the target appears. A press that
 * leaves the focus signature unchanged was refused at an edge and ends that leg.
 */
interface Lookup {
  client: TvosRunnerClient;
  options: TapOnElementOptions;
  signal?: AbortSignal;
}

async function searchForTarget(
  { client, options, signal }: Lookup,
  first: ScreenRead,
  maxSearchMoves: number,
): Promise<ScreenRead> {
  let read = first;
  let moves = 0;
  const press = async (direction: Direction): Promise<boolean> => {
    if (moves >= maxSearchMoves) {
      throw new ActionableError(
        `No tvOS element matched after searching ${maxSearchMoves} focus moves; observe and check the identifier, exact text or index, or move closer with pressButton before retrying.`,
      );
    }
    moves++;
    await client.request({ type: "request_press_button", action: direction }, signal);
    signal?.throwIfAborted();
    const next = await readScreen(client, options, signal);
    const moved = next.signature !== read.signature;
    read = next;
    return moved;
  };
  const sweep = async (direction: Direction): Promise<boolean> => {
    while (!read.target && (await press(direction))) {
      // Keep moving until the target appears or the edge refuses the press.
    }
    return Boolean(read.target);
  };
  for (const vertical of ["down", "up"] as const) {
    do {
      if ((await sweep("right")) || (await sweep("left"))) {
        return read;
      }
    } while (await press(vertical));
    if (read.target) {
      return read;
    }
  }
  throw new ActionableError(
    "No tvOS element matched after searching the screen with focus moves; observe and check the identifier, exact text or index.",
  );
}

function describe(element: Element): string {
  return element["resource-id"] || element.text || focusKey(element);
}

/** Read focus and target; with neither identity nor match yet, search the rows for the target. */
async function locate(
  lookup: Lookup,
  identity: TargetIdentity | undefined,
  maxSearchMoves: number,
): Promise<{ focus: Element; target: Element; identity?: TargetIdentity; signature: string }> {
  const { client, options, signal } = lookup;
  let state = await readScreen(client, options, signal, identity);
  if (!state.target && !identity) {
    if (options.elementId === undefined && options.text === undefined) {
      throw new ActionableError(
        "No tvOS element matched; observe and check the identifier, exact text or index.",
      );
    }
    requireFocus(state);
    state = await searchForTarget(lookup, state, maxSearchMoves);
  }
  return {
    focus: requireFocus(state),
    target: state.target!,
    identity: state.identity,
    signature: state.signature,
  };
}

export async function tvosTapOn(
  deviceId: string,
  options: TapOnElementOptions,
  signal?: AbortSignal,
  budgets: TvosTapBudgets = {},
): Promise<TapOnElementResult> {
  const { maxMoves, maxSearchMoves } = validateOptions(options, budgets);
  signal?.throwIfAborted();
  const lookup: Lookup = { client: tvosRunners.require(deviceId), options, signal };
  const { client } = lookup;
  const blocked = new Map<string, Set<Direction>>();
  let previous: { signature: string; direction: Direction } | undefined;
  let identity: TargetIdentity | undefined;
  for (let moves = 0; ; moves++) {
    signal?.throwIfAborted();
    const state = await locate(lookup, identity, maxSearchMoves);
    const { focus, target } = state;
    identity = state.identity;
    if (canSelectAtFocus(focus, target)) {
      await client.request({ type: "request_press_button", action: "select" }, signal);
      return {
        success: true,
        action: "tap",
        element: target,
        ...(sameBounds(focus, target) ? {} : { debug: { activatedAncestor: focus } }),
      };
    }
    // A press that leaves the focus signature unchanged was refused at this focus position.
    const refused = blocked.get(state.signature) ?? new Set<Direction>();
    if (previous?.signature === state.signature) {
      refused.add(previous.direction);
      blocked.set(state.signature, refused);
    }
    const direction = directions(focus, target).find((value) => !refused.has(value));
    if (!direction) {
      throw new ActionableError(
        `tvOS focus stopped making progress from ${describe(focus)} toward ${describe(target)}; the target may be unreachable or in a focus trap. Observe and navigate with pressButton before retrying.`,
      );
    }
    if (moves >= maxMoves) {
      throw new ActionableError(
        `tvOS tapOn exceeded maxMoves (${maxMoves}) before reaching ${describe(target)}; observe and move closer with pressButton before retrying.`,
      );
    }
    await client.request({ type: "request_press_button", action: direction }, signal);
    previous = { signature: state.signature, direction };
  }
}

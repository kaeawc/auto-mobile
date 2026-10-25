import { PROTOTYPE_CHOREOGRAPHY_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
import { record, type Raw } from "./prototypeTemplate";

/**
 * Transition choreography (#15247): `transition: {type, delayMs?}`, the `blurReplace` transition and
 * a container `stagger: {ms, order?}`. All of it is gated by `prototype_choreography_v1`.
 */
export const PROTOTYPE_CHOREOGRAPHY_MAX_DELAY_MS = 600;
export type PrototypeStaggerOrder = "forward" | "reverse" | "center";

export interface PrototypeChoreographyError {
  path: string;
  message: string;
}

/** A transition's type, whichever of its two forms (a string or `{type, delayMs?}`) it is written in. */
export function prototypeTransitionType(transition: unknown): string | undefined {
  if (typeof transition === "string") {
    return transition;
  }
  const type = record(transition)?.type;
  return typeof type === "string" ? type : undefined;
}

/** How many steps after the first enter the child at [index] of [count] waits, by stagger [order]. */
export function prototypeStaggerRank(
  index: number,
  count: number,
  order: PrototypeStaggerOrder,
): number {
  switch (order) {
    case "reverse":
      return count - 1 - index;
    case "center":
      return Math.floor(Math.abs(2 * index - (count - 1)) / 2);
    default:
      return index;
  }
}

function staggerOrder(stagger: Raw): PrototypeStaggerOrder {
  return stagger.order === "reverse" || stagger.order === "center" ? stagger.order : "forward";
}

function childDelayMs(child: unknown): number {
  const delay = record(record(child)?.transition)?.delayMs;
  return typeof delay === "number" ? delay : 0;
}

/**
 * The longest wait any staggered child of [node] has: its own `transition.delayMs` plus its stagger
 * rank times `ms`. Only `visibleWhen` children count, in layout order, and a literal `repeat`
 * multiplies them; a data-bound repeat has no static count, so the device clamps it instead.
 */
function longestStaggerDelayMs(node: Raw, stagger: Raw): number {
  const children = (Array.isArray(node.children) ? node.children : []).filter(
    (child) => record(child)?.visibleWhen !== undefined,
  );
  const items = record(node.repeat)?.items;
  const instances = Array.isArray(items) ? items.length : 1;
  const count = children.length * instances;
  const ms = typeof stagger.ms === "number" ? stagger.ms : 0;
  const order = staggerOrder(stagger);
  let longest = 0;
  for (let index = 0; index < count; index++) {
    const delay =
      prototypeStaggerRank(index, count, order) * ms +
      childDelayMs(children[index % children.length]);
    longest = Math.max(longest, delay);
  }
  return longest;
}

/** The cross-field limit the contract cannot express: no child waits longer than 600 ms in all. */
export function prototypeChoreographyError(
  nodes: readonly { value: Raw; path: string }[],
): PrototypeChoreographyError | undefined {
  const node = nodes.find(({ value }) => {
    const stagger = record(value.stagger);
    return (
      stagger !== undefined &&
      longestStaggerDelayMs(value, stagger) > PROTOTYPE_CHOREOGRAPHY_MAX_DELAY_MS
    );
  });
  return node
    ? {
        path: `${node.path}.stagger`,
        message: `Stagger and transition delays add up to more than ${PROTOTYPE_CHOREOGRAPHY_MAX_DELAY_MS} ms`,
      }
    : undefined;
}

function nodeFields(node: Raw, path: string): string[] {
  const objectForm = record(node.transition) !== undefined;
  return [
    ...(objectForm || node.transition === "blurReplace" ? [`${path}.transition`] : []),
    ...(node.stagger !== undefined ? [`${path}.stagger`] : []),
  ];
}

/** Authored paths of every choreography field, in tree order. */
export function prototypeChoreographyFields(spec: unknown): string[] {
  const fields: string[] = [];
  walkPrototypeNodes(spec, (node, path) => {
    fields.push(...nodeFields(node, path));
  });
  return fields;
}

export function prototypeChoreographyUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  const device = platform === "ios" ? "connected iOS prototype agent" : "connected CtrlProxy";
  const update =
    platform === "ios"
      ? "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version"
      : "Update the connected CtrlProxy";
  const more = fields.length > 1 ? ` (and ${fields.length - 1} more)` : "";
  return `The ${device} does not advertise ${PROTOTYPE_CHOREOGRAPHY_CAPABILITY}, so it cannot run the choreography at ${fields[0]}${more}. Nothing was shown. ${update}, or use plain transition names and no stagger.`;
}

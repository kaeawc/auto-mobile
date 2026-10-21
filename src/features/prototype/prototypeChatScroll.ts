import { PROTOTYPE_CHAT_SCROLL_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import { prototypeFieldsOfKind } from "./prototypeEmitContext";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
import type { Raw } from "./prototypeTemplate";

/**
 * Chat lists (#14232): a vertical `scroll` may be anchored at its end (`reverse`), follow rows
 * appended while it is at the end (`stickToEnd`), write whether it is at the end to a boolean state
 * key (`atEndKey`, for a "new messages" pill) and run `onStartReached` when it reaches its start
 * (to load older history). `scrollTo {scroll, to: "start" | "end" | {key}}` moves a scroll by id;
 * `{key}` names a `repeat.key` value of a row inside it. All of it is gated by
 * `prototype_chat_scroll_v1`.
 */
export const PROTOTYPE_CHAT_SCROLL_OPTIONS = [
  "reverse",
  "stickToEnd",
  "atEndKey",
  "onStartReached",
] as const;

export interface PrototypeChatScrollError {
  path: string;
  message: string;
}

const firstOption = (node: Raw): string | undefined =>
  PROTOTYPE_CHAT_SCROLL_OPTIONS.find((option) => node[option] !== undefined);

type Located = readonly { value: Raw; path: string }[];

function scrollToError(
  actions: Located,
  ids: ReadonlyMap<string, number>,
): PrototypeChatScrollError | undefined {
  for (const { value, path } of actions) {
    if (value.type !== "scrollTo" || typeof value.scroll !== "string") {
      continue;
    }
    const count = ids.get(value.scroll) ?? 0;
    if (count !== 1) {
      return {
        path: `${path}.scroll`,
        message: count === 0 ? "Unknown scroll id" : "Duplicate scroll id",
      };
    }
  }
  return undefined;
}

/**
 * Static checks over the structurally valid nodes and actions of one spec. `atEndKey` must name a
 * declared boolean state key; the state bindings check that per repeat row and on every write.
 */
export function prototypeChatScrollError(
  nodes: Located,
  actions: Located,
): PrototypeChatScrollError | undefined {
  const ids = new Map<string, number>();
  for (const { value, path } of nodes) {
    if (value.type !== "scroll") {
      continue;
    }
    const option = firstOption(value);
    if (option !== undefined && value.axis === "horizontal") {
      return { path: `${path}.${option}`, message: "Chat scroll options need a vertical scroll" };
    }
    if (typeof value.id === "string") {
      ids.set(value.id, (ids.get(value.id) ?? 0) + 1);
    }
  }
  return scrollToError(actions, ids);
}

/** Authored paths of every chat option on a scroll and every `scrollTo` action. */
export function prototypeChatScrollFields(spec: unknown): string[] {
  const fields: string[] = [];
  walkPrototypeNodes(spec, (node, path) => {
    const option = node.type === "scroll" ? firstOption(node) : undefined;
    if (option !== undefined) {
      fields.push(`${path}.${option}`);
    }
  });
  return [...fields, ...prototypeFieldsOfKind(spec, "scrollTo")];
}

export function prototypeChatScrollUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  const device = platform === "ios" ? "connected iOS prototype agent" : "connected CtrlProxy";
  const update =
    platform === "ios"
      ? "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version"
      : "Update the connected CtrlProxy";
  const more = fields.length > 1 ? ` (and ${fields.length - 1} more)` : "";
  return `The ${device} does not advertise ${PROTOTYPE_CHAT_SCROLL_CAPABILITY}, so it cannot run the chat scroll at ${fields[0]}${more}. Nothing was shown. ${update}, or use a plain scroll.`;
}

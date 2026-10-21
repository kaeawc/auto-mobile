import { walkPrototypeNodes } from "./prototypeNodeChildren";
import { PROTOTYPE_SWIPE_ACTIONS_CAPABILITY } from "../observe/android/ctrlProxyProtocol";

/** Authored paths of `swipeActions`, including component definitions and repeat templates. */
export function prototypeSwipeActionFields(spec: unknown): string[] {
  const fields: string[] = [];
  walkPrototypeNodes(spec, (node, path) => {
    if (Object.hasOwn(node, "swipeActions") && (node.type === "row" || node.type === "listItem")) {
      fields.push(`${path}.swipeActions`);
    }
  });
  return fields;
}

/** Refusal for a device that cannot draw or expose swipe actions. */
export function prototypeSwipeActionsUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  const more = fields.length > 1 ? ` (and ${fields.length - 1} more)` : "";
  const device = platform === "android" ? "connected CtrlProxy" : "connected iOS prototype agent";
  const update =
    platform === "android"
      ? "Update the connected CtrlProxy"
      : "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version";
  return `The ${device} does not advertise ${PROTOTYPE_SWIPE_ACTIONS_CAPABILITY}, so it cannot draw the swipeActions at ${fields[0]}${more}. Nothing was shown. ${update}, or remove swipeActions.`;
}

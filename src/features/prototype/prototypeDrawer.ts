import { walkPrototypeNodes } from "./prototypeNodeChildren";
import { PROTOTYPE_DRAWER_CAPABILITY } from "../observe/android/ctrlProxyProtocol";

/** Authored node paths, including repeat templates and reusable components. */
export function prototypeDrawerFields(spec: unknown): string[] {
  const fields: string[] = [];
  walkPrototypeNodes(spec, (node, path) => {
    if (node.type === "drawer") {
      fields.push(path);
    }
  });
  return fields;
}

export function prototypeDrawerUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  const more = fields.length > 1 ? ` (and ${fields.length - 1} more)` : "";
  const device = platform === "android" ? "connected CtrlProxy" : "connected iOS prototype agent";
  const update =
    platform === "android"
      ? "Update the connected CtrlProxy"
      : "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version";
  return `The ${device} does not advertise ${PROTOTYPE_DRAWER_CAPABILITY}, so it cannot draw the drawer node at ${fields[0]}${more}. Nothing was shown. ${update}, or remove drawer nodes.`;
}

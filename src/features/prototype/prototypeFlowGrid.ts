import { PROTOTYPE_FLOW_GRID_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import { record } from "./prototypeTemplate";

/** Paths of wrapping containers in the expanded spec, in document order. */
export function prototypeFlowGridFields(spec: unknown): string[] {
  return nodeFields(record(spec)?.root, "root");
}

function nodeFields(value: unknown, path: string): string[] {
  const node = record(value);
  if (!node) {
    return [];
  }
  return [
    ...(node.type === "flow" || node.type === "grid" ? [path] : []),
    ...(Array.isArray(node.children) ? node.children : []).flatMap((child, index) =>
      nodeFields(child, `${path}.children[${index}]`),
    ),
    ...nodeFields(node.child, `${path}.child`),
  ];
}

export function prototypeFlowGridUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  const more = fields.length > 1 ? ` (and ${fields.length - 1} more)` : "";
  const device = platform === "ios" ? "connected iOS prototype agent" : "connected CtrlProxy";
  const update =
    platform === "ios"
      ? "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version"
      : "Update the connected CtrlProxy";
  return `The ${device} does not advertise ${PROTOTYPE_FLOW_GRID_CAPABILITY}, so it cannot draw the flow or grid node at ${fields[0]}${more}. Nothing was shown. ${update}, or replace flow/grid with row/column/box containers.`;
}

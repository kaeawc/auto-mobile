import { PROTOTYPE_FLOW_GRID_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import { record } from "./prototypeTemplate";
import { expandPrototypeComponents } from "./prototypeComponents";

/** Paths of fields requiring flow/grid support in the expanded spec, in document order. */
export function prototypeFlowGridFields(spec: unknown): string[] {
  const expanded = expandPrototypeComponents(spec);
  return nodeFields(record(expanded.success ? expanded.spec : spec)?.root, "root");
}

function nodeFields(value: unknown, path: string): string[] {
  const node = record(value);
  if (!node) {
    return [];
  }
  return [
    ...(node.type === "flow" || node.type === "grid" ? [path] : []),
    ...(node.span !== undefined ? [`${path}.span`] : []),
    ...(record(node.style)?.runSpacing !== undefined ? [`${path}.style.runSpacing`] : []),
    ...(Array.isArray(node.styleWhen) ? node.styleWhen : []).flatMap((entry, index) =>
      record(record(entry)?.style)?.runSpacing !== undefined
        ? [`${path}.styleWhen[${index}].style.runSpacing`]
        : [],
    ),
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
  const feature = fields[0]?.endsWith(".runSpacing")
    ? "runSpacing value"
    : fields[0]?.endsWith(".span")
      ? "span value"
      : "flow or grid node";
  return `The ${device} does not advertise ${PROTOTYPE_FLOW_GRID_CAPABILITY}, so it cannot draw the ${feature} at ${fields[0]}${more}. Nothing was shown. ${update}, or replace flow/grid with row/column/box containers and remove runSpacing/span.`;
}

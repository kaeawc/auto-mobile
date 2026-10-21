import { prototypeNodeChildren, prototypeSpecNodeRoots } from "./prototypeNodeChildren";
import { PROTOTYPE_FLOW_GRID_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import { record } from "./prototypeTemplate";
import { expandPrototypeComponents } from "./prototypeComponents";

/** Paths of fields requiring flow/grid support in the expanded spec, in document order. */
export function prototypeFlowGridFields(spec: unknown): string[] {
  const expanded = expandPrototypeComponents(spec);
  const deviceSpec = expanded.success ? expanded.spec : spec;
  const fields = prototypeSpecNodeRoots(deviceSpec).flatMap(({ node, path }) =>
    nodeFields(node, path),
  );
  const definitions =
    expanded.success && expanded.expanded
      ? prototypeSpecNodeRoots(spec)
          .filter(({ path }) => path !== "root")
          .flatMap(({ node, path }) => nodeFields(node, path))
      : [];
  // Preserve expanded paths for existing uses instead of reporting the same authored field twice.
  return [
    ...fields,
    ...definitions.filter(
      (field) =>
        !fields.some((at) => expanded.success && expanded.locate(at).endsWith(` → ${field}`)),
    ),
  ];
}

function nodeFields(value: unknown, path: string): string[] {
  const fields: string[] = [];
  const pending = [{ node: value, path }];
  while (pending.length) {
    const { node: value, path } = pending.pop()!;
    const node = record(value);
    if (!node) {
      continue;
    }
    fields.push(
      ...(node.type === "flow" || node.type === "grid" ? [path] : []),
      ...(node.span !== undefined ? [`${path}.span`] : []),
      ...(record(node.style)?.runSpacing !== undefined ? [`${path}.style.runSpacing`] : []),
      ...(Array.isArray(node.styleWhen) ? node.styleWhen : []).flatMap((entry, index) =>
        record(record(entry)?.style)?.runSpacing !== undefined
          ? [`${path}.styleWhen[${index}].style.runSpacing`]
          : [],
      ),
    );
    const children = prototypeNodeChildren(node).sort((left, right) => {
      const rank = (suffix: string): number =>
        suffix.startsWith(".children[") ? 0 : suffix === ".child" ? 1 : 2;
      return rank(left.suffix) - rank(right.suffix);
    });
    for (const child of children.reverse()) {
      pending.push({ node: child.value, path: `${path}${child.suffix}` });
    }
  }
  return fields;
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

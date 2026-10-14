import contract from "../../../schemas/prototype-spec-contract.json";
import { record } from "./prototypeTemplate";

const gestureFields = ["onLongPress", "onDoubleTap"] as const;
const gestureTypes = new Set(
  Object.entries(contract.definitions.node.variants)
    .filter(([, variant]) => gestureFields.every((field) => Object.hasOwn(variant.fields, field)))
    .map(([type]) => type),
);

function nodeGestureFields(value: unknown, path: string): string[] {
  const node = record(value);
  if (!node) {
    return [];
  }
  const fields = gestureTypes.has(String(node.type))
    ? gestureFields.filter((field) => Object.hasOwn(node, field)).map((field) => `${path}.${field}`)
    : [];
  // Repeat templates are the container's children, so this also visits unexpanded templates.
  const descendants = Object.entries(node).flatMap(([key, child]) => {
    if (key === "child") {
      return nodeGestureFields(child, `${path}.child`);
    }
    if (key === "children" && Array.isArray(child)) {
      return child.flatMap((entry, index) =>
        nodeGestureFields(entry, `${path}.children[${index}]`),
      );
    }
    return [];
  });
  return [...fields, ...descendants];
}

/** Authored node paths, including component definitions and repeat templates; never action payloads. */
export function prototypeGestureFields(spec: unknown): string[] {
  const object = record(spec);
  if (!object) {
    return [];
  }
  return [
    ...nodeGestureFields(object.root, "root"),
    ...Object.entries(record(object.components) ?? {}).flatMap(([name, definition]) =>
      nodeGestureFields(record(definition)?.root, `components.${name}.root`),
    ),
  ];
}

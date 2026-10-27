import { record } from "./prototypeTemplate";

/** Node containers in authored field order; opaque payloads are never children. */
export function prototypeNodeChildren(
  node: Record<string, unknown>,
): { value: unknown; suffix: string }[] {
  const children: { value: unknown; suffix: string }[] = [];
  const add = (value: unknown, suffix: string): void => {
    if (record(value)) {
      children.push({ value, suffix });
    }
  };
  for (const [key, value] of Object.entries(node)) {
    if (
      (node.type === "adaptive" &&
        ["list", "detail", "content", "main", "supporting"].includes(key)) ||
      key === "child" ||
      (node.type === "list" && ["header", "footer"].includes(key))
    ) {
      add(value, `.${key}`);
    }
    if (key === "children" && Array.isArray(value)) {
      value.forEach((child, index) => add(child, `.children[${index}]`));
    }
    const screens = key === "screens" ? record(value) : undefined;
    if (screens) {
      for (const [name, screen] of Object.entries(screens)) {
        add(screen, `.screens[${JSON.stringify(name)}]`);
      }
    }
  }
  return children;
}

export function prototypeSpecNodeRoots(spec: unknown): { node: unknown; path: string }[] {
  const object = record(spec);
  if (!object) {
    return [];
  }
  const roots: { node: unknown; path: string }[] = [];
  if (Object.hasOwn(object, "root")) {
    roots.push({ node: object.root, path: "root" });
  }
  for (const [name, value] of Object.entries(record(object.components) ?? {})) {
    const definition = record(value);
    if (definition && Object.hasOwn(definition, "root")) {
      roots.push({
        node: definition.root,
        path: `components.${name}.root`,
      });
    }
  }
  return roots;
}

/** Iterative depth-first pre-order, safe before the validator checks nesting depth. */
export function walkPrototypeNodes(
  spec: unknown,
  visit: (node: Record<string, unknown>, path: string) => void,
): void {
  const pending = prototypeSpecNodeRoots(spec).reverse();
  while (pending.length) {
    const { node, path } = pending.pop()!;
    const object = record(node);
    if (!object) {
      continue;
    }
    visit(object, path);
    const children = prototypeNodeChildren(object);
    for (let index = children.length - 1; index >= 0; index--) {
      const child = children[index]!;
      pending.push({ node: child.value, path: `${path}${child.suffix}` });
    }
  }
}

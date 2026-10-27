import contract from "../../../schemas/prototype-spec-contract.json";
import { PrototypeRepeatData } from "./prototypeData";
import { prototypeNodeChildren, walkPrototypeNodes } from "./prototypeNodeChildren";
import { record, type Raw } from "./prototypeTemplate";

export const MAX_PROTOTYPE_SCROLL_BINDINGS = contract.limits.MAX_PROTOTYPE_SCROLL_BINDINGS;
const outputs = ["alpha", "scale", "offsetY", "offsetX", "blur"];
interface Located {
  value: Raw;
  path: string;
}

export function prototypeScrollMotionFields(spec: unknown): string[] {
  const fields: string[] = [];
  walkPrototypeNodes(spec, (node, path) => {
    for (const key of ["scrollTransition", "scrollLinked"]) {
      if (Object.hasOwn(node, key)) {
        fields.push(`${path}.${key}`);
      }
    }
  });
  return fields;
}

function screen(path: string, scopes: readonly string[]): string {
  return (
    scopes
      .filter((scope) => path === scope || path.startsWith(`${scope}.`))
      .sort((a, b) => b.length - a.length)[0] ?? "root"
  );
}

function instances(node: Located, nodes: readonly Located[], data: PrototypeRepeatData): number {
  let count = 1;
  for (const parent of nodes) {
    if (!node.path.startsWith(`${parent.path}.children[`)) {
      continue;
    }
    const items = record(parent.value.repeat)?.items;
    if (Array.isArray(items)) {
      count *= items.length;
    } else if (typeof record(items)?.path === "string") {
      count *= data.items(record(items)!.path as string).length;
    }
  }
  return count;
}

function linkedError(
  linked: Raw,
  path: string,
  node: Located,
  nodes: readonly Located[],
  scopes: readonly string[],
) {
  const range = linked.range as number[];
  if (range[0] >= range[1]) {
    return { path: `${path}.range`, message: "Expected two increasing numbers" };
  }
  if (!outputs.some((key) => linked[key] !== undefined)) {
    return { path, message: "Expected at least one scroll output" };
  }
  const source = nodes.find(
    (entry) =>
      entry.value.id === linked.source &&
      entry.value.type === "scroll" &&
      screen(entry.path, scopes) === screen(node.path, scopes),
  );
  return source
    ? undefined
    : { path: `${path}.source`, message: "Expected a scroll id in the same screen" };
}

/** Structural shapes are checked by the closed contract before these cross-node rules. */
export function prototypeScrollMotionError(
  spec: unknown,
  nodes: readonly Located[],
): { path: string; message: string } | undefined {
  let count = 0;
  const scopes = nodes.flatMap((node) =>
    prototypeNodeChildren(node.value)
      .filter((child) => child.suffix.startsWith(".screens["))
      .map((child) => `${node.path}${child.suffix}`),
  );
  const data = new PrototypeRepeatData(record(spec)?.data);
  for (const node of nodes) {
    const linked = record(node.value.scrollLinked);
    const transition = record(node.value.scrollTransition);
    if (!linked && !transition) {
      continue;
    }
    count += (Number(Boolean(linked)) + Number(Boolean(transition))) * instances(node, nodes, data);
    if (count > MAX_PROTOTYPE_SCROLL_BINDINGS) {
      return { path: node.path, message: "Scroll binding limit exceeded" };
    }
    if (linked) {
      const error = linkedError(linked, `${node.path}.scrollLinked`, node, nodes, scopes);
      if (error) {
        return error;
      }
    }
    if (
      transition &&
      !nodes.some(
        (parent) =>
          node.path.startsWith(`${parent.path}.`) &&
          screen(parent.path, scopes) === screen(node.path, scopes) &&
          (["scroll", "pager", "carousel"].includes(String(parent.value.type)) ||
            parent.value.repeat !== undefined),
      )
    ) {
      return {
        path: `${node.path}.scrollTransition`,
        message: "Expected a scroll, pager, carousel or repeat ancestor",
      };
    }
  }
  return undefined;
}

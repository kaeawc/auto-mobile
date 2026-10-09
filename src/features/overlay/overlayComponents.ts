import contract from "../../../schemas/overlay-spec-contract.json";
import {
  bindNodeFields,
  bindTyped,
  mapBindableFields,
  record,
  STATE_KEY,
  templateFieldReferences,
  type Binding,
  type Instance,
  type Raw,
} from "./overlayTemplate";

/**
 * Reusable components (#11053), expanded on the host.
 *
 * A spec may declare `components: {name: {root: <node>}}` and place
 * `{type: "use", component: name, props: {...}}` anywhere a node goes. Each `use` is replaced by
 * a copy of the component's root with `{props.<field>}` bound in the same fields `repeat` binds
 * (`overlayTemplate.ts`), and the `components` map is dropped, so validation limits, transport
 * and both device renderers only ever see plain nodes. A `use` expands to exactly one node, so
 * every node outside a component keeps its authored path.
 */

/** How deep `use` nodes may nest inside components (a component using a component ...). */
export const MAX_OVERLAY_COMPONENT_DEPTH = 8;

export interface ComponentError {
  path: string;
  message: string;
}

export type ComponentExpansion =
  | {
      success: true;
      /** The spec with every `use` replaced and `components` removed; the input when it had none. */
      spec: unknown;
      /** Whether anything was expanded, so callers can skip the second byte check. */
      expanded: boolean;
      /** Maps a path in the expanded spec back to where it was authored. */
      locate: (path: string) => string;
    }
  | { success: false; error: ComponentError };

const PROPS: Binding = { alias: "props", index: false };
const USE_FIELDS = new Set(["type", "component", "props"]);

/** Expanded paths of component roots and the authored location each one stands for. */
class Locations {
  private readonly roots: { expanded: string; authored: string }[] = [];

  add(expanded: string, authored: string): void {
    this.roots.push({ expanded, authored });
  }

  /** The longest recorded root that `path` lies in, with the rest of the path appended. */
  locate = (path: string): string => {
    let best: { expanded: string; authored: string } | undefined;
    for (const root of this.roots) {
      const inside =
        path === root.expanded ||
        path.startsWith(`${root.expanded}.`) ||
        path.startsWith(`${root.expanded}[`);
      if (inside && (!best || root.expanded.length > best.expanded.length)) {
        best = root;
      }
    }
    return best ? best.authored + path.slice(best.expanded.length) : path;
  };
}

interface Context {
  components: Record<string, Raw>;
  locations: Locations;
  nodes: number;
}

/** A node after expansion, or the first error met while expanding it. */
type Expanded = { node: Raw; error?: undefined } | { node?: undefined; error: ComponentError };

function fail(context: Context, expandedPath: string, message: string): ComponentError {
  return { path: context.locations.locate(expandedPath), message };
}

function isScalar(value: unknown): boolean {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function childNodes(node: Raw): Raw[] {
  const single = record(node.child);
  if (single) {
    return [single];
  }
  const list = Array.isArray(node.children) ? (node.children as unknown[]) : [];
  return list.flatMap((entry) => {
    const child = record(entry);
    return child ? [child] : [];
  });
}

/** Every string in a bindable field of a component root, through every node it contains. */
function bindableStrings(node: Raw): string[] {
  const own: unknown[] = [];
  mapBindableFields(node, "", (value) => {
    own.push(value);
    return value;
  });
  const props = node.type === "use" ? Object.values(record(node.props) ?? {}) : [];
  return [...own, ...props]
    .filter((value): value is string => typeof value === "string")
    .concat(childNodes(node).flatMap(bindableStrings));
}

/** Prop names a component root references. */
function propReferences(root: Raw): Set<string> {
  return new Set(bindableStrings(root).flatMap((text) => templateFieldReferences(text, PROPS)));
}

/** Binds `{props.*}` through a whole component root, including nested `use` props. */
function bindProps(node: Raw, instance: Instance): Raw {
  const bound = bindNodeFields(node, "", instance);
  const props = bound.type === "use" ? record(bound.props) : undefined;
  if (props) {
    bound.props = Object.fromEntries(
      Object.entries(props).map(([name, value]) => [name, bindTyped(value, instance)]),
    );
  }
  const single = record(bound.child);
  if (single) {
    bound.child = bindProps(single, instance);
  } else if (Array.isArray(bound.children)) {
    bound.children = (bound.children as unknown[]).map((entry) => {
      const child = record(entry);
      return child ? bindProps(child, instance) : entry;
    });
  }
  return bound;
}

/** The first shape error of a `use` node's own fields and props. */
function useShapeError(use: Raw, path: string, context: Context): ComponentError | undefined {
  const unknown = Object.keys(use).find((key) => !USE_FIELDS.has(key));
  if (unknown !== undefined) {
    return fail(context, `${path}.${unknown}`, "Unknown property");
  }
  if (typeof use.component !== "string") {
    return fail(context, `${path}.component`, "Required property");
  }
  if (use.props !== undefined && !record(use.props)) {
    return fail(context, `${path}.props`, "Expected object");
  }
  for (const [name, value] of Object.entries(record(use.props) ?? {})) {
    if (!STATE_KEY.test(name)) {
      return fail(context, `${path}.props[${JSON.stringify(name)}]`, "Invalid prop name");
    }
    if (!isScalar(value)) {
      return fail(
        context,
        `${path}.props.${name}`,
        "Component prop must be a string, number or boolean",
      );
    }
  }
  return undefined;
}

/** Every prop the root references is passed, and every passed prop is referenced. */
function propsError(
  props: Raw,
  root: Raw,
  path: string,
  context: Context,
): ComponentError | undefined {
  const referenced = propReferences(root);
  const missing = [...referenced].find((name) => !Object.hasOwn(props, name));
  if (missing !== undefined) {
    return fail(context, `${path}.props`, `Missing component prop ${JSON.stringify(missing)}`);
  }
  const unused = Object.keys(props).find((name) => !referenced.has(name));
  return unused === undefined
    ? undefined
    : fail(context, `${path}.props.${unused}`, "Unused component prop");
}

/** The component a `use` names, or why it cannot be placed here. */
function resolveUse(
  use: Raw,
  path: string,
  stack: string[],
  context: Context,
): { name: string; root: Raw; props: Raw } | { error: ComponentError } {
  const shape = useShapeError(use, path, context);
  if (shape) {
    return { error: shape };
  }
  const name = use.component as string;
  const component = Object.hasOwn(context.components, name) ? context.components[name] : undefined;
  if (!component) {
    return {
      error: fail(context, `${path}.component`, `Unknown component ${JSON.stringify(name)}`),
    };
  }
  if (stack.includes(name)) {
    const cycle = [...stack, name].join(" → ");
    return { error: fail(context, `${path}.component`, `Component cycle: ${cycle}`) };
  }
  if (stack.length + 1 > MAX_OVERLAY_COMPONENT_DEPTH) {
    return { error: fail(context, path, "Component nesting depth limit exceeded") };
  }
  const props = record(use.props) ?? {};
  const root = record(component.root) ?? {};
  const error = propsError(props, root, path, context);
  return error ? { error } : { name, root, props };
}

/** Replaces one `use` node with its bound component root, then expands inside that root. */
function expandUse(use: Raw, path: string, stack: string[], context: Context): Expanded {
  const resolved = resolveUse(use, path, stack, context);
  if ("error" in resolved) {
    return { error: resolved.error };
  }
  const { name, root, props } = resolved;
  const authored = `${context.locations.locate(path)} (use ${name}) → components.${name}.root`;
  context.locations.add(path, authored);
  const bound = bindProps(root, { binding: PROPS, values: props });
  return expandNode(bound, path, [...stack, name], context);
}

function expandChildren(node: Raw, path: string, stack: string[], context: Context): Expanded {
  const single = record(node.child);
  if (single) {
    const child = expandNode(single, `${path}.child`, stack, context);
    return child.error ? child : { node: { ...node, child: child.node } };
  }
  if (!Array.isArray(node.children)) {
    return { node };
  }
  const children: unknown[] = [];
  for (const [index, entry] of (node.children as unknown[]).entries()) {
    const child = record(entry);
    const expanded = child
      ? expandNode(child, `${path}.children[${index}]`, stack, context)
      : { node: entry as Raw };
    if (expanded.error) {
      return expanded;
    }
    children.push(expanded.node);
  }
  return { node: { ...node, children } };
}

function expandNode(node: Raw, path: string, stack: string[], context: Context): Expanded {
  if (node.type === "use") {
    return expandUse(node, path, stack, context);
  }
  context.nodes++;
  if (context.nodes > contract.limits.MAX_OVERLAY_NODES) {
    return { error: fail(context, path, "Expanded node limit exceeded") };
  }
  return expandChildren(node, path, stack, context);
}

function hasUse(node: Raw): boolean {
  return node.type === "use" || childNodes(node).some(hasUse);
}

/** The first shape error of one `components` entry: an object holding only a `root` node. */
function definitionError(name: string, entry: unknown): ComponentError | undefined {
  const named = STATE_KEY.test(name);
  const path = named ? `components.${name}` : `components[${JSON.stringify(name)}]`;
  if (!named) {
    return { path, message: "Invalid component name" };
  }
  const definition = record(entry);
  if (!definition) {
    return { path, message: "Expected object" };
  }
  const extra = Object.keys(definition).find((key) => key !== "root");
  if (extra !== undefined) {
    return { path: `${path}.${extra}`, message: "Unknown property" };
  }
  return record(definition.root) ? undefined : { path: `${path}.root`, message: "Expected object" };
}

/** The `components` map, shape-checked, or its first shape error. */
function componentsOf(value: unknown): Record<string, Raw> | ComponentError {
  if (value === undefined) {
    return {};
  }
  const map = record(value);
  if (!map) {
    return { path: "components", message: "Expected object" };
  }
  for (const [name, entry] of Object.entries(map)) {
    const error = definitionError(name, entry);
    if (error) {
      return error;
    }
  }
  return map as Record<string, Raw>;
}

function isError(value: Record<string, Raw> | ComponentError): value is ComponentError {
  return typeof value.path === "string" && typeof value.message === "string";
}

/**
 * Expands every `use` node against the spec's `components` map. A spec with neither is returned
 * as is. Errors carry the authored path; one inside an expansion names each `use` it went
 * through, for example `root.children[2] (use postCard) → components.postCard.root.children[1]`.
 */
export function expandOverlayComponents(spec: unknown): ComponentExpansion {
  const data = record(spec);
  const root = record(data?.root);
  if (!data || !root || (data.components === undefined && !hasUse(root))) {
    return { success: true, spec, expanded: false, locate: (path) => path };
  }
  const components = componentsOf(data.components);
  if (isError(components)) {
    return { success: false, error: components };
  }
  const locations = new Locations();
  const expanded = expandNode(root, "root", [], { components, locations, nodes: 0 });
  if (expanded.error) {
    return { success: false, error: expanded.error };
  }
  const rest = { ...data };
  delete rest.components;
  return {
    success: true,
    spec: { ...rest, root: expanded.node },
    expanded: true,
    locate: locations.locate,
  };
}

/** The spec a device is sent: components expanded, or the input when expansion does not apply. */
export function overlaySpecForDevice(spec: unknown): unknown {
  const expansion = expandOverlayComponents(spec);
  return expansion.success ? expansion.spec : spec;
}

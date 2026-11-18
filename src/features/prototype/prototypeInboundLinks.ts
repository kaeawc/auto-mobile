import { validateLinkTable, type PrototypeLinkEntry } from "./prototypeLinkMatcher";
import { record, type Raw } from "./prototypeTemplate";
import type { Located, PrototypeValidationError } from "./prototypeBindingValidation";

/** Query metadata stays outside the matcher, which consumes only scalar declarations. */
function matcherEntry(entry: Raw): PrototypeLinkEntry {
  return {
    path: String(entry.path),
    query: Object.fromEntries(
      Object.entries(record(entry.query) ?? {}).map(([name, declaration]) => [
        name,
        typeof declaration === "string" ? declaration : String(record(declaration)?.type),
      ]),
    ),
    usedCaptures: bindings(entry.actions),
  };
}

const bindingMaps = new Set(["params", "context", "args", "headers", "query", "form"]);
function bindingChildren(form: Raw): unknown[] {
  return Object.entries(form).flatMap(([key, child]) => {
    if (bindingMaps.has(key)) {
      return Object.values(record(child) ?? {});
    }
    if (key === "payload") {
      return [];
    }
    if (key === "value" && !record(child)?.link) {
      return [];
    }
    return [child];
  });
}

function bindings(value: unknown): Set<string> {
  if (Array.isArray(value)) {
    return new Set(value.flatMap((item) => [...bindings(item)]));
  }
  const form = record(value);
  if (!form || (Object.keys(form).length === 1 && Object.hasOwn(form, "value"))) {
    return new Set();
  }
  if (Object.keys(form).length === 1 && typeof form.link === "string") {
    return new Set([form.link]);
  }
  return new Set(bindingChildren(form).flatMap((child) => [...bindings(child)]));
}

function linkTypes(entry: PrototypeLinkEntry | undefined): ReadonlyMap<string, string> {
  const types = new Map<string, string>();
  for (const segment of entry?.path.split("/") ?? []) {
    if (segment.startsWith("{") && segment.endsWith("}")) {
      types.set(segment.slice(1, -1), "string");
    }
  }
  for (const [name, type] of Object.entries(entry?.query ?? {})) {
    types.set(name, type.replace(/\?$/, "").replace(/^int$/, "number"));
  }
  return types;
}

function routeTypeError(
  target: unknown,
  stack: Raw | undefined,
  types: ReadonlyMap<string, string>,
): string | undefined {
  const navigation = record(target) ?? {};
  const declared = record(record(record(stack?.routes)?.[String(navigation.screen)])?.params) ?? {};
  for (const [name, value] of Object.entries(record(navigation.params) ?? {})) {
    const binding = record(value)?.link;
    if (typeof binding === "string" && types.get(binding) !== declared[name]) {
      return `Wrong type for route param ${JSON.stringify(name)}`;
    }
  }
  return undefined;
}

function actionError(
  action: Raw,
  types: ReadonlyMap<string, string>,
  root: Raw,
  nodes: readonly Located[],
): string | undefined {
  if ([...bindings(action)].some((name) => !types.has(name))) {
    return "Unknown link binding";
  }
  const written = record(action.value)?.link;
  const stateValue = record(root.state)?.[String(action.key)];
  if (
    action.type === "setState" &&
    typeof written === "string" &&
    stateValue !== undefined &&
    types.get(written) !== typeof stateValue
  ) {
    return "Wrong type for link state value";
  }
  const stack = nodes.find(
    ({ value }) => value.type === "stack" && value.id === action.stack,
  )?.value;
  const targets = action.type === "setStack" && Array.isArray(action.path) ? action.path : [action];
  return targets
    .map((target) => routeTypeError(target, stack, types))
    .find((error) => error !== undefined);
}

/** Inbound navigation is independent of the platform module named links. */
export function prototypeInboundLinksError(
  spec: unknown,
  nodes: readonly Located[],
  actions: readonly Located[],
): PrototypeValidationError | undefined {
  const root = record(spec) ?? {};
  const entries = Array.isArray(root.links)
    ? root.links.map((entry) => matcherEntry(record(entry)!))
    : [];
  const first = validateLinkTable(entries)[0];
  if (first) {
    return { path: `links[${first.index}]`, message: first.message };
  }
  if (
    root.links !== undefined &&
    (!Array.isArray(root.requires) || !root.requires.includes("prototype_links_v1"))
  ) {
    return { path: "requires", message: "links requires prototype_links_v1" };
  }
  for (const action of actions) {
    const index = /^links\[(\d+)\]\.actions\[/.exec(action.path)?.[1];
    const entry = index === undefined ? undefined : entries[Number(index)];
    const message = actionError(action.value, linkTypes(entry), root, nodes);
    if (message) {
      return { path: action.path, message };
    }
  }
  return undefined;
}

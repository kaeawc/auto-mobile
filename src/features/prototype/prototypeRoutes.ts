import { prototypeContractPatterns } from "./prototypeContractPatterns";
import {
  mapBindableFields,
  record,
  templateFieldReferences,
  visitPrototypeHandlerFields,
  type Raw,
  type FieldKind,
} from "./prototypeTemplate";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
import type { Located, PrototypeValidationError } from "./prototypeBindingValidation";

export { PROTOTYPE_ROUTES_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
const routeFields = (text: string) =>
  templateFieldReferences(text, { alias: "route", index: false });
const at = (path: string, key: string) =>
  prototypeContractPatterns.pathKey.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
const fail = (path: string, message: string): PrototypeValidationError => ({ path, message });

function declaredRouteParamsError(
  route: Raw,
  routePath: string,
  isStart: boolean,
): PrototypeValidationError | undefined {
  const keys = Object.keys(record(route.params) ?? {}).sort();
  for (const key of keys) {
    if (!prototypeContractPatterns.pathKey.test(key)) {
      return fail(at(`${routePath}.params`, key), "Invalid route param name");
    }
  }
  if (isStart && keys.length) {
    return fail(`${routePath}.params`, "Start screen cannot declare route params");
  }
  return undefined;
}

function onBackLoopError(
  action: Located,
  routePath: string,
  stackId: unknown,
): PrototypeValidationError | undefined {
  if (
    action.path.startsWith(`${routePath}.onBack[`) &&
    action.value.type === "pop" &&
    action.value.stack === stackId &&
    action.value.force !== true
  ) {
    return fail(action.path, "Direct onBack pop requires force: true");
  }
  return undefined;
}

function onEnterLoopError(
  action: Located,
  routePath: string,
  stackId: unknown,
  screen: string,
): PrototypeValidationError | undefined {
  if (
    action.path.startsWith(`${routePath}.onEnter[`) &&
    ["push", "replace"].includes(String(action.value.type)) &&
    action.value.stack === stackId &&
    action.value.screen === screen
  ) {
    return fail(action.path, "onEnter cannot navigate to its own screen");
  }
  return undefined;
}

function stackRoutesError(
  { value, path }: Located,
  actions: Located[],
): PrototypeValidationError | undefined {
  const screens = record(value.screens) ?? {};
  for (const [name, raw] of Object.entries(record(value.routes) ?? {}).sort()) {
    const routePath = at(`${path}.routes`, name);
    if (!Object.hasOwn(screens, name)) {
      return fail(routePath, "Unknown route screen");
    }
    const paramsError = declaredRouteParamsError(
      record(raw) ?? {},
      routePath,
      name === value.start,
    );
    if (paramsError) {
      return paramsError;
    }
    for (const action of actions) {
      const error =
        onBackLoopError(action, routePath, value.id) ??
        onEnterLoopError(action, routePath, value.id, name);
      if (error) {
        return error;
      }
    }
  }
  return undefined;
}

function suppliedRouteParamsError(
  params: Raw,
  declared: Raw,
  path: string,
): PrototypeValidationError | undefined {
  for (const key of Object.keys(params).sort()) {
    if (!prototypeContractPatterns.pathKey.test(key)) {
      return fail(path, "Invalid route param name");
    }
    if (!Object.hasOwn(declared, key)) {
      return fail(path, `Undeclared route param ${JSON.stringify(key)}`);
    }
    if (!record(params[key]) && typeof params[key] !== declared[key]) {
      return fail(path, `Wrong type for route param ${JSON.stringify(key)}`);
    }
  }
  for (const key of Object.keys(declared).sort()) {
    if (!Object.hasOwn(params, key)) {
      return fail(path, `Missing route param ${JSON.stringify(key)}`);
    }
  }
  return undefined;
}

function navigationEntryError(
  raw: unknown,
  stack: Raw,
  action: Located,
): PrototypeValidationError | undefined {
  const entry = record(raw) ?? {};
  if (!Object.hasOwn(record(stack.screens) ?? {}, String(entry.screen))) {
    return action.value.type === "setStack" ? fail(action.path, "Unknown stack screen") : undefined;
  }
  const declared = record(record(record(stack.routes)?.[String(entry.screen)])?.params) ?? {};
  return suppliedRouteParamsError(record(entry.params) ?? {}, declared, action.path);
}

function navigationRouteError(
  action: Located,
  stacks: Located[],
): PrototypeValidationError | undefined {
  const { value } = action;
  if (!["push", "replace", "setStack"].includes(String(value.type))) {
    return undefined;
  }
  const stack = stacks.find((entry) => entry.value.id === value.stack)?.value;
  if (!stack) {
    return undefined; // The existing stack reference validator reports this.
  }
  const entries = value.type === "setStack" && Array.isArray(value.path) ? value.path : [value];
  for (const raw of entries) {
    const error = navigationEntryError(raw, stack, action);
    if (error) {
      return error;
    }
  }
  return undefined;
}

interface RouteScope {
  params: Raw;
}

function placeholderScope(
  fieldPath: string,
  ownerByPath: Map<string, RouteScope>,
): RouteScope | undefined {
  let parent = fieldPath;
  let scope: RouteScope | undefined;
  while (!scope && parent.includes(".")) {
    parent = parent.slice(0, parent.lastIndexOf("."));
    scope = ownerByPath.get(parent);
  }
  return scope;
}

function routePlaceholderError(
  value: string,
  fieldPath: string,
  scope: RouteScope | undefined,
): PrototypeValidationError | undefined {
  for (const name of routeFields(value)) {
    if (!scope) {
      return fail(fieldPath, "Route placeholder outside a screen");
    }
    if (!Object.hasOwn(scope.params, name)) {
      return fail(fieldPath, `Undeclared route param ${JSON.stringify(name)}`);
    }
  }
  return undefined;
}

function routePointerError(
  value: string,
  fieldPath: string,
  kind: FieldKind,
): PrototypeValidationError | undefined {
  if (
    ["dataPath", "requestInto", "routePointer"].includes(kind) &&
    value.split("/").some((part) => {
      const names = routeFields(part);
      return names.length > 0 && (names.length !== 1 || part !== `{route.${names[0]}}`);
    })
  ) {
    return fail(fieldPath, "Route placeholder must occupy a whole data pointer segment");
  }
  return undefined;
}

/** Static route relationships; route values remain dynamic until navigation runs on a device. */
export function prototypeRoutesError(
  spec: unknown,
  nodes: Located[],
  actions: Located[],
): PrototypeValidationError | undefined {
  const stacks = nodes.filter(({ value }) => value.type === "stack");
  for (const stack of stacks) {
    const error = stackRoutesError(stack, actions);
    if (error) {
      return error;
    }
  }
  for (const action of actions) {
    const error = navigationRouteError(action, stacks);
    if (error) {
      return error;
    }
  }
  return routePlaceholderScopeError(spec, nodes, stacks);
}

function routePlaceholderScopeError(
  spec: unknown,
  nodes: Located[],
  stacks: Located[],
): PrototypeValidationError | undefined {
  const owners = stacks.flatMap((stack) =>
    Object.keys(record(stack.value.screens) ?? {}).map((screen) => ({
      prefix: `${stack.path}.screens[${JSON.stringify(screen)}]`,
      lifecycle: at(`${stack.path}.routes`, screen),
      params: record(record(record(stack.value.routes)?.[screen])?.params) ?? {},
    })),
  );
  const ownerByPath = new Map(
    owners.flatMap((owner) => [
      [owner.prefix, owner],
      [owner.lifecycle, owner],
    ]),
  );
  const usesRoutes = prototypeRouteFields(spec).length > 0;
  const aliases = nodes
    .filter(({ value }) => record(value.repeat)?.as === "route")
    .map(({ path }) => `${path}.children[`);
  let error: PrototypeValidationError | undefined;
  const visit: import("./prototypeTemplate").FieldVisitor = (value, fieldPath, kind) => {
    if (
      typeof value !== "string" ||
      (!usesRoutes && aliases.some((prefix) => fieldPath.startsWith(prefix)))
    ) {
      return value;
    }
    const scope = placeholderScope(fieldPath, ownerByPath);
    error ??= routePlaceholderError(value, fieldPath, scope);
    error ??= routePointerError(value, fieldPath, kind);
    return value;
  };
  walkPrototypeNodes(spec, (node, path) => {
    if (usesRoutes && record(node.repeat)?.as === "route") {
      error ??= fail(`${path}.repeat.as`, "route is reserved for route params");
    }
    mapBindableFields(node, path, visit, true);
  });
  visitPrototypeHandlerFields(spec, visit);
  return error;
}

/** Use the same field visitor as validation; opaque payloads never introduce capabilities. */
export function prototypeRouteFields(spec: unknown): string[] {
  const fields: string[] = [];
  const aliases: string[] = [];
  walkPrototypeNodes(spec, (node, path) => {
    if (record(node.repeat)?.as === "route") {
      aliases.push(`${path}.children[`);
    }
  });
  const visit: import("./prototypeTemplate").FieldVisitor = (value, fieldPath, kind) => {
    if (
      kind === "routeFeature" ||
      (typeof value === "string" &&
        routeFields(value).length &&
        !aliases.some((prefix) => fieldPath.startsWith(prefix)))
    ) {
      fields.push(fieldPath);
    }
    return value;
  };
  walkPrototypeNodes(spec, (node, path) => {
    if (node.type === "stack" && node.routes !== undefined) {
      fields.push(`${path}.routes`);
    }
    mapBindableFields(node, path, visit, true);
  });
  visitPrototypeHandlerFields(spec, visit);
  appendStorageRouteFields(spec, fields);
  return fields;
}

function appendStorageRouteFields(spec: unknown, fields: string[]): void {
  const keys = record(record(spec)?.storage)?.keys;
  if (Array.isArray(keys)) {
    keys.forEach((key, index) => {
      if (typeof key === "string" && key.startsWith("stack:")) {
        fields.push(`storage.keys[${index}]`);
      }
    });
  }
}

/** State keys containing a route value are checked after binding by the future runtime. */
export function routeBoundKeys(value: Raw): boolean {
  const keys = [
    "key",
    "stateKey",
    "statusKey",
    "activeKey",
    "hourKey",
    "minuteKey",
    "atEndKey",
  ].map((key) => value[key]);
  keys.push(
    record(value.trailing)?.stateKey,
    record(value.openWhen)?.key,
    record(value.refresh)?.stateKey,
  );
  return keys.some((key) => typeof key === "string" && routeFields(key).length > 0);
}

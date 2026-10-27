import { prototypeContractPatterns } from "./prototypeContractPatterns";
import { mapBindableFields, record, templateFieldReferences, type Raw } from "./prototypeTemplate";
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

/** Static route relationships; route values remain dynamic until navigation runs on a device. */
export function prototypeRoutesError(
  spec: unknown,
  nodes: Located[],
  actions: Located[],
): PrototypeValidationError | undefined {
  const stacks = nodes.filter(({ value }) => value.type === "stack");
  for (const { value, path } of stacks) {
    const screens = record(value.screens) ?? {};
    for (const [name, raw] of Object.entries(record(value.routes) ?? {}).sort()) {
      const route = record(raw) ?? {};
      const routePath = at(`${path}.routes`, name);
      if (!Object.hasOwn(screens, name)) return fail(routePath, "Unknown route screen");
      for (const key of Object.keys(record(route.params) ?? {}).sort()) {
        if (!prototypeContractPatterns.pathKey.test(key))
          return fail(at(`${routePath}.params`, key), "Invalid route param name");
      }
      for (const [index, action] of (Array.isArray(route.onBack) ? route.onBack : []).entries()) {
        const entry = record(action);
        if (entry?.type === "pop" && entry.stack === value.id && entry.force !== true)
          return fail(`${routePath}.onBack[${index}]`, "Direct onBack pop requires force: true");
      }
    }
  }
  for (const { value, path } of actions) {
    if (!["push", "replace", "setStack"].includes(String(value.type))) continue;
    const stack = stacks.find((entry) => entry.value.id === value.stack)?.value;
    if (!stack) continue; // The existing stack reference validator reports this.
    const entries = value.type === "setStack" && Array.isArray(value.path) ? value.path : [value];
    for (const raw of entries) {
      const entry = record(raw) ?? {};
      if (!Object.hasOwn(record(stack.screens) ?? {}, String(entry.screen))) {
        if (value.type === "setStack") return fail(path, "Unknown stack screen");
        continue;
      }
      const declared = record(record(record(stack.routes)?.[String(entry.screen)])?.params) ?? {};
      const params = record(entry.params) ?? {};
      for (const key of Object.keys(params).sort()) {
        if (!prototypeContractPatterns.pathKey.test(key))
          return fail(path, "Invalid route param name");
        if (!Object.hasOwn(declared, key))
          return fail(path, `Undeclared route param ${JSON.stringify(key)}`);
        if (!record(params[key]) && typeof params[key] !== declared[key])
          return fail(path, `Wrong type for route param ${JSON.stringify(key)}`);
      }
      for (const key of Object.keys(declared).sort()) {
        if (!Object.hasOwn(params, key))
          return fail(path, `Missing route param ${JSON.stringify(key)}`);
      }
    }
  }
  let error: PrototypeValidationError | undefined;
  walkPrototypeNodes(spec, (node, path) => {
    if (record(node.repeat)?.as === "route")
      error ??= fail(`${path}.repeat.as`, "route is reserved for route params");
    // The closest screen owns the route scope, including nested stacks' own fields.
    const owners = stacks.flatMap((stack) =>
      Object.keys(record(stack.value.screens) ?? {}).map((screen) => ({
        prefix: `${stack.path}.screens[${JSON.stringify(screen)}]`,
        lifecycle: at(`${stack.path}.routes`, screen),
        params: record(record(record(stack.value.routes)?.[screen])?.params) ?? {},
      })),
    );
    mapBindableFields(
      node,
      path,
      (value, fieldPath, kind) => {
        if (typeof value !== "string") return value;
        const scopes = owners
          .filter(
            ({ prefix, lifecycle }) =>
              fieldPath.startsWith(`${prefix}.`) || fieldPath.startsWith(`${lifecycle}.`),
          )
          .sort((a, b) => b.prefix.length - a.prefix.length);
        for (const name of routeFields(value)) {
          if (!scopes.length) error ??= fail(fieldPath, "Route placeholder outside a screen");
          else if (!Object.hasOwn(scopes[0].params, name))
            error ??= fail(fieldPath, `Undeclared route param ${JSON.stringify(name)}`);
        }
        if (
          ["dataPath", "requestInto", "routePointer"].includes(kind) &&
          value.split("/").some((part) => {
            const names = routeFields(part);
            return names.length > 0 && (names.length !== 1 || part !== `{route.${names[0]}}`);
          })
        )
          error ??= fail(fieldPath, "Route placeholder must occupy a whole data pointer segment");
        return value;
      },
      true,
    );
  });
  return error;
}

/** Use the same field visitor as validation; opaque payloads never introduce capabilities. */
export function prototypeRouteFields(spec: unknown): string[] {
  const fields: string[] = [];
  walkPrototypeNodes(spec, (node, path) => {
    if (node.type === "stack" && node.routes !== undefined) fields.push(`${path}.routes`);
    mapBindableFields(
      node,
      path,
      (value, fieldPath, kind) => {
        const action = record(value);
        if (kind === "routeFeature" || (typeof value === "string" && routeFields(value).length))
          fields.push(fieldPath);
        if (action?.type === "setStack") fields.push(fieldPath);
        return value;
      },
      true,
    );
  });
  const keys = record(record(spec)?.storage)?.keys;
  if (Array.isArray(keys))
    keys.forEach((key, index) => {
      if (typeof key === "string" && key.startsWith("stack:"))
        fields.push(`storage.keys[${index}]`);
    });
  return fields;
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

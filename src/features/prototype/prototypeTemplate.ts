import { prototypeContractPatterns } from "./prototypeContractPatterns";
/**
 * The placeholder grammar and bindable-field set shared by `repeat` list templates and reusable
 * components (#11051, #11053).
 *
 * A placeholder is `{<alias>.<field>}` (and, for `repeat`, `{index}`); any other brace text,
 * including a `{state_key}` state placeholder, stays literal. Repeat placeholders are bound on the
 * device (Kotlin `PrototypeRepeat.kt`, Swift `PrototypeRepeat.swift`) with this same grammar; component
 * `{props.<field>}` placeholders are bound on the host before the spec is validated and sent.
 */

export type Raw = Record<string, unknown>;

/** A literal state key, and the shape of every repeat field name and component prop name. */
export const STATE_KEY = prototypeContractPatterns.stateKey;

/**
 * A state-key field: a literal key, or key characters mixed with at least one placeholder that
 * must bind to a literal key for every instance. Both validators re-check the bound result.
 */
export const BOUND_STATE_KEY_PATTERN = prototypeContractPatterns.boundKey;

export type Segment =
  | { kind: "literal"; text: string }
  | { kind: "index" }
  | { kind: "field"; name: string };

/** The placeholders an alias binds; `index` is false for components, which have no `{index}`. */
export interface Binding {
  alias: string;
  index: boolean;
}

export function record(value: unknown): Raw | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Raw)
    : undefined;
}

function token(inner: string, binding: Binding): Segment | undefined {
  if (binding.index && inner === "index") {
    return { kind: "index" };
  }
  const prefix = `${binding.alias}.`;
  const name = inner.slice(prefix.length);
  return inner.startsWith(prefix) &&
    (binding.alias === "route"
      ? prototypeContractPatterns.pathKey.test(name)
      : STATE_KEY.test(name))
    ? { kind: "field", name }
    : undefined;
}

/** Splits `text` into placeholder segments by a plain scan, exactly as Kotlin and Swift do. */
export function templateSegments(text: string, binding: Binding): Segment[] {
  const segments: Segment[] = [];
  let literal = "";
  let cursor = 0;
  while (cursor < text.length) {
    const close = text[cursor] === "{" ? text.indexOf("}", cursor + 1) : -1;
    const found = close < 0 ? undefined : token(text.slice(cursor + 1, close), binding);
    if (found) {
      if (literal) {
        segments.push({ kind: "literal", text: literal });
      }
      literal = "";
      segments.push(found);
      cursor = close + 1;
    } else {
      literal += text[cursor];
      cursor++;
    }
  }
  if (literal) {
    segments.push({ kind: "literal", text: literal });
  }
  return segments;
}

/** Field names a string references through the binding's alias, in order. */
export function templateFieldReferences(text: string, binding: Binding): string[] {
  return templateSegments(text, binding).flatMap((segment) =>
    segment.kind === "field" ? [segment.name] : [],
  );
}

/** Integral numbers render without a decimal point or exponent at any magnitude, as on devices. */
export function renderScalar(value: unknown): string {
  return typeof value === "number" && Number.isInteger(value)
    ? BigInt(value).toString()
    : String(value);
}

/** One instance's values: the item (or props) and, for repeat, its zero-based position. */
export interface Instance {
  binding: Binding;
  values: Raw;
  index?: number;
}

/** The text with this instance's placeholders bound; unknown fields stay literal. */
export function bindText(text: string, instance: Instance): string {
  const { alias } = instance.binding;
  return templateSegments(text, instance.binding)
    .map((segment) => {
      if (segment.kind === "literal") {
        return segment.text;
      }
      if (segment.kind === "index") {
        return String(instance.index ?? 0);
      }
      return Object.hasOwn(instance.values, segment.name)
        ? renderScalar(instance.values[segment.name])
        : `{${alias}.${segment.name}}`;
    })
    .join("");
}

/** A string that is exactly one placeholder keeps the bound value's own type; others render. */
export function bindTyped(value: unknown, instance: Instance): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const segments = templateSegments(value, instance.binding);
  const only = segments.length === 1 ? segments[0] : undefined;
  if (only?.kind === "index") {
    return instance.index ?? 0;
  }
  if (only?.kind === "field" && Object.hasOwn(instance.values, only.name)) {
    return instance.values[only.name];
  }
  return bindText(value, instance);
}

/**
 * How a bindable field is bound: `text` and `emitName` render to text, `operand` keeps a single
 * placeholder's type, `substring` (a condition's `contains`/`startsWith`) always renders to text, and `key` renders to text that must then be a literal state key.
 * `dataPath` is a data action's `/data/...` pointer: it renders to text, and only a whole
 * `{index}` segment may be a placeholder; `requestInto` is the same grammar for a `request`'s
 * `into`, kept apart so `setData` capability gating does not claim it. `request` and `deviceRequest` mark a whole `request`
 * action (the latter only when `via` is `device`) so capability gates can locate it; their value
 * is the action itself and no binder rewrites it.
 */
export type FieldKind =
  | "text"
  | "operand"
  | "substring"
  | "emitName"
  | "key"
  | "emitBinding"
  | "emitContext"
  | "dataPath"
  | "requestInto"
  | "request"
  | "deviceRequest"
  | "prependData"
  | "scrollTo"
  | "timer"
  | "stackTransition"
  | "routeFeature"
  | "routePointer";

/** True for the kinds holding a `/data/...` path with `{index}` segments. */
export const isDataPathKind = (kind: FieldKind): boolean =>
  kind === "dataPath" || kind === "requestInto";

/** Receives each bindable field's value and path; its result replaces the value. */
export type FieldVisitor = (
  value: unknown,
  path: string,
  kind: FieldKind,
  dataCondition?: boolean,
) => unknown;

function mapField(data: Raw, key: string, path: string, kind: FieldKind, visit: FieldVisitor) {
  if (data[key] !== undefined) {
    data[key] = visit(data[key], `${path}.${key}`, kind);
  }
}

function mapList(
  data: Raw,
  key: string,
  path: string,
  map: (entry: Raw, entryPath: string) => Raw,
): void {
  if (Array.isArray(data[key])) {
    data[key] = (data[key] as unknown[]).map((entry, index) => {
      const value = record(entry);
      return value ? map({ ...value }, `${path}.${key}[${index}]`) : entry;
    });
  }
}

function mapObject(
  data: Raw,
  key: string,
  path: string,
  map: (entry: Raw, entryPath: string) => Raw,
): void {
  const value = record(data[key]);
  if (value) {
    data[key] = map({ ...value }, `${path}.${key}`);
  }
}

function mapKeyList(data: Raw, key: string, path: string, visit: FieldVisitor): void {
  const values = data[key];
  if (Array.isArray(values)) {
    data[key] = values.map((value, index) => visit(value, `${path}.${key}[${index}]`, "key"));
  } else {
    mapField(data, key, path, "key", visit);
  }
}

function mapCondition(condition: Raw, path: string, visit: FieldVisitor): Raw {
  mapField(condition, "data", path, "routePointer", visit);
  mapField(condition, "key", path, "key", visit);
  mapKeyList(condition, "valid", path, visit);
  const operandVisit: FieldVisitor = (value, fieldPath, kind) =>
    visit(value, fieldPath, kind, Object.hasOwn(condition, "data"));
  mapField(condition, "equals", path, "operand", operandVisit);
  mapField(condition, "notEquals", path, "operand", operandVisit);
  mapField(condition, "contains", path, "substring", operandVisit);
  mapField(condition, "startsWith", path, "substring", operandVisit);
  mapObject(condition, "not", path, (entry, entryPath) => mapCondition(entry, entryPath, visit));
  for (const form of ["all", "any"]) {
    mapList(condition, form, path, (entry, entryPath) => mapCondition(entry, entryPath, visit));
  }
  return condition;
}

/** A `{state}` binding names a (possibly repeat-bound) key; every other form is an emit binding. */
function mapBinding(value: unknown, at: string, visit: FieldVisitor): unknown {
  const binding = record(value);
  if (binding && typeof binding.data === "string") {
    visit(binding.data, `${at}.data`, "routePointer");
  }
  return binding && Object.hasOwn(binding, "state")
    ? { ...binding, state: visit(binding.state, `${at}.state`, "key") }
    : visit(value, at, "emitBinding");
}

function mapEmitAction(action: Raw, path: string, visit: FieldVisitor): void {
  mapField(action, "name", path, "emitName", visit);
  mapField(action, "context", path, "emitContext", visit);
  if (record(action.context)) {
    action.context = Object.fromEntries(
      Object.entries(record(action.context)!).map(([name, value]) => {
        const at = prototypeContractPatterns.pathKey.test(name)
          ? `${path}.context.${name}`
          : `${path}.context[${JSON.stringify(name)}]`;
        return [name, mapBinding(value, at, visit)];
      }),
    );
  }
  mapKeyList(action, "requireValid", path, visit);
}

function mapDataAction(action: Raw, path: string, visit: FieldVisitor): void {
  if (action.type === "prependData") {
    visit(action, path, "prependData");
  }
  mapField(action, "path", path, "dataPath", visit);
  if (action.type !== "removeData" && action.value !== undefined) {
    action.value = mapBinding(action.value, `${path}.value`, visit);
  }
}

function mapTimerAction(action: Raw, path: string, visit: FieldVisitor): void {
  if (action.type !== "startTimer" && action.type !== "cancelTimer") {
    return;
  }
  visit(action, path, "timer");
  if (action.type === "startTimer") {
    mapList(action, "actions", path, (entry, at) => mapAction(entry, at, visit));
  }
}

function mapAction(action: Raw, path: string, visit: FieldVisitor): Raw {
  if (["push", "replace", "setStack"].includes(String(action.type))) {
    if (action.type === "setStack" || action.params !== undefined)
      visit(action, path, "routeFeature");
    const entries =
      action.type === "setStack" && Array.isArray(action.path) ? action.path : [action];
    const mapped = entries.map((raw, index) => {
      const entry = record(raw) ? { ...record(raw)! } : undefined;
      if (!entry || !record(entry.params)) return raw;
      const prefix =
        action.type === "setStack" ? `${path}.path[${index}].params` : `${path}.params`;
      entry.params = Object.fromEntries(
        Object.entries(record(entry.params)!).map(([name, value]) => [
          name,
          typeof value === "string"
            ? visit(value, memberPath(prefix, name), "operand")
            : mapBinding(value, memberPath(prefix, name), visit),
        ]),
      );
      return entry;
    });
    if (action.type === "setStack") action.path = mapped;
    else action.params = record(mapped[0])?.params;
  }
  if (action.type === "pop" && action.force !== undefined) visit(action, path, "routeFeature");
  if (["setData", "appendData", "prependData", "removeData"].includes(String(action.type))) {
    mapDataAction(action, path, visit);
    return action;
  }
  switch (action.type) {
    case "setState":
      mapField(action, "key", path, "key", visit);
      mapField(action, "value", path, "operand", visit);
      break;
    case "emit":
      mapEmitAction(action, path, visit);
      break;
    case "toggle":
    case "increment":
    case "decrement":
      mapField(action, "key", path, "key", visit);
      break;
    case "request":
      mapRequestAction(action, path, visit);
      break;
    case "platform":
      mapPlatformAction(action, path, visit);
      break;
    case "scrollTo":
      // Marks the whole action so the chat scroll gate can locate it (#14232).
      visit(action, path, "scrollTo");
      break;
    default:
      mapTimerAction(action, path, visit);
      mapNavigationTransition(action, path, visit);
      break;
  }
  return action;
}

function mapNavigationTransition(action: Raw, path: string, visit: FieldVisitor): void {
  if (action.type === "push" || action.type === "replace") {
    mapField(action, "transition", path, "stackTransition", visit);
  }
}

const memberPath = (path: string, name: string): string =>
  prototypeContractPatterns.pathKey.test(name)
    ? `${path}.${name}`
    : `${path}[${JSON.stringify(name)}]`;

/** A header or query entry: a literal is text, an object is a value binding. */
function mapRequestEntries(action: Raw, field: string, path: string, visit: FieldVisitor): void {
  const entries = record(action[field]);
  if (entries) {
    action[field] = Object.fromEntries(
      Object.entries(entries).map(([name, value]) => {
        const at = memberPath(`${path}.${field}`, name);
        return [
          name,
          typeof value === "string" ? visit(value, at, "text") : mapBinding(value, at, visit),
        ];
      }),
    );
  }
}

/** `url` and literal header/query strings are text; `into` is a data path; follow-ups recurse. */
function mapRequestAction(action: Raw, path: string, visit: FieldVisitor): void {
  visit(action, path, "request");
  if (action.via === "device") {
    visit(action, path, "deviceRequest");
  }
  mapField(action, "url", path, "text", visit);
  mapRequestEntries(action, "headers", path, visit);
  mapRequestEntries(action, "query", path, visit);
  if (action.body !== undefined) {
    action.body = mapBinding(action.body, `${path}.body`, visit);
  }
  mapField(action, "into", path, "requestInto", visit);
  const append = record(action.append);
  if (append) {
    mapField(append, "to", `${path}.append`, "requestInto", visit);
  }
  mapField(action, "statusKey", path, "key", visit);
  for (const field of ["onSuccess", "onError"]) {
    mapList(action, field, path, (entry, entryPath) => mapAction(entry, entryPath, visit));
  }
}

/** A `platform` call (#14294): each argument is a value binding, `into` the request grammar. */
function mapPlatformAction(action: Raw, path: string, visit: FieldVisitor): void {
  const args = record(action.args);
  if (args) {
    action.args = Object.fromEntries(
      Object.entries(args).map(([name, value]) => [
        name,
        mapBinding(value, memberPath(`${path}.args`, name), visit),
      ]),
    );
  }
  mapField(action, "into", path, "requestInto", visit);
  mapField(action, "statusKey", path, "key", visit);
  for (const field of ["onSuccess", "onError"]) {
    mapList(action, field, path, (entry, entryPath) => mapAction(entry, entryPath, visit));
  }
}

function mapActions(data: Raw, path: string, visit: FieldVisitor): void {
  for (const field of [
    "onTap",
    "onLongPress",
    "onDoubleTap",
    "onEndReached",
    "onStartReached",
    "onAppear",
  ]) {
    mapList(data, field, path, (entry, entryPath) => mapAction(entry, entryPath, visit));
  }
}

/** A `{label, onTap?}` part (dialog or snackbar button, app bar action): label and actions bind. */
function mapPart(part: Raw, path: string, visit: FieldVisitor): Raw {
  mapField(part, "label", path, "text", visit);
  mapActions(part, path, visit);
  return part;
}

/** Component fields that take placeholders besides a text node's `text`. */
const COMPONENT_FIELDS: Record<string, (node: Raw, path: string, visit: FieldVisitor) => void> = {
  button: (node, path, visit) => mapField(node, "label", path, "text", visit),
  fab: (node, path, visit) => mapField(node, "label", path, "text", visit),
  segmentedButton: (node, path, visit) =>
    mapList(node, "options", path, (entry, entryPath) => {
      mapField(entry, "label", entryPath, "text", visit);
      return entry;
    }),
  topAppBar: (node, path, visit) => {
    mapField(node, "title", path, "text", visit);
    mapObject(node, "navigationIcon", path, (entry, entryPath) => mapPart(entry, entryPath, visit));
    mapList(node, "actions", path, (entry, entryPath) => mapPart(entry, entryPath, visit));
  },
  textField: (node, path, visit) => {
    mapObject(node, "trailingIcon", path, (entry, entryPath) => mapPart(entry, entryPath, visit));
    mapList(node, "onSubmit", path, (entry, entryPath) => mapAction(entry, entryPath, visit));
  },
  searchBar: (node, path, visit) => {
    mapField(node, "placeholder", path, "text", visit);
    mapList(node, "trailingActions", path, (entry, entryPath) => mapPart(entry, entryPath, visit));
    mapList(node, "onSubmit", path, (entry, entryPath) => mapAction(entry, entryPath, visit));
  },
  tooltip: (node, path, visit) => {
    mapField(node, "text", path, "text", visit);
    mapList(node, "onDismiss", path, (entry, entryPath) => mapAction(entry, entryPath, visit));
  },
  dialog: (node, path, visit) => {
    mapField(node, "title", path, "text", visit);
    mapField(node, "text", path, "text", visit);
    mapObject(node, "confirm", path, (entry, entryPath) => mapPart(entry, entryPath, visit));
    mapObject(node, "dismiss", path, (entry, entryPath) => mapPart(entry, entryPath, visit));
  },
  menu: (node, path, visit) => {
    mapList(node, "items", path, (entry, entryPath) => {
      mapField(entry, "trailingText", entryPath, "text", visit);
      return mapPart(entry, entryPath, visit);
    });
  },
  select: (node, path, visit) => {
    mapField(node, "label", path, "text", visit);
    mapList(node, "options", path, (entry, entryPath) => {
      mapField(entry, "label", entryPath, "text", visit);
      return entry;
    });
  },
  snackbar: (node, path, visit) => {
    mapField(node, "text", path, "text", visit);
    mapObject(node, "action", path, (entry, entryPath) => mapPart(entry, entryPath, visit));
  },
};

/** State-key fields a node binds besides its condition and action keys. */
function mapNodeKeys(node: Raw, path: string, visit: FieldVisitor): void {
  for (const field of ["stateKey", "activeKey", "hourKey", "minuteKey", "atEndKey"]) {
    mapField(node, field, path, "key", visit);
  }
  for (const part of ["trailing", "openWhen", "refresh"]) {
    mapObject(node, part, path, (entry, entryPath) => {
      mapField(entry, part === "openWhen" ? "key" : "stateKey", entryPath, "key", visit);
      return entry;
    });
  }
}

/**
 * Visits one node's own bindable fields (not its children) in a fixed order: `text`, component
 * fields, `visibleWhen`, `styleWhen`, `onTap`, `onLongPress`, `onDoubleTap`, then state-key fields. Returns a copy with each
 * visited value replaced by the visitor's result.
 */
export function mapBindableFields(
  node: Raw,
  path: string,
  visitor: FieldVisitor,
  includeRoutePointers = false,
): Raw {
  const visit: FieldVisitor = (value, at, kind, dataCondition) =>
    kind === "routePointer" && !includeRoutePointers
      ? value
      : visitor(value, at, kind, dataCondition);
  const copy = { ...node };
  mapObject(copy, "semantics", path, (entry, entryPath) => {
    mapField(entry, "label", entryPath, "text", visit);
    mapField(entry, "hint", entryPath, "text", visit);
    return entry;
  });
  if (copy.type === "text") {
    mapField(copy, "text", path, "text", visit);
    mapObject(copy, "linkify", path, (options, optionsPath) => {
      mapActions(options, optionsPath, visit);
      return options;
    });
    mapList(copy, "spans", path, (span, spanPath) => {
      mapField(span, "text", spanPath, "text", visit);
      mapActions(span, spanPath, visit);
      return span;
    });
  }
  const component = typeof copy.type === "string" ? COMPONENT_FIELDS[copy.type] : undefined;
  component?.(copy, path, visit);
  mapField(copy, "errorText", path, "text", visit);
  mapObject(copy, "errorWhen", path, (entry, entryPath) => mapCondition(entry, entryPath, visit));
  mapObject(copy, "enabledWhen", path, (entry, entryPath) => mapCondition(entry, entryPath, visit));
  mapList(copy, "checks", path, (entry, entryPath) => {
    mapField(entry, "message", entryPath, "text", visit);
    return entry;
  });
  mapObject(copy, "visibleWhen", path, (entry, entryPath) => mapCondition(entry, entryPath, visit));
  mapList(copy, "styleWhen", path, (entry, entryPath) => {
    mapObject(entry, "when", entryPath, (condition, conditionPath) =>
      mapCondition(condition, conditionPath, visit),
    );
    return entry;
  });
  mapActions(copy, path, visit);
  mapObject(copy, "swipeActions", path, (entry, entryPath) => {
    for (const side of ["start", "end"]) {
      mapList(entry, side, entryPath, (action, actionPath) => mapPart(action, actionPath, visit));
    }
    return entry;
  });
  mapObject(copy, "refresh", path, (entry, entryPath) => {
    mapList(entry, "onRefresh", entryPath, (action, actionPath) =>
      mapAction(action, actionPath, visit),
    );
    return entry;
  });
  mapNodeKeys(copy, path, visit);
  if (copy.type === "stack") {
    const routes = record(copy.routes);
    if (routes)
      copy.routes = Object.fromEntries(
        Object.entries(routes)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([name, raw]) => {
            const route = { ...record(raw) };
            const routePath = memberPath(`${path}.routes`, name);
            for (const field of ["onEnter", "onBack"])
              mapList(route, field, routePath, (action, actionPath) =>
                mapAction(action, actionPath, visit),
              );
            return [name, route];
          }),
      );
  }
  return copy;
}

/** Binds every bindable field of one node to an instance, the way the device binds a template. */
export function bindNodeFields(node: Raw, path: string, instance: Instance): Raw {
  return mapBindableFields(node, path, (value, _path, kind) => {
    if (kind === "emitBinding" && instance.binding.index) {
      const binding = record(value);
      if (typeof binding?.item === "string") {
        return { value: instance.values[binding.item] };
      }
      if (binding?.index === true) {
        return { value: instance.index };
      }
    }
    if (typeof value !== "string") {
      return value;
    }
    return kind === "operand" ? bindTyped(value, instance) : bindText(value, instance);
  });
}

/** The state-key values the validators type-check: node keys and an action's `key`. */
export function checkedKeyValues(value: Raw): unknown[] {
  const keys: unknown[] = [];
  mapBindableFields(value, "", (field, _path, kind) => {
    if (kind === "key") {
      keys.push(field);
    }
    return field;
  });
  return [
    ...keys,
    ...(Array.isArray(value.requireValid) ? value.requireValid : []),
    value.key,
    value.stateKey,
    value.statusKey,
    value.activeKey,
    value.hourKey,
    value.minuteKey,
    record(value.trailing)?.stateKey,
    record(value.openWhen)?.key,
    record(value.refresh)?.stateKey,
  ];
}

/** Binds only the state-key fields the validators type-check: node keys and an action's `key`. */
export function bindCheckedKeys(value: Raw, instance: Instance): Raw {
  const copy = mapBindableFields(value, "", (field, _path, kind) =>
    kind === "key" && typeof field === "string" ? bindText(field, instance) : field,
  );
  if (Array.isArray(copy.requireValid)) {
    copy.requireValid = copy.requireValid.map((key) =>
      typeof key === "string" ? bindText(key, instance) : key,
    );
  }
  const bind = (entry: unknown) => (typeof entry === "string" ? bindText(entry, instance) : entry);
  for (const field of [
    "key",
    "stateKey",
    "statusKey",
    "activeKey",
    "hourKey",
    "minuteKey",
    "atEndKey",
  ]) {
    if (copy[field] !== undefined) {
      copy[field] = bind(copy[field]);
    }
  }
  const trailing = record(copy.trailing);
  if (trailing?.stateKey !== undefined) {
    copy.trailing = { ...trailing, stateKey: bind(trailing.stateKey) };
  }
  const openWhen = record(copy.openWhen);
  if (openWhen?.key !== undefined) {
    copy.openWhen = { ...openWhen, key: bind(openWhen.key) };
  }
  const refresh = record(copy.refresh);
  if (refresh?.stateKey !== undefined) {
    copy.refresh = { ...refresh, stateKey: bind(refresh.stateKey) };
  }
  return copy;
}

/** Visit root platform handler actions, in the contract's sorted event-name order. */
export function visitPrototypeHandlerFields(spec: unknown, visit: FieldVisitor): void {
  const handlers = record(record(record(spec)?.platform)?.on);
  for (const name of Object.keys(handlers ?? {}).sort()) {
    const actions = handlers![name];
    if (!Array.isArray(actions)) {
      continue;
    }
    actions.forEach((action, index) => {
      const value = record(action);
      if (value) {
        mapAction({ ...value }, `platform.on[${JSON.stringify(name)}][${index}]`, visit);
      }
    });
  }
}

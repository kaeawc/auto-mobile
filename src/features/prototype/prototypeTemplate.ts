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
export const STATE_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * A state-key field: a literal key, or key characters mixed with at least one placeholder that
 * must bind to a literal key for every instance. Both validators re-check the bound result.
 */
export const BOUND_STATE_KEY_PATTERN =
  /^(?:[A-Za-z_][A-Za-z0-9_]{0,63}|(?=[^{]*\{)(?:[A-Za-z0-9_]|\{(?:index|[A-Za-z_][A-Za-z0-9_]{0,63}\.[A-Za-z_][A-Za-z0-9_]{0,63})\})+)$/;

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
  return inner.startsWith(prefix) && STATE_KEY.test(name) ? { kind: "field", name } : undefined;
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
 * placeholder's type, and `key` renders to text that must then be a literal state key.
 * `dataPath` is a data action's `/data/...` pointer: it renders to text, and only a whole
 * `{index}` segment may be a placeholder.
 */
export type FieldKind =
  | "text"
  | "operand"
  | "emitName"
  | "key"
  | "emitBinding"
  | "emitContext"
  | "dataPath";

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
  mapField(condition, "key", path, "key", visit);
  mapKeyList(condition, "valid", path, visit);
  const operandVisit: FieldVisitor = (value, fieldPath, kind) =>
    visit(value, fieldPath, kind, Object.hasOwn(condition, "data"));
  mapField(condition, "equals", path, "operand", operandVisit);
  mapField(condition, "notEquals", path, "operand", operandVisit);
  mapObject(condition, "not", path, (entry, entryPath) => mapCondition(entry, entryPath, visit));
  for (const form of ["all", "any"]) {
    mapList(condition, form, path, (entry, entryPath) => mapCondition(entry, entryPath, visit));
  }
  return condition;
}

/** A `{state}` binding names a (possibly repeat-bound) key; every other form is an emit binding. */
function mapBinding(value: unknown, at: string, visit: FieldVisitor): unknown {
  const binding = record(value);
  return binding && Object.hasOwn(binding, "state")
    ? { ...binding, state: visit(binding.state, `${at}.state`, "key") }
    : visit(value, at, "emitBinding");
}

function mapAction(action: Raw, path: string, visit: FieldVisitor): Raw {
  switch (action.type) {
    case "setState":
      mapField(action, "key", path, "key", visit);
      mapField(action, "value", path, "operand", visit);
      break;
    case "emit":
      mapField(action, "name", path, "emitName", visit);
      mapField(action, "context", path, "emitContext", visit);
      if (record(action.context)) {
        action.context = Object.fromEntries(
          Object.entries(record(action.context)!).map(([name, value]) => {
            const at = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
              ? `${path}.context.${name}`
              : `${path}.context[${JSON.stringify(name)}]`;
            return [name, mapBinding(value, at, visit)];
          }),
        );
      }
      mapKeyList(action, "requireValid", path, visit);
      break;
    case "toggle":
    case "increment":
    case "decrement":
      mapField(action, "key", path, "key", visit);
      break;
    case "setData":
    case "appendData":
      mapField(action, "path", path, "dataPath", visit);
      if (action.value !== undefined) {
        action.value = mapBinding(action.value, `${path}.value`, visit);
      }
      break;
    case "removeData":
      mapField(action, "path", path, "dataPath", visit);
      break;
    default:
      break;
  }
  return action;
}

function mapActions(data: Raw, path: string, visit: FieldVisitor): void {
  for (const field of ["onTap", "onLongPress", "onDoubleTap"]) {
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
  for (const field of ["stateKey", "activeKey", "hourKey", "minuteKey"]) {
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
export function mapBindableFields(node: Raw, path: string, visit: FieldVisitor): Raw {
  const copy = { ...node };
  if (copy.type === "text") {
    mapField(copy, "text", path, "text", visit);
    mapList(copy, "spans", path, (span, spanPath) => {
      mapField(span, "text", spanPath, "text", visit);
      mapActions(span, spanPath, visit);
      return span;
    });
  }
  const component = typeof copy.type === "string" ? COMPONENT_FIELDS[copy.type] : undefined;
  component?.(copy, path, visit);
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
  mapObject(copy, "refresh", path, (entry, entryPath) => {
    mapList(entry, "onRefresh", entryPath, (action, actionPath) =>
      mapAction(action, actionPath, visit),
    );
    return entry;
  });
  mapNodeKeys(copy, path, visit);
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
  for (const field of ["key", "stateKey", "activeKey", "hourKey", "minuteKey"]) {
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

import { prototypeContractPatterns } from "./prototypeContractPatterns";
import { prototypeNodeChildren, prototypeSpecNodeRoots } from "./prototypeNodeChildren";
import contract from "../../../schemas/prototype-spec-contract.json";
import {
  PROTOTYPE_DATA_MODEL_CAPABILITY,
  PROTOTYPE_MENUS_CAPABILITY,
} from "../observe/android/ctrlProxyProtocol";
import { mapBindableFields, record, renderScalar, STATE_KEY, type Raw } from "./prototypeTemplate";
import { expandPrototypeComponents } from "./prototypeComponents";

/** RFC 6901 pointers relative to data; the whole-document empty pointer is excluded. */
export function isPrototypeDataPointer(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= contract.limits.MAX_PROTOTYPE_DATA_POINTER_LENGTH &&
    prototypeContractPatterns.pointer.test(value)
  );
}

/**
 * A data action or write path is `/data` followed by a non-empty data pointer; the remainder is
 * checked by {@link isPrototypeDataPointer}, so `/data` alone (the whole document) is refused.
 */
export function prototypeDataPathPointer(path: unknown): string | undefined {
  if (typeof path !== "string" || !path.startsWith("/data/")) {
    return undefined;
  }
  const pointer = path.slice("/data".length);
  return isPrototypeDataPointer(pointer) ? pointer : undefined;
}

export function prototypeDataPointerTokens(pointer: string): string[] {
  return isPrototypeDataPointer(pointer)
    ? pointer
        .slice(1)
        .split("/")
        .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"))
    : [];
}

/** Missing (including an invalid pointer) is undefined; never follows inherited object members. */
export function resolvePrototypeDataPointer(data: unknown, pointer: string): unknown {
  if (!isPrototypeDataPointer(pointer)) {
    return undefined;
  }
  let value = data;
  for (const token of prototypeDataPointerTokens(pointer)) {
    if (Array.isArray(value)) {
      value =
        /^(?:0|[1-9][0-9]*)$/.test(token) && Number(token) < value.length
          ? value[Number(token)]
          : undefined;
    } else {
      const object = record(value);
      value = object && Object.hasOwn(object, token) ? object[token] : undefined;
    }
  }
  return value;
}

/** Plain scan: malformed or unrelated braces stay literal and cannot invalidate text. */
function* dataPlaceholderSpans(
  text: string,
  prefix = "data:",
): Generator<{ pointer: string; start: number; end: number }> {
  let cursor = 0;
  while (cursor < text.length) {
    if (text[cursor] !== "{" || !text.startsWith(prefix, cursor + 1)) {
      cursor++;
      continue;
    }
    const end = Math.min(
      text.length,
      cursor + 2 + prefix.length + contract.limits.MAX_PROTOTYPE_DATA_POINTER_LENGTH,
    );
    let close = cursor + 1;
    while (close < end && text[close] !== "}") {
      close++;
    }
    const inner = close === end ? "" : text.slice(cursor + 1, close);
    const pointer = inner.startsWith(prefix) ? inner.slice(prefix.length) : "";
    if (isPrototypeDataPointer(pointer)) {
      yield { pointer, start: cursor, end: close + 1 };
      cursor = close + 1;
    } else {
      cursor++;
    }
  }
}

/** Recognised pointers in authored order, using the same scan as text substitution. */
export function prototypeDataPlaceholders(text: string): string[] {
  return Array.from(dataPlaceholderSpans(text), ({ pointer }) => pointer);
}

/** `{platform:/pointer}` placeholders (#14294), scanned exactly as `{data:/pointer}` ones. */
export function prototypePlatformPlaceholders(text: string): string[] {
  return Array.from(dataPlaceholderSpans(text, "platform:"), ({ pointer }) => pointer);
}

/** Replacements are inserted once and never scanned again for data placeholders. */
export function bindPrototypeDataText(text: string, resolve: (pointer: string) => string): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const span of dataPlaceholderSpans(text)) {
    parts.push(text.slice(cursor, span.start), resolve(span.pointer));
    cursor = span.end;
  }
  return cursor === 0 ? text : parts.join("") + text.slice(cursor);
}

function projectableMember(key: string, member: unknown): boolean {
  return (
    STATE_KEY.test(key) &&
    (typeof member === "string" ||
      typeof member === "boolean" ||
      (typeof member === "number" && Number.isFinite(member)))
  );
}

/** Repeat templates see only named finite scalars; other content remains in the data object. */
export function projectPrototypeDataItem(value: Raw): Raw {
  return Object.fromEntries(
    Object.entries(value).filter(([key, member]) => projectableMember(key, member)),
  );
}

/** One validation's pointer cache, shared by source, template, expansion and state checks. */
export class PrototypeRepeatData {
  private readonly renderings = new Map<string, string>();
  private readonly sources = new Map<string, unknown>();
  private readonly counts = new Map<string, number>();
  private readonly projections = new Map<string, readonly Readonly<Raw>[]>();

  constructor(private readonly data: unknown) {}

  source(pointer: string): unknown {
    if (!this.sources.has(pointer)) {
      this.sources.set(pointer, resolvePrototypeDataPointer(this.data, pointer));
    }
    return this.sources.get(pointer);
  }

  rendered(pointer: string): string {
    const cached = this.renderings.get(pointer);
    if (cached !== undefined) {
      return cached;
    }
    const value = this.source(pointer);
    const rendered =
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
        ? renderScalar(value)
        : "";
    this.renderings.set(pointer, rendered);
    return rendered;
  }

  /** Undefined signals an oversized substitution; never construct that resolved string. */
  text(text: string, charge: (length: number) => boolean): string | undefined {
    let recognized = false;
    let length = 0;
    for (const { pointer } of dataPlaceholderSpans(text)) {
      recognized = true;
      length += this.rendered(pointer).length;
      if (length > contract.limits.MAX_PROTOTYPE_SUBSTITUTED_TEXT_LENGTH) {
        return undefined;
      }
    }
    if (!recognized) {
      return text;
    }
    if (!charge(text.length + length)) {
      return undefined;
    }
    return bindPrototypeDataText(text, (pointer) => this.rendered(pointer));
  }

  cells(pointer: string): number {
    const cached = this.counts.get(pointer);
    if (cached !== undefined) {
      return cached;
    }
    const source = this.source(pointer);
    const objects = Array.isArray(source)
      ? source.filter((item) => record(item) !== undefined)
      : [];
    const maximum =
      contract.definitions.repeat.fields.items.rule.options.find(
        (option) => option.kind === "array",
      )?.max ?? Infinity;
    let cells = 0;
    for (const item of objects.slice(0, maximum)) {
      let members = 0;
      for (const [key, value] of Object.entries(item)) {
        if (projectableMember(key, value)) {
          members++;
        }
      }
      cells += Math.max(1, members);
    }
    this.counts.set(pointer, cells);
    return cells;
  }

  items(pointer: string): readonly Readonly<Raw>[] {
    const cached = this.projections.get(pointer);
    if (cached) {
      return cached;
    }
    const source = this.source(pointer);
    const objects = Array.isArray(source)
      ? source.filter((item): item is Raw => record(item) !== undefined)
      : [];
    const projected = Object.freeze(
      objects.map((item) => Object.freeze(projectPrototypeDataItem(item))),
    );
    this.projections.set(pointer, projected);
    return projected;
  }
}

function conditionFields(value: unknown, path: string, fields: Set<string>): void {
  const condition = record(value);
  if (!condition) {
    return;
  }
  if (Object.hasOwn(condition, "data")) {
    fields.add(`${path}.data`);
  }
  conditionFields(condition.not, `${path}.not`, fields);
  for (const form of ["all", "any"]) {
    const children = condition[form];
    if (Array.isArray(children)) {
      children.forEach((child, index) =>
        conditionFields(child, `${path}.${form}[${index}]`, fields),
      );
    }
  }
}

function usesAtNode(node: Raw, path: string): Set<string> {
  const fields = new Set<string>();
  const repeat = record(node.repeat);
  if (record(repeat?.items)) {
    fields.add(`${path}.repeat.items`);
  }
  if (repeat && Object.hasOwn(repeat, "key")) {
    fields.add(`${path}.repeat.key`);
  }
  mapBindableFields(node, path, (value, fieldPath, kind) => {
    if (kind === "emitBinding" && typeof record(value)?.data === "string") {
      fields.add(fieldPath);
    }
    if (kind === "text" && typeof value === "string" && prototypeDataPlaceholders(value).length) {
      fields.add(fieldPath);
    }
    return value;
  });
  conditionFields(node.enabledWhen, `${path}.enabledWhen`, fields);
  conditionFields(node.visibleWhen, `${path}.visibleWhen`, fields);
  if (Array.isArray(node.styleWhen)) {
    node.styleWhen.forEach((entry, index) =>
      conditionFields(record(entry)?.when, `${path}.styleWhen[${index}].when`, fields),
    );
  }
  return fields;
}

function nodeFields(value: unknown, path: string): string[] {
  const result: string[] = [];
  const pending: ({ node: unknown; path: string } | { field: string })[] = [{ node: value, path }];
  while (pending.length) {
    const task = pending.pop()!;
    if ("field" in task) {
      result.push(task.field);
      continue;
    }
    const { path } = task;
    const node = record(task.node);
    if (!node) {
      continue;
    }
    const fields = usesAtNode(node, path);
    const children = prototypeNodeChildren(node);
    const next: typeof pending = [];
    for (const [key, child] of Object.entries(node)) {
      if (["child", "children", "screens"].includes(key)) {
        next.push(
          ...children
            .filter((entry) => entry.suffix === `.${key}` || entry.suffix.startsWith(`.${key}[`))
            .map((entry) => ({ node: entry.value, path: `${path}${entry.suffix}` })),
        );
      } else {
        next.push(...documentFields(child, `${path}.${key}`, fields).map((field) => ({ field })));
      }
    }
    pending.push(...next.reverse());
  }
  return result;
}

/** Selects usage paths in authored field order, with child nodes visited depth-first. */
function documentFields(value: unknown, path: string, fields: Set<string>): string[] {
  if (fields.has(path)) {
    return [path];
  }
  if (Array.isArray(value)) {
    return value.flatMap((child, index) => documentFields(child, `${path}[${index}]`, fields));
  }
  const object = record(value);
  if (!object) {
    return [];
  }
  const own = fields;
  return Object.entries(object).flatMap(([key, child]) =>
    documentFields(child, `${path}.${key}`, own),
  );
}

export function prototypeDataModelFields(spec: unknown): string[] {
  const expansion = expandPrototypeComponents(spec);
  const object = record(expansion.success ? expansion.spec : spec);
  if (!object) {
    return [];
  }
  const fields = [
    ...(Object.hasOwn(object, "data") ? ["data"] : []),
    ...prototypeSpecNodeRoots(object).flatMap(({ node, path }) => nodeFields(node, path)),
  ];
  const definitions =
    expansion.success && expansion.expanded
      ? prototypeSpecNodeRoots(spec)
          .filter(({ path }) => path !== "root")
          .flatMap(({ node, path }) => nodeFields(node, path))
      : [];
  // Retain device paths for existing expanded uses; append previously unvisited definitions.
  return [
    ...fields,
    ...definitions.filter(
      (field) =>
        !fields.some((at) => expansion.success && expansion.locate(at).endsWith(` → ${field}`)),
    ),
  ];
}

export function prototypeDataModelUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  const more = fields.length > 1 ? ` (and ${fields.length - 1} more)` : "";
  const device = platform === "ios" ? "connected iOS prototype agent" : "connected CtrlProxy";
  const update =
    platform === "ios"
      ? "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version"
      : "Update the connected CtrlProxy";
  return `The ${device} does not advertise ${PROTOTYPE_DATA_MODEL_CAPABILITY}, so it cannot resolve the data binding at ${fields[0]}${more}: a top-level data object, repeat.items {path}, repeat.key, {data: pointer} conditions and {data:/pointer} text placeholders. Nothing was shown. ${update}, or inline the content as literal repeat.items, state keys and literal text.`;
}

/** Only node positions count: opaque action payloads may also contain a type field. */
export function prototypeMenuFields(spec: unknown): string[] {
  const fields: string[] = [];
  const pending = prototypeSpecNodeRoots(spec).reverse();
  while (pending.length) {
    const { node: value, path } = pending.pop()!;
    const node = record(value);
    if (!node) {
      continue;
    }
    if (node.type === "menu" || node.type === "select") {
      fields.push(path);
    }
    // Preserve the existing child-before-children order on mixed containers too.
    const children = prototypeNodeChildren(node).sort(
      (left, right) => Number(right.suffix === ".child") - Number(left.suffix === ".child"),
    );
    for (const child of children.reverse()) {
      pending.push({ node: child.value, path: `${path}${child.suffix}` });
    }
  }
  return fields;
}

export function prototypeMenusUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  const more = fields.length > 1 ? ` (and ${fields.length - 1} more)` : "";
  const device = platform === "ios" ? "connected iOS prototype agent" : "connected CtrlProxy";
  const update =
    platform === "ios"
      ? "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version"
      : "Update the connected CtrlProxy";
  return `The ${device} does not advertise ${PROTOTYPE_MENUS_CAPABILITY}, so it cannot render the menu or select at ${fields[0]}${more}. Nothing was shown. ${update}, or replace menu/select with buttons and radioGroup.`;
}

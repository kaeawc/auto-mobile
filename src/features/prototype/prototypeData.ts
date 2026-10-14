import contract from "../../../schemas/prototype-spec-contract.json";
import { PROTOTYPE_DATA_MODEL_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import { mapBindableFields, record, STATE_KEY, type Raw } from "./prototypeTemplate";

/** RFC 6901 pointers relative to data; the whole-document empty pointer is excluded. */
export function isPrototypeDataPointer(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= contract.limits.MAX_PROTOTYPE_DATA_POINTER_LENGTH &&
    /^(?:\/(?:[^~\/]|~[01])*)+$/.test(value)
  );
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
export function prototypeDataPlaceholders(text: string): string[] {
  const pointers: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    if (text[cursor] !== "{" || !text.startsWith("data:", cursor + 1)) {
      cursor++;
      continue;
    }
    const end = Math.min(
      text.length,
      cursor + 2 + 5 + contract.limits.MAX_PROTOTYPE_DATA_POINTER_LENGTH,
    );
    let close = cursor + 1;
    while (close < end && text[close] !== "}") {
      close++;
    }
    const inner = close === end ? "" : text.slice(cursor + 1, close);
    const pointer = inner.startsWith("data:") ? inner.slice(5) : "";
    if (isPrototypeDataPointer(pointer)) {
      pointers.push(pointer);
      cursor = close + 1;
    } else {
      cursor++;
    }
  }
  return pointers;
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
    if (kind === "text" && typeof value === "string" && prototypeDataPlaceholders(value).length) {
      fields.add(fieldPath);
    }
    return value;
  });
  conditionFields(node.visibleWhen, `${path}.visibleWhen`, fields);
  if (Array.isArray(node.styleWhen)) {
    node.styleWhen.forEach((entry, index) =>
      conditionFields(record(entry)?.when, `${path}.styleWhen[${index}].when`, fields),
    );
  }
  return fields;
}

function nodeFields(value: unknown, path: string): string[] {
  const node = record(value);
  if (!node) {
    return [];
  }
  const fields = usesAtNode(node, path);
  return Object.entries(node).flatMap(([key, child]) => {
    if (key === "child") {
      return nodeFields(child, `${path}.child`);
    }
    if (key === "children" && Array.isArray(child)) {
      return child.flatMap((entry, index) => nodeFields(entry, `${path}.children[${index}]`));
    }
    return documentFields(child, `${path}.${key}`, fields);
  });
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
  const object = record(spec);
  return object
    ? [...(Object.hasOwn(object, "data") ? ["data"] : []), ...nodeFields(object.root, "root")]
    : [];
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

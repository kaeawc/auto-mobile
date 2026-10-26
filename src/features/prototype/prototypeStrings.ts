import {
  PROTOTYPE_STRINGS_CAPABILITY,
  PROTOTYPE_SEMANTICS_CAPABILITY,
} from "../observe/android/ctrlProxyProtocol";
import contract from "../../../schemas/prototype-spec-contract.json";
import { prototypeContractPatterns as patterns } from "./prototypeContractPatterns";
import { isPrototypeDataPointer, resolvePrototypeDataPointer } from "./prototypeData";
import { record } from "./prototypeTemplate";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
import type { Located, PrototypeValidationError } from "./prototypeBindingValidation";

export type PrototypeStrings = Record<string, Record<string, string | Record<string, string>>>;
type Category = "zero" | "one" | "two" | "few" | "many" | "other";
const categories = new Set(["zero", "one", "two", "few", "many", "other"]);
const opaque = new Set(contract.stringOpaqueFields);
const display = new Set(contract.stringFields);
const error = (path: string, message: string): PrototypeValidationError => ({ path, message });

export function prototypeStringsTableError(value: unknown): PrototypeValidationError | undefined {
  const tables = record(value);
  if (!tables) {
    return error("strings", "Expected string tables");
  }
  if (!Object.hasOwn(tables, "default")) {
    return error("strings", "Missing default string table");
  }
  if (Object.keys(tables).length > contract.limits.MAX_PROTOTYPE_STRING_LOCALES) {
    return error("strings", "String locale limit exceeded");
  }
  const seen = new Set<string>();
  for (const [tag, table] of Object.entries(tables)) {
    const path = `strings.${tag}`;
    if (tag !== "default" && !patterns.localeTag.test(tag)) {
      return error(path, "Invalid locale tag");
    }
    const normalized = tag.toLowerCase().replaceAll("_", "-");
    if (seen.has(normalized)) {
      return error(path, "Duplicate locale tag");
    }
    seen.add(normalized);
    const tableError = stringTableError(table, path);
    if (tableError) {
      return tableError;
    }
  }
  return undefined;
}

function translationValueError(
  text: unknown,
  plural: boolean,
  path: string,
): PrototypeValidationError | undefined {
  if (
    typeof text !== "string" ||
    text.length === 0 ||
    text.length > contract.limits.MAX_PROTOTYPE_STRING_LENGTH
  ) {
    return error(path, "Invalid translation string");
  }
  if (
    ["{t:", "{data:", "{platform:"].some((token) => text.includes(token)) ||
    (!plural && text.includes("{#}"))
  ) {
    return error(path, "Forbidden translation placeholder");
  }
  return undefined;
}
function stringEntryError(entry: unknown, path: string): PrototypeValidationError | undefined {
  const plural = record(entry);
  if (
    typeof entry !== "string" &&
    (!plural ||
      !Object.hasOwn(plural, "other") ||
      Object.keys(plural).some((key) => !categories.has(key)))
  ) {
    return error(path, "Invalid plural object");
  }
  for (const text of plural ? Object.values(plural) : [entry]) {
    const result = translationValueError(text, plural !== undefined, path);
    if (result) {
      return result;
    }
  }
  return undefined;
}
function stringTableError(table: unknown, path: string): PrototypeValidationError | undefined {
  const entries = record(table);
  if (!entries) {
    return error(path, "Expected string table");
  }
  if (Object.keys(entries).length > contract.limits.MAX_PROTOTYPE_STRING_KEYS) {
    return error(path, "String key limit exceeded");
  }
  for (const [key, entry] of Object.entries(entries)) {
    const at = `${path}.${key}`;
    if (!patterns.stringKey.test(key)) {
      return error(at, "Invalid string key");
    }
    const result = stringEntryError(entry, at);
    if (result) {
      return result;
    }
  }
  return undefined;
}

interface Translation {
  start: number;
  end: number;
  key: string;
  count?: string;
}
// Resolution also accepts invalid counts emitted by an earlier data substitution pass;
// authored placeholders still require the strict count grammar.
function translations(text: string, strict = true): Translation[] | undefined {
  const result: Translation[] = [];
  let cursor = 0;
  while ((cursor = text.indexOf("{t:", cursor)) !== -1) {
    const match = /^\{t:([A-Za-z_][A-Za-z0-9_.-]{0,63})(?:\|(\{data:[^{}]+\}|[^{}]*))?\}/.exec(
      text.slice(cursor),
    );
    if (
      !match ||
      (match[2]?.startsWith("{data:") && !isPrototypeDataPointer(match[2].slice(6, -1)))
    ) {
      return undefined;
    }
    if (
      strict &&
      match[2] !== undefined &&
      !match[2].startsWith("{data:") &&
      !/^[0-9]{1,9}$/.test(match[2])
    ) {
      return undefined;
    }
    result.push({ start: cursor, end: cursor + match[0].length, key: match[1]!, count: match[2] });
    cursor += match[0].length;
  }
  return result;
}

function textFields(spec: unknown): { path: string; text: string; contentDescription: boolean }[] {
  const fields: { path: string; text: string; contentDescription: boolean }[] = [];
  function scan(value: unknown, path: string, parent = ""): void {
    if (Array.isArray(value)) {
      value.forEach((child, i) => scan(child, `${path}[${i}]`, parent));
      return;
    }
    const object = record(value);
    if (!object) {
      return;
    }
    for (const [key, child] of Object.entries(object)) {
      if (opaque.has(key) || ["child", "children", "screens"].includes(key)) {
        continue;
      }
      const at = `${path}.${key}`;
      if (
        typeof child === "string" &&
        (display.has(key) || display.has(`${parent}.${key}`) || key === "contentDescription")
      ) {
        fields.push({ path: at, text: child, contentDescription: key === "contentDescription" });
      } else {
        scan(child, at, key);
      }
    }
  }
  walkPrototypeNodes(spec, (node, path) => scan(node, path));
  return fields;
}

export function prototypeStringsError(
  spec: unknown,
  nodes: readonly Located[],
): PrototypeValidationError | undefined {
  const tables = record(record(spec)?.strings);
  const defaults = record(tables?.default);
  for (const { value, path } of nodes) {
    const semantics = record(value.semantics);
    if (semantics && Object.keys(semantics).length === 0) {
      return error(`${path}.semantics`, "Expected at least one semantics field");
    }
    if (semantics?.label !== undefined && value.contentDescription !== undefined) {
      return error(`${path}.semantics.label`, "semantics.label conflicts with contentDescription");
    }
  }
  for (const field of textFields(spec)) {
    if (!field.text.includes("{t:")) {
      continue;
    }
    const result = stringFieldError(field, tables, defaults);
    if (result) {
      return result;
    }
  }
  return undefined;
}

function stringFieldError(
  field: { path: string; text: string; contentDescription: boolean },
  tables: Record<string, unknown> | undefined,
  defaults: Record<string, unknown> | undefined,
): PrototypeValidationError | undefined {
  if (field.contentDescription) {
    return error(field.path, "Use semantics.label for string placeholders");
  }
  if (!tables) {
    return error(field.path, "String placeholders require strings");
  }
  const uses = translations(field.text);
  if (!uses) {
    return error(field.path, "Invalid string placeholder");
  }
  for (const use of uses) {
    if (!defaults || !Object.hasOwn(defaults, use.key)) {
      return error(field.path, `Unknown string key "${use.key}"`);
    }
    if (typeof defaults[use.key] !== "string" && use.count === undefined) {
      return error(field.path, `String "${use.key}" is plural: write {t:${use.key}|count}`);
    }
  }
  return undefined;
}

export function prototypeLocaleChain(requested: readonly string[]): string[] {
  const chain = new Set<string>();
  for (const tag of requested) {
    const parts = tag.toLowerCase().replaceAll("_", "-").split("-");
    while (parts.length) {
      const prefix = parts.join("-");
      if (prefix !== "default") {
        chain.add(prefix);
      }
      parts.pop();
    }
  }
  return [...chain, "default"];
}

/** Integer cardinal rules; million-multiple Romance `many` is intentionally outside v1. */
export function prototypePluralCategory(language: string, n: number): Category {
  if (!Number.isSafeInteger(n) || n < 0) {
    return "other";
  }
  const lang = language.toLowerCase().split(/[-_]/)[0]!;
  if ("ja zh ko vi th id ms lo km my".split(" ").includes(lang)) {
    return "other";
  }
  if ("fr pt hi bn fa gu kn am".split(" ").includes(lang)) {
    return n <= 1 ? "one" : "other";
  }
  if (["ru", "uk", "be", "pl"].includes(lang)) {
    return slavicCategory(lang, n);
  }
  if (["cs", "sk"].includes(lang)) {
    return czechCategory(n);
  }
  if (lang === "ar") {
    return arabicCategory(n);
  }
  return n === 1 ? "one" : "other";
}
function czechCategory(n: number): Category {
  return n === 1 ? "one" : n >= 2 && n <= 4 ? "few" : "other";
}
function slavicCategory(language: string, n: number): Category {
  const mod10 = n % 10,
    mod100 = n % 100;
  if (language === "pl" ? n === 1 : mod10 === 1 && mod100 !== 11) {
    return "one";
  }
  return mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14) ? "few" : "many";
}
function arabicCategory(n: number): Category {
  const mod100 = n % 100;
  if (n <= 2) {
    return (["zero", "one", "two"] as const)[n]!;
  }
  if (mod100 >= 3 && mod100 <= 10) {
    return "few";
  }
  return mod100 >= 11 && mod100 <= 99 ? "many" : "other";
}
const COUNT_TEXT = /^[0-9]{1,9}$/;
const MAX_COUNT = 999_999_999;
/**
 * A count is a whole number 0..999999999: a literal or substituted digit string, or a data number
 * that is whole and in range. Anything else selects `other`, so resolving the data pointer directly
 * and resolving after the data pass substituted its text give the same result.
 */
function translationCount(value: string | undefined, data: unknown): number | undefined {
  if (value?.startsWith("{data:")) {
    const raw = resolvePrototypeDataPointer(data, value.slice(6, -1));
    if (typeof raw === "number") {
      return Number.isInteger(raw) && raw >= 0 && raw <= MAX_COUNT ? raw : undefined;
    }
    return typeof raw === "string" && COUNT_TEXT.test(raw) ? Number(raw) : undefined;
  }
  return value !== undefined && COUNT_TEXT.test(value) ? Number(value) : undefined;
}
function resolveEntry(
  entry: string | Record<string, string> | undefined,
  key: string,
  language: string,
  count: number | undefined,
): string {
  const category = count === undefined ? "other" : prototypePluralCategory(language, count);
  const text = typeof entry === "string" ? entry : (entry?.[category] ?? entry?.other ?? key);
  return count === undefined ? text : text.replaceAll("{#}", String(count));
}

export function resolvePrototypeStringsText(
  strings: PrototypeStrings,
  locales: readonly string[],
  text: string,
  data?: unknown,
): string {
  const uses = translations(text, false);
  if (!uses) {
    return text;
  }
  const tables = new Map(
    Object.entries(strings).map(([tag, table]) => [tag.toLowerCase().replaceAll("_", "-"), table]),
  );
  const chain = prototypeLocaleChain(locales);
  let result = "",
    cursor = 0;
  for (const use of uses) {
    const tag = chain.find((tag) => Object.hasOwn(tables.get(tag) ?? {}, use.key));
    const entry = tag ? tables.get(tag)?.[use.key] : undefined;
    const count = translationCount(use.count, data);
    const language = tag === "default" ? (locales[0] ?? "en") : (tag ?? "en");
    const translated = resolveEntry(entry, use.key, language, count);
    result += text.slice(cursor, use.start) + translated;
    cursor = use.end;
  }
  return result + text.slice(cursor);
}

export function resolvePrototypeStrings<T>(spec: T, locales: readonly string[]): T {
  const source = record(spec);
  const strings = source?.strings as PrototypeStrings | undefined;
  if (!strings) {
    return spec;
  }
  function transform(value: unknown, parent = ""): unknown {
    if (Array.isArray(value)) {
      return value.map((entry) => transform(entry, parent));
    }
    const object = record(value);
    if (!object) {
      return value;
    }
    return Object.fromEntries(
      Object.entries(object).map(([key, child]) => [
        key,
        opaque.has(key)
          ? child
          : typeof child === "string" && (display.has(key) || display.has(`${parent}.${key}`))
            ? resolvePrototypeStringsText(strings!, locales, child, source?.data)
            : transform(child, key),
      ]),
    );
  }
  return transform(spec) as T;
}

export function prototypeStringsFields(spec: unknown): string[] {
  return [
    ...(record(spec)?.strings !== undefined ? ["strings"] : []),
    ...textFields(spec)
      .filter(({ text }) => text.includes("{t:"))
      .map(({ path }) => path),
  ];
}
export function prototypeSemanticsFields(spec: unknown): string[] {
  const fields: string[] = [];
  walkPrototypeNodes(spec, (node, path) => {
    if (node.semantics !== undefined) {
      fields.push(`${path}.semantics`);
    }
  });
  return fields;
}
function unsupported(
  fields: readonly string[],
  platform: "android" | "ios",
  capability: string,
): string {
  const device = platform === "ios" ? "connected iOS prototype agent" : "connected CtrlProxy";
  const update =
    platform === "ios"
      ? "Relaunch the app with launchApp prototype: true"
      : "Update the connected CtrlProxy";
  return `The ${device} does not advertise ${capability}, so it cannot evaluate ${fields[0]}${fields.length > 1 ? ` (and ${fields.length - 1} more)` : ""}. Nothing was shown. ${update}, or remove the unsupported fields.`;
}
export const prototypeStringsUnsupportedMessage = (
  fields: readonly string[],
  platform: "android" | "ios",
): string => unsupported(fields, platform, PROTOTYPE_STRINGS_CAPABILITY);
export const prototypeSemanticsUnsupportedMessage = (
  fields: readonly string[],
  platform: "android" | "ios",
): string => unsupported(fields, platform, PROTOTYPE_SEMANTICS_CAPABILITY);

/** Required integer forms from the same hand rules used at resolution time; other is always required. */
export function prototypeRequiredPluralCategories(language: string): Category[] {
  return [
    ...new Set<Category>([
      ...Array.from({ length: 121 }, (_, n) => prototypePluralCategory(language, n)),
      "other",
    ]),
  ];
}

/** Referenced keys that reach the final default table, once per key in field order. */
export function prototypeStringsFallbackKeys(spec: unknown, locale: string): string[] {
  const strings = record(record(spec)?.strings);
  if (!strings) {
    return [];
  }
  const tables = new Map(
    Object.entries(strings).map(([tag, table]) => [
      tag.toLowerCase().replaceAll("_", "-"),
      record(table),
    ]),
  );
  const chain = prototypeLocaleChain([locale]).filter((tag) => tag !== "default");
  const keys = textFields(spec).flatMap(({ text }) =>
    (translations(text) ?? []).map((use) => use.key),
  );
  return [...new Set(keys)].filter(
    (key) => !chain.some((tag) => Object.hasOwn(tables.get(tag) ?? {}, key)),
  );
}

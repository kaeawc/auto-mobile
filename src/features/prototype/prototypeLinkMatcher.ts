import { isUtf8 } from "node:buffer";

/** Standalone matcher input; deliberately independent of the prototype spec/runtime. */
export interface PrototypeLinkEntry {
  path: string;
  query?: Readonly<Record<string, string>>;
  usedCaptures?: ReadonlySet<string>;
}

export interface PrototypeLinkMatch {
  entryIndex: number;
  captures: Record<string, string>;
  query: Record<string, string | number | boolean>;
}

export type PrototypeLinkErrorCode =
  | "tooManyEntries"
  | "badPattern"
  | "duplicateCapture"
  | "badQuery"
  | "duplicatePattern"
  | "unusedCapture";

export interface PrototypeLinkTableError {
  index: number;
  code: PrototypeLinkErrorCode;
  message: string;
}

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const LITERAL = /^[A-Za-z0-9._~-]+$/;
const TYPE = /^(string|int|number|boolean)\??$/;
const INTEGER = /^-?[0-9]+$/;
// Decimal fractions and exponents are accepted; whitespace and non-decimal forms are not.
const DECIMAL = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;

function captureName(segment: string): string | undefined {
  return segment.startsWith("{") && segment.endsWith("}") && NAME.test(segment.slice(1, -1))
    ? segment.slice(1, -1)
    : undefined;
}

function patternSegments(path: string): string[] | undefined {
  if (path === "/") {
    return [];
  }
  if (!path.startsWith("/")) {
    return undefined;
  }
  const segments = path.slice(1).split("/");
  return segments.every((part) => LITERAL.test(part) || captureName(part) !== undefined)
    ? segments
    : undefined;
}

function queryValid(entry: PrototypeLinkEntry, captures: ReadonlySet<string>): boolean {
  return Object.entries(entry.query ?? {}).every(
    ([name, type]) => NAME.test(name) && !captures.has(name) && TYPE.test(type),
  );
}

function entryErrors(entry: PrototypeLinkEntry): Omit<PrototypeLinkTableError, "index">[] {
  const segments = patternSegments(entry.path);
  if (!segments) {
    return [{ code: "badPattern", message: "Invalid link path pattern" }];
  }
  const errors: Omit<PrototypeLinkTableError, "index">[] = [];
  const captures = new Set<string>();
  for (const segment of segments) {
    const name = captureName(segment);
    if (name === undefined) {
      continue;
    }
    if (captures.has(name)) {
      errors.push({ code: "duplicateCapture", message: `Duplicate capture: ${name}` });
    }
    captures.add(name);
    if (entry.usedCaptures !== undefined && !entry.usedCaptures.has(name)) {
      errors.push({ code: "unusedCapture", message: `Unused capture: ${name}` });
    }
  }
  for (const name of Object.keys(entry.query ?? {}).sort()) {
    if (!NAME.test(name) || captures.has(name) || !TYPE.test(entry.query![name]!)) {
      errors.push({ code: "badQuery", message: `Invalid query declaration: ${name}` });
    }
  }
  return errors;
}

/** All errors in entry order. The table limit is reported once at index 32. */
export function validateLinkTable(
  entries: readonly PrototypeLinkEntry[],
): PrototypeLinkTableError[] {
  const errors: PrototypeLinkTableError[] = [];
  const shapes = new Set<string>();
  entries.forEach((entry, index) => {
    if (index === 32) {
      errors.push({
        index,
        code: "tooManyEntries",
        message: "At most 32 link entries are allowed",
      });
    }
    errors.push(...entryErrors(entry).map((error) => ({ index, ...error })));
    const segments = patternSegments(entry.path);
    if (segments === undefined) {
      return;
    }
    const shape = segments.map((part) => (captureName(part) === undefined ? part : "{}")).join("/");
    if (shapes.has(shape)) {
      errors.push({ index, code: "duplicatePattern", message: "Duplicate link pattern shape" });
    }
    shapes.add(shape);
  });
  return errors;
}

/** Decode bytes strictly without throwing or consulting platform URL normalization. */
function decode(text: string, plus: boolean): string | undefined {
  const source = Buffer.from(text, "utf8");
  const bytes: number[] = [];
  for (let at = 0; at < source.length; at++) {
    const byte = source[at]!;
    if (byte === 37) {
      const hex = source.subarray(at + 1, at + 3).toString("utf8");
      if (hex.length !== 2 || !/^[0-9a-fA-F]{2}$/.test(hex)) {
        return undefined;
      }
      bytes.push(Number.parseInt(hex, 16));
      at += 2;
    } else {
      bytes.push(plus && byte === 43 ? 32 : byte);
    }
  }
  const buffer = Buffer.from(bytes);
  return isUtf8(buffer) ? buffer.toString("utf8") : undefined;
}

function customSchemePath(rawPath: string): string | undefined {
  const slash = rawPath.indexOf("/");
  const authority = slash < 0 ? rawPath : rawPath.slice(0, slash);
  let host = authority.slice(authority.lastIndexOf("@") + 1);
  const colon = host.lastIndexOf(":");
  const port = host.slice(colon + 1);
  if (colon >= 0 && port.length > 0 && [...port].every((digit) => digit >= "0" && digit <= "9")) {
    host = host.slice(0, colon);
  }
  if (authority !== "" && host === "") {
    return undefined;
  }
  return host + (slash < 0 ? "" : rawPath.slice(slash));
}

function pathSegments(rawPath: string, scheme: string): string[] | undefined {
  let path = rawPath;
  if (scheme === "http" || scheme === "https") {
    const slash = path.indexOf("/");
    path = slash < 0 ? "" : path.slice(slash);
  } else {
    const customPath = customSchemePath(path);
    if (customPath === undefined) {
      return undefined;
    }
    path = customPath;
  }
  if (path.startsWith("/")) {
    path = path.slice(1);
  }
  if (path.endsWith("/")) {
    path = path.slice(0, -1);
  }
  const segments = path === "" ? [] : path.split("/");
  // A second slash at root must not collapse into an empty/root path.
  if (segments.some((part) => part === "") || rawPath.endsWith("//")) {
    return undefined;
  }
  const decoded = segments.map((part) => decode(part, false));
  if (decoded.some((part) => part === undefined || part === "")) {
    return undefined;
  }
  return decoded as string[];
}

function urlParts(url: string): { segments: string[]; query: Map<string, string> } | undefined {
  const clean = url.split("#", 1)[0]!;
  const separator = clean.indexOf("://");
  if (separator <= 0) {
    return undefined;
  }
  const scheme = clean.slice(0, separator).toLowerCase();
  if (!/^[a-z][a-z0-9+.-]*$/.test(scheme)) {
    return undefined;
  }
  const rest = clean.slice(separator + 3);
  const question = rest.indexOf("?");
  const segments = pathSegments(question < 0 ? rest : rest.slice(0, question), scheme);
  if (segments === undefined) {
    return undefined;
  }
  return {
    segments,
    query: queryPairs(question < 0 ? "" : rest.slice(question + 1)),
  };
}

function queryPairs(text: string): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const pair of text.split("&")) {
    if (pair === "") {
      continue;
    }
    const equal = pair.indexOf("=");
    const key = decode(equal < 0 ? pair : pair.slice(0, equal), true);
    const value = decode(equal < 0 ? "" : pair.slice(equal + 1), true);
    if (key !== undefined && value !== undefined && !pairs.has(key)) {
      pairs.set(key, value);
    }
  }
  return pairs;
}

function queryValue(value: string, type: string): string | number | boolean | undefined {
  if (type === "string") {
    return value;
  }
  if (type === "boolean") {
    return value === "true" ? true : value === "false" ? false : undefined;
  }
  const number = Number(value);
  if (type === "int") {
    return INTEGER.test(value) && Number.isSafeInteger(number) ? number : undefined;
  }
  return type === "number" && DECIMAL.test(value) && Number.isFinite(number) ? number : undefined;
}

function matchQuery(
  declarations: Readonly<Record<string, string>>,
  values: ReadonlyMap<string, string>,
): Record<string, string | number | boolean> | undefined {
  const query = new Map<string, string | number | boolean>();
  for (const [name, declaration] of Object.entries(declarations)) {
    const value = values.get(name);
    if (value === undefined) {
      if (!declaration.endsWith("?")) {
        return undefined;
      }
      continue;
    }
    const parsed = queryValue(value, declaration.replace(/\?$/, ""));
    if (parsed === undefined) {
      return undefined;
    }
    query.set(name, parsed);
  }
  return Object.fromEntries(query);
}

function matchEntry(
  entry: PrototypeLinkEntry,
  parts: { segments: string[]; query: Map<string, string> },
  entryIndex: number,
): PrototypeLinkMatch | undefined {
  const pattern = patternSegments(entry.path);
  if (!pattern || pattern.length !== parts.segments.length) {
    return undefined;
  }
  const captures = new Map<string, string>();
  for (const [at, segment] of pattern.entries()) {
    const name = captureName(segment);
    if (name === undefined) {
      if (segment !== parts.segments[at]) {
        return undefined;
      }
    } else {
      if (captures.has(name)) {
        return undefined;
      }
      captures.set(name, parts.segments[at]!);
    }
  }
  if (!queryValid(entry, new Set(captures.keys()))) {
    return undefined;
  }
  const query = matchQuery(entry.query ?? {}, parts.query);
  return query === undefined
    ? undefined
    : { entryIndex, captures: Object.fromEntries(captures), query };
}

/** First matching entry, including query coercion; malformed URL paths never match. */
export function matchPrototypeLink(
  url: string,
  entries: readonly PrototypeLinkEntry[],
): PrototypeLinkMatch | undefined {
  const parts = urlParts(url);
  if (!parts) {
    return undefined;
  }
  for (const [index, entry] of entries.entries()) {
    const result = matchEntry(entry, parts, index);
    if (result) {
      return result;
    }
  }
  return undefined;
}

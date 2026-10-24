/**
 * Pseudo-localization for `show` (#14126): every authored display string is accented and padded by
 * about 40% so truncation and clipping show up without a real translation. The authored spec is
 * never changed; only the copy sent to the device is.
 */

import { prototypeLinkifyMatches, type PrototypeLinkifyKind } from "./prototypeLinkify";
import { record } from "./prototypeTemplate";

/** Spec fields that hold text a user reads. Identifiers, state keys and `contentDescription` stay. */
const DISPLAY_TEXT_FIELDS = new Set([
  "text",
  "label",
  "placeholder",
  "headline",
  "title",
  "supportingText",
  "supporting",
  "trailingText",
]);
/** Subtrees that hold data, bindings or styling, never authored copy. */
const OPAQUE_FIELDS = new Set([
  "context",
  "data",
  "state",
  "assets",
  "theme",
  "storage",
  "checks",
  "value",
  "repeat",
  "payload",
  "body",
  "headers",
  "query",
]);

export const PSEUDO_LOCALE_EXPANSION = 0.4;
const PAD = "~";

const ACCENTS: Record<string, string> = {
  a: "á",
  b: "ƀ",
  c: "ç",
  d: "ď",
  e: "é",
  f: "ƒ",
  g: "ğ",
  h: "ĥ",
  i: "í",
  j: "ĵ",
  k: "ķ",
  l: "ļ",
  m: "ɱ",
  n: "ñ",
  o: "ó",
  p: "þ",
  q: "ƣ",
  r: "ŕ",
  s: "š",
  t: "ť",
  u: "ú",
  v: "ṽ",
  w: "ŵ",
  x: "ẋ",
  y: "ý",
  z: "ž",
  A: "Á",
  B: "Ɓ",
  C: "Ç",
  D: "Ď",
  E: "É",
  F: "Ƒ",
  G: "Ğ",
  H: "Ĥ",
  I: "Í",
  J: "Ĵ",
  K: "Ķ",
  L: "Ļ",
  M: "Ṁ",
  N: "Ñ",
  O: "Ó",
  P: "Þ",
  Q: "Ǫ",
  R: "Ŕ",
  S: "Š",
  T: "Ť",
  U: "Ú",
  V: "Ṽ",
  W: "Ŵ",
  X: "Ẋ",
  Y: "Ý",
  Z: "Ž",
};

/** `{key}`, `{data:/pointer}` and `{item.field}` bindings are resolved by the device: left intact. */
const PLACEHOLDER = /\{[^{}]*\}/g;

/** Accents the letters of text; `{...}` bindings stay as written. */
function pseudoLocalizeSegment(text: string): string {
  const accented = text
    .split(PLACEHOLDER)
    .map((part) => [...part].map((char) => ACCENTS[char] ?? char).join(""));
  const placeholders = text.match(PLACEHOLDER) ?? [];
  return accented.map((part, index) => part + (placeholders[index] ?? "")).join("");
}

/** Accented, bracketed and padded to ~140% of the original length; placeholders are untouched. */
export function pseudoLocalizeText(text: string): string {
  if (text.trim() === "") {
    return text;
  }
  const padding = PAD.repeat(Math.ceil([...text].length * PSEUDO_LOCALE_EXPANSION));
  return `[${pseudoLocalizeSegment(text)}${padding}]`;
}

const LINKIFY_KINDS = new Set<unknown>(["mention", "hashtag", "url"]);
/** Maps keyed by an author-chosen name: the names are not spec fields, so only the values count. */
const NAME_KEYED_FIELDS = new Set(["screens", "components"]);

/**
 * Linkified text keeps its mention, hashtag and URL tokens as written, and has no bracket prefix, so
 * each token still starts the text or follows whitespace; the padding is space-separated for the same
 * reason. Both platform runtimes detect links in the text they receive.
 */
function pseudoLocalizeLinkifiedText(text: string, kinds: readonly PrototypeLinkifyKind[]): string {
  if (text.trim() === "") {
    return text;
  }
  const bindings = [...text.matchAll(PLACEHOLDER)].map((found) => ({
    start: found.index,
    end: found.index + found[0].length,
  }));
  // A token that cuts through a `{...}` binding (a pointer such as `/hello @sam`) is part of the
  // binding, not a link: the device resolves the whole binding first.
  const matches = prototypeLinkifyMatches(text, kinds).filter((match) =>
    bindings.every(
      ({ start, end }) =>
        match.end <= start || match.start >= end || (match.start <= start && match.end >= end),
    ),
  );
  const pieces = matches.flatMap((match, index) => [
    pseudoLocalizeSegment(text.slice(index === 0 ? 0 : matches[index - 1]!.end, match.start)),
    match.text,
  ]);
  const tail = text.slice(matches.at(-1)?.end ?? 0);
  const padding = PAD.repeat(Math.ceil([...text].length * PSEUDO_LOCALE_EXPANSION));
  return `${pieces.join("")}${pseudoLocalizeSegment(tail)} ${padding}`;
}

function linkifyKinds(object: Record<string, unknown>): PrototypeLinkifyKind[] | undefined {
  const kinds = record(object.linkify)?.kinds;
  return Array.isArray(kinds) && kinds.every((kind) => LINKIFY_KINDS.has(kind))
    ? (kinds as PrototypeLinkifyKind[])
    : undefined;
}

function pseudoLocalizeEntry(
  object: Record<string, unknown>,
  key: string,
  child: unknown,
): [string, unknown] {
  if (OPAQUE_FIELDS.has(key)) {
    return [key, child];
  }
  if (NAME_KEYED_FIELDS.has(key) && record(child)) {
    const named = Object.entries(record(child)!).map(([name, value]) => [
      name,
      pseudoLocalizeValue(value),
    ]);
    return [key, Object.fromEntries(named)];
  }
  if (DISPLAY_TEXT_FIELDS.has(key) && typeof child === "string") {
    const kinds = key === "text" ? linkifyKinds(object) : undefined;
    return [key, kinds ? pseudoLocalizeLinkifiedText(child, kinds) : pseudoLocalizeText(child)];
  }
  return [key, pseudoLocalizeValue(child)];
}

function pseudoLocalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(pseudoLocalizeValue);
  }
  const object = record(value);
  if (!object) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(object).map(([key, child]) => pseudoLocalizeEntry(object, key, child)),
  );
}

/** A copy of the spec with its display text pseudo-localized. Spans are covered by their `text`. */
export function pseudoLocalizeSpec<T>(spec: T): T {
  return pseudoLocalizeValue(spec) as T;
}

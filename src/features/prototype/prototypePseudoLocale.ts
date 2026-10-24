/**
 * Pseudo-localization for `show` (#14126): every authored display string is accented and padded by
 * about 40% so truncation and clipping show up without a real translation. The authored spec is
 * never changed; only the copy sent to the device is.
 */

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

/** Accented, bracketed and padded to ~140% of the original length; placeholders are untouched. */
export function pseudoLocalizeText(text: string): string {
  if (text.trim() === "") {
    return text;
  }
  const accented = text
    .split(PLACEHOLDER)
    .map((part) => [...part].map((char) => ACCENTS[char] ?? char).join(""));
  const placeholders = text.match(PLACEHOLDER) ?? [];
  const body = accented.map((part, index) => part + (placeholders[index] ?? "")).join("");
  const padding = PAD.repeat(Math.ceil([...text].length * PSEUDO_LOCALE_EXPANSION));
  return `[${body}${padding}]`;
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
    Object.entries(object).map(([key, child]) => {
      if (OPAQUE_FIELDS.has(key)) {
        return [key, child];
      }
      if (DISPLAY_TEXT_FIELDS.has(key) && typeof child === "string") {
        return [key, pseudoLocalizeText(child)];
      }
      return [key, pseudoLocalizeValue(child)];
    }),
  );
}

/** A copy of the spec with its display text pseudo-localized. Spans are covered by their `text`. */
export function pseudoLocalizeSpec<T>(spec: T): T {
  return pseudoLocalizeValue(spec) as T;
}

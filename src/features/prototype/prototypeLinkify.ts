import { PROTOTYPE_LINKIFY_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import { prototypeSpecNodeRoots } from "./prototypeNodeChildren";
import { record, type Raw } from "./prototypeTemplate";

/**
 * `linkify` on a text node (#14233): @mentions, #hashtags and URLs found in the node's resolved
 * text become accessibility links whose taps run `linkify.onTap`, with `{match: "text" | "kind"}`
 * bindings set to the tapped match. The detection grammar is fixed and shared by the TypeScript,
 * Kotlin (`PrototypeLinkify.kt`) and Swift (`PrototypeLinkify.swift`) runtimes, pinned by
 * `test/fixtures/prototype-spec/linkify/cases.json`. Offsets are UTF-16 code units.
 *
 * - A match starts at the start of the text or after a whitespace character.
 * - mention: `@` then 1 to 30 of `[A-Za-z0-9_]`; a longer run is not a mention.
 * - hashtag: `#` then 1 to 100 code units of Unicode letters, combining marks, `[0-9]` or `_`,
 *   not all digits.
 * - url: `http://` or `https://`, up to the next whitespace, with trailing `.,;:!?'")]}`
 *   removed; the rest must match the `checks` `url` format.
 *
 * A URL tap never opens a browser by itself; that is the `links.open` platform call (#14238).
 */
export const PROTOTYPE_LINKIFY_KINDS = ["mention", "hashtag", "url"] as const;
export type PrototypeLinkifyKind = (typeof PROTOTYPE_LINKIFY_KINDS)[number];

export interface PrototypeLinkifyMatch {
  kind: PrototypeLinkifyKind;
  /** The matched text, sigil included. */
  text: string;
  start: number;
  end: number;
}

const MAX_MENTION = 30;
const MAX_HASHTAG = 100;
const URL_FORMAT = /^https?:\/\/[^\s/?#]+([/?#]\S*)?$/u;
const TRAILING = new Set([".", ",", ";", ":", "!", "?", "'", '"', ")", "]", "}"]);
// The contract's whitespace set: JavaScript `\s`, spelled out so Kotlin and Swift match it.
const SPACES = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005,
  0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
]);
const HASHTAG_SCALAR = /^[\p{L}\p{M}0-9_]$/u;

const isSpace = (text: string, at: number): boolean => SPACES.has(text.charCodeAt(at));
const isWord = (code: number): boolean =>
  (code >= 0x30 && code <= 0x39) ||
  (code >= 0x41 && code <= 0x5a) ||
  (code >= 0x61 && code <= 0x7a) ||
  code === 0x5f;

function mentionEnd(text: string, at: number): number | undefined {
  let end = at + 1;
  while (end < text.length && isWord(text.charCodeAt(end))) {
    end++;
  }
  const length = end - at - 1;
  return length >= 1 && length <= MAX_MENTION ? end : undefined;
}

function hashtagEnd(text: string, at: number): number | undefined {
  let end = at + 1;
  let digitsOnly = true;
  while (end < text.length) {
    const scalar = String.fromCodePoint(text.codePointAt(end)!);
    if (!HASHTAG_SCALAR.test(scalar)) {
      break;
    }
    digitsOnly &&= scalar >= "0" && scalar <= "9";
    end += scalar.length;
  }
  const length = end - at - 1;
  return length >= 1 && length <= MAX_HASHTAG && !digitsOnly ? end : undefined;
}

function urlEnd(text: string, at: number): number | undefined {
  if (!text.startsWith("http://", at) && !text.startsWith("https://", at)) {
    return undefined;
  }
  let end = at;
  while (end < text.length && !isSpace(text, end)) {
    end++;
  }
  while (end > at && TRAILING.has(text[end - 1]!)) {
    end--;
  }
  return URL_FORMAT.test(text.slice(at, end)) ? end : undefined;
}

const finders: Record<PrototypeLinkifyKind, { sigil?: string; end: typeof urlEnd }> = {
  mention: { sigil: "@", end: mentionEnd },
  hashtag: { sigil: "#", end: hashtagEnd },
  url: { end: urlEnd },
};

/** The matches of `kinds` in `text`, in order and never overlapping. */
export function prototypeLinkifyMatches(
  text: string,
  kinds: readonly PrototypeLinkifyKind[],
): PrototypeLinkifyMatch[] {
  const matches: PrototypeLinkifyMatch[] = [];
  let at = 0;
  while (at < text.length) {
    const found =
      at === 0 || isSpace(text, at - 1)
        ? kinds
            .map((kind) => {
              const finder = finders[kind];
              const end =
                finder.sigil === undefined || text[at] === finder.sigil
                  ? finder.end(text, at)
                  : undefined;
              return end === undefined ? undefined : { kind, end };
            })
            .find((entry) => entry !== undefined)
        : undefined;
    if (found) {
      matches.push({
        kind: found.kind,
        text: text.slice(at, found.end),
        start: at,
        end: found.end,
      });
      at = found.end;
    } else {
      at++;
    }
  }
  return matches;
}

const isLiteral = (object: Raw): boolean =>
  Object.keys(object).length === 1 && Object.hasOwn(object, "value");

/** The bound action list for one match: each `{match: field}` becomes that match's value. */
export function bindPrototypeLinkifyActions(
  actions: unknown,
  match: Pick<PrototypeLinkifyMatch, "kind" | "text">,
): unknown {
  const bind = (value: unknown, literal: boolean): unknown => {
    if (Array.isArray(value)) {
      return value.map((entry) => bind(entry, false));
    }
    const object = record(value);
    // A `{value}` literal and an emit payload are opaque JSON, never bindings.
    if (!object || isLiteral(object)) {
      return value;
    }
    if (Object.keys(object).length === 1 && typeof object.match === "string") {
      const bound = object.match === "kind" ? match.kind : match.text;
      return literal ? bound : { value: bound };
    }
    return Object.fromEntries(
      Object.entries(object).map(([key, child]) => [
        key,
        key === "payload" ? child : bind(child, key === "value" && object.type === "setState"),
      ]),
    );
  };
  return bind(actions, false);
}

export interface PrototypeLinkifyError {
  path: string;
  message: string;
}

const REPEAT_PLACEHOLDER = /\{(?:index|[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)\}/;

/** The first non-undefined result of `find` over an array's entries, with indexed paths. */
function firstInArray(
  value: unknown[],
  path: string,
  find: (child: unknown, path: string) => string | undefined,
): string | undefined {
  for (const [index, child] of value.entries()) {
    const found = find(child, `${path}[${index}]`);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/** A repeat binding inside `linkify.onTap`, which this version does not bind per row. */
function repeatBindingPath(value: unknown, path: string): string | undefined {
  if (typeof value === "string") {
    return REPEAT_PLACEHOLDER.test(value) ? path : undefined;
  }
  if (Array.isArray(value)) {
    return firstInArray(value, path, repeatBindingPath);
  }
  const object = record(value);
  if (!object || isLiteral(object)) {
    return undefined;
  }
  if (Object.hasOwn(object, "item") || Object.hasOwn(object, "index")) {
    return path;
  }
  return Object.keys(object)
    .sort()
    .filter((key) => key !== "payload")
    .map((key) => repeatBindingPath(object[key], `${path}.${key}`))
    .find((found) => found !== undefined);
}

/** A member's stray `{match}`; stack screens are named in brackets, as the screen-map walk does. */
function strayMatchIn(object: Raw, key: string, path: string): string | undefined {
  const screens = key === "screens" ? record(object.screens) : undefined;
  if (screens) {
    return Object.keys(screens)
      .sort()
      .map((name) => strayMatch(screens[name], `${path}.screens[${JSON.stringify(name)}]`))
      .find((entry) => entry !== undefined);
  }
  return ["linkify", "payload", "repeat"].includes(key)
    ? undefined
    : strayMatch(object[key], `${path}.${key}`);
}

/** Every `{match}` binding outside a `linkify.onTap` list, as a path. */
function strayMatch(value: unknown, path: string): string | undefined {
  if (Array.isArray(value)) {
    return firstInArray(value, path, strayMatch);
  }
  const object = record(value);
  if (!object || isLiteral(object)) {
    return undefined;
  }
  if (Object.keys(object).length === 1 && typeof object.match === "string") {
    return `${path}.match`;
  }
  return Object.keys(object)
    .sort()
    .map((key) => strayMatchIn(object, key, path))
    .find((found) => found !== undefined);
}

function linkifyNodeError(node: Raw, path: string): PrototypeLinkifyError | undefined {
  const linkify = record(node.linkify);
  if (!linkify) {
    return undefined;
  }
  if (node.spans !== undefined) {
    return { path: `${path}.linkify`, message: "linkify applies to text, not spans" };
  }
  const repeat = repeatBindingPath(linkify.onTap, `${path}.linkify.onTap`);
  return repeat
    ? { path: repeat, message: "linkify actions cannot use repeat bindings" }
    : undefined;
}

function walkNodes(value: unknown, path: string, visit: (node: Raw, path: string) => void) {
  if (Array.isArray(value)) {
    value.forEach((child, index) => walkNodes(child, `${path}[${index}]`, visit));
    return;
  }
  const object = record(value);
  if (!object) {
    return;
  }
  if (typeof object.type === "string") {
    visit(object, path);
  }
  for (const key of Object.keys(object).sort()) {
    if (key === "screens" && record(object.screens)) {
      for (const name of Object.keys(record(object.screens)!).sort()) {
        walkNodes(record(object.screens)![name], `${path}.screens[${JSON.stringify(name)}]`, visit);
      }
    } else if (
      key === "child" ||
      key === "children" ||
      (object.type === "list" && ["header", "footer"].includes(key))
    ) {
      walkNodes(object[key], `${path}.${key}`, visit);
    }
  }
}

/** Static linkify rules the contract cannot express, and `{match}` outside linkify actions. */
export function prototypeLinkifyError(spec: unknown): PrototypeLinkifyError | undefined {
  const root = record(spec);
  if (!root) {
    return undefined;
  }
  let error: PrototypeLinkifyError | undefined;
  walkNodes(root.root, "root", (node, path) => {
    error ??= linkifyNodeError(node, path);
  });
  if (error) {
    return error;
  }
  const stray = strayMatch(root.root, "root");
  return stray
    ? { path: stray, message: "{match} is only available inside linkify.onTap" }
    : undefined;
}

/** Authored paths of every text node's `linkify`, including component definitions. */
export function prototypeLinkifyFields(spec: unknown): string[] {
  const fields: string[] = [];
  for (const { node, path } of prototypeSpecNodeRoots(spec)) {
    walkNodes(node, path, (entry, at) => {
      if (entry.type === "text" && entry.linkify !== undefined) {
        fields.push(`${at}.linkify`);
      }
    });
  }
  return fields;
}

export function prototypeLinkifyUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  const device = platform === "ios" ? "connected iOS prototype agent" : "connected CtrlProxy";
  const update =
    platform === "ios"
      ? "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version"
      : "Update the connected CtrlProxy";
  const more = fields.length > 1 ? ` (and ${fields.length - 1} more)` : "";
  return `The ${device} does not advertise ${PROTOTYPE_LINKIFY_CAPABILITY}, so it cannot linkify the text at ${fields[0]}${more}. Nothing was shown. ${update}, or use static spans instead.`;
}

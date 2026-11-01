import { prototypeRequestAppendError } from "./prototypeRequestAppend";
import { prototypeContractPatterns } from "./prototypeContractPatterns";
import { forbiddenHeaderOf } from "./prototypeEgressPolicy";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import {
  PROTOTYPE_NETWORK_CAPABILITY,
  PROTOTYPE_NETWORK_DEVICE_CAPABILITY,
} from "../observe/android/ctrlProxyProtocol";
import { prototypeDataPathPointer } from "./prototypeData";
import { prototypeFieldsOfKind } from "./prototypeEmitContext";
import type { PrototypeJson } from "./prototypeJson";
import {
  resolvePrototypeDataWriteValue,
  type PrototypeDataWriteInputs,
} from "./prototypeDataWrite";
import type { PrototypeRequestMethod } from "./prototypeRequestProtocol";
import type { PrototypeDataActionValue } from "./prototypeActionValues";

/**
 * Host-side rules for the `request` action (#12523). The contract types its fields; this module
 * adds what it cannot: the URL scheme, the `into` path and its `__meta` sibling, the `statusKey`
 * type, bodies on GET/HEAD and the reserved event name. The wire/limits live in
 * `prototypeRequestProtocol.ts` and `prototypeRequestLimits.ts`; applying a response to `/data` is
 * `prototypeRequestOutcome.ts`; the event a request reports is `prototypeRequestEvent.ts`.
 */
export const PROTOTYPE_REQUEST_DEFAULT_METHOD: PrototypeRequestMethod = "GET";
/** Appended to the last segment of `into`: `/data/feed` reports its metadata at `/data/feed__meta`. */
export const PROTOTYPE_REQUEST_META_SUFFIX = "__meta";
/** The emit-kind event name a request completion is reported under; authored emits cannot use it. */
export const PROTOTYPE_REQUEST_EVENT_NAME = "prototype_request";
/** The values `statusKey` moves through. */
export const PROTOTYPE_REQUEST_STATUSES = ["loading", "success", "error"] as const;
export type PrototypeRequestStatus = (typeof PROTOTYPE_REQUEST_STATUSES)[number];

export interface PrototypeRequestActionError {
  path: string;
  message: string;
}

/** Authored paths of every `request` action, whatever its `via`. */
export function prototypeRequestFields(spec: unknown): string[] {
  return prototypeFieldsOfKind(spec, "request");
}

/** Authored paths of every `request` action with `via: "device"`. */
export function prototypeDeviceRequestFields(spec: unknown): string[] {
  return prototypeFieldsOfKind(spec, "deviceRequest");
}

function unsupported(
  fields: readonly string[],
  platform: "android" | "ios",
  capability: string,
  { what, fallback }: { what: string; fallback: string },
): string {
  const device = platform === "android" ? "connected CtrlProxy" : "connected iOS prototype agent";
  const update =
    platform === "android"
      ? "Update the connected CtrlProxy"
      : "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version";
  const more = fields.length > 1 ? ` (and ${fields.length - 1} more)` : "";
  return `The ${device} does not advertise ${capability}, so it cannot run ${what} at ${fields[0]}${more}. Nothing was shown. ${update}, ${fallback}.`;
}

export function prototypeNetworkUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  return unsupported(fields, platform, PROTOTYPE_NETWORK_CAPABILITY, {
    what: "the request action",
    fallback: "or load data with a /data patch instead",
  });
}

export function prototypeNetworkDeviceUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  return unsupported(fields, platform, PROTOTYPE_NETWORK_DEVICE_CAPABILITY, {
    what: 'a request with via "device"',
    fallback: 'or use via "host", which the host executes',
  });
}

/** The `<into>__meta` pointer: the same path with `__meta` appended to its last segment. */
export function prototypeRequestMetaPath(into: string): string {
  return `${into}${PROTOTYPE_REQUEST_META_SUFFIX}`;
}

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const PLACEHOLDER_URL_SCHEME = /^https?:\/\//i;

export function prototypeRequestUrlError(url: string): string | undefined {
  if (url.includes("{")) {
    return PLACEHOLDER_URL_SCHEME.test(url)
      ? undefined
      : "A templated request url must start with a literal http:// or https://";
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? undefined
      : "A request url must be an absolute http or https URL";
  } catch (error) {
    // The parse failure is the finding; the message below is what the author sees.
    logger.debug(`[prototype] request url did not parse: ${errorMessage(error)}`);
    return "A request url must be an absolute http or https URL";
  }
}

/** The `into` rule `request` and `platform` share: a `/data` object member, never an element. */
export function prototypeIntoError(into: string, action: string): string | undefined {
  const bound = into
    .split("/")
    .map((segment) => (segment === "{index}" ? "0" : segment))
    .join("/");
  const pointer = prototypeDataPathPointer(bound);
  if (pointer === undefined) {
    return `${action} into is /data/<RFC 6901 pointer> and addresses a member of data`;
  }
  const last = pointer.slice(pointer.lastIndexOf("/") + 1);
  return /^\d+$/.test(last) || last === "-"
    ? `${action} into must name an object member, not an array element, so into__meta can be written beside it`
    : undefined;
}

const memberPath = (path: string, name: string): string =>
  prototypeContractPatterns.pathKey.test(name)
    ? `${path}.${name}`
    : `${path}[${JSON.stringify(name)}]`;

/** An invalid header name, or one repeated in another letter case (names are case-insensitive). */
function headerNameProblem(name: string, seen: Set<string>): string | undefined {
  if (forbiddenHeaderOf({ [name]: "" }) !== undefined) {
    return "Forbidden request header";
  }
  if (!HEADER_NAME.test(name)) {
    return "Invalid header name";
  }
  const lower = name.toLowerCase();
  if (seen.has(lower)) {
    return "Duplicate header name (names are case-insensitive)";
  }
  seen.add(lower);
  return undefined;
}

function headerLineProblem(field: string, value: unknown, literal: unknown): boolean {
  const text = typeof value === "string" ? value : literal;
  return field === "headers" && typeof text === "string" && /[\r\n]/.test(text);
}

export function prototypeRequestEntryError(
  entries: unknown,
  at: string,
  field: "headers" | "query",
): PrototypeRequestActionError | undefined {
  if (typeof entries !== "object" || entries === null) {
    return undefined;
  }
  const seenHeaders = new Set<string>();
  for (const [name, value] of Object.entries(entries)) {
    const entryPath = memberPath(`${at}.${field}`, name);
    const nameProblem = field === "headers" ? headerNameProblem(name, seenHeaders) : undefined;
    if (nameProblem !== undefined) {
      return { path: entryPath, message: nameProblem };
    }
    const literal = (value as { value?: unknown } | null)?.value;
    if (headerLineProblem(field, value, literal)) {
      return { path: entryPath, message: "CR/LF in header value" };
    }
    if (
      typeof value === "object" &&
      value !== null &&
      Object.hasOwn(value, "value") &&
      !["string", "number", "boolean"].includes(typeof literal)
    ) {
      return {
        path: `${entryPath}.value`,
        message: "A header or query literal must be a string, number or boolean",
      };
    }
  }
  return undefined;
}

function requestActionError(
  action: Record<string, unknown>,
  at: string,
): PrototypeRequestActionError | undefined {
  const url = typeof action.url === "string" ? prototypeRequestUrlError(action.url) : undefined;
  if (url !== undefined) {
    return { path: `${at}.url`, message: url };
  }
  const method =
    typeof action.method === "string" ? action.method : PROTOTYPE_REQUEST_DEFAULT_METHOD;
  if (action.body !== undefined && (method === "GET" || method === "HEAD")) {
    return { path: `${at}.body`, message: "A GET or HEAD request cannot have a body" };
  }
  const into =
    typeof action.into === "string" ? prototypeIntoError(action.into, "request") : undefined;
  if (into !== undefined) {
    return { path: `${at}.into`, message: into };
  }
  return (
    prototypeRequestAppendError(action, at) ??
    prototypeRequestEntryError(action.headers, at, "headers") ??
    prototypeRequestEntryError(action.query, at, "query")
  );
}

/** Static checks for one structurally valid `request` (or reserved `emit`) action at `at`. */
export function prototypeRequestError(
  action: Record<string, unknown>,
  at: string,
): PrototypeRequestActionError | undefined {
  if (action.type === "emit" && action.name === PROTOTYPE_REQUEST_EVENT_NAME) {
    return {
      path: `${at}.name`,
      message: `The emit name ${PROTOTYPE_REQUEST_EVENT_NAME} is reserved for request events`,
    };
  }
  return action.type === "request" ? requestActionError(action, at) : undefined;
}

/** The first request-related static error among the structurally valid `actions`. */
export function prototypeRequestsError(
  actions: readonly { value: Record<string, unknown>; path: string }[],
  data?: unknown,
): PrototypeRequestActionError | undefined {
  for (const { value, path } of actions) {
    const error =
      prototypeRequestError(value, path) ??
      (value.type === "request" ? prototypeRequestAppendError(value, path, data ?? {}) : undefined);
    if (error) {
      return error;
    }
  }
  return undefined;
}

/**
 * `statusKey` (on `request` and `platform`) must be a declared state key holding a string,
 * because the runtime writes `loading`, `success` and `error` to it. `state` is the spec's
 * declared state.
 */
export function prototypeRequestStatusKeyError(
  action: Record<string, unknown>,
  at: string,
  state: Record<string, unknown>,
): PrototypeRequestActionError | undefined {
  const progress = prototypeRequestProgressKeyError(action, at, state);
  if (progress) {
    return progress;
  }
  const key =
    action.type === "request" || action.type === "platform" ? action.statusKey : undefined;
  if (typeof key !== "string") {
    return undefined;
  }
  if (!Object.hasOwn(state, key)) {
    return { path: `${at}.statusKey`, message: "statusKey must name a declared state key" };
  }
  return typeof state[key] === "string"
    ? undefined
    : { path: `${at}.statusKey`, message: "statusKey requires a string state key" };
}

function prototypeRequestProgressKeyError(
  action: Record<string, unknown>,
  at: string,
  state: Record<string, unknown>,
): PrototypeRequestActionError | undefined {
  if (action.type !== "request" || typeof action.progressKey !== "string") {
    return undefined;
  }
  const body = typeof action.body === "object" && action.body !== null ? action.body : undefined;
  if (!body || !["multipart", "form", "file"].some((key) => Object.hasOwn(body, key))) {
    return { path: `${at}.progressKey`, message: "progressKey requires an upload body" };
  }
  const value = state[action.progressKey];
  return Object.hasOwn(state, action.progressKey) &&
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
    ? undefined
    : {
        path: `${at}.progressKey`,
        message: "progressKey requires a declared number state key from 0 to 100",
      };
}

export interface ResolvedPrototypeRequest {
  method: PrototypeRequestMethod;
  url: string;
  headers: Record<string, string>;
  body?: PrototypeJson;
}

export type ResolvedPrototypeRequestResult =
  | { success: true; request: ResolvedPrototypeRequest }
  | { success: false; error: { code: "invalid_request" | "invalid_url"; message: string } };

type RuntimeBinding = Exclude<PrototypeDataActionValue, { item: string } | { index: true }>;
const isBinding = (value: unknown): value is RuntimeBinding =>
  typeof value === "object" && value !== null;

function scalarText(value: PrototypeJson, what: string): { text: string } | { message: string } {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? { text: String(value) }
    : { message: `${what} must resolve to a string, number or boolean` };
}

type Failure = {
  success: false;
  error: { code: "invalid_request" | "invalid_url"; message: string };
};
const failure = (code: Failure["error"]["code"], message: string): Failure => ({
  success: false,
  error: { code, message },
});

function parseHttpUrl(url: string): URL | Failure {
  try {
    const target = new URL(url);
    return target.protocol === "http:" || target.protocol === "https:"
      ? target
      : failure("invalid_url", `Only http and https URLs are supported, got ${target.protocol}`);
  } catch (error) {
    // The parse failure is the finding: it becomes the typed invalid_url outcome.
    logger.debug(`[prototype] request url did not parse: ${errorMessage(error)}`);
    return failure("invalid_url", `Not an absolute URL: ${url}`);
  }
}

/** One header or query entry as text: a literal as is, a binding read from state or data. */
function entryText(
  raw: unknown,
  what: string,
  inputs: PrototypeDataWriteInputs,
): { text: string } | Failure {
  const bound = isBinding(raw) ? resolvePrototypeDataWriteValue(raw, inputs) : undefined;
  if (bound && !bound.success) {
    return failure("invalid_request", `${what}: ${bound.error.message}`);
  }
  const text = scalarText(bound ? bound.value : (raw as string), what);
  return "message" in text ? failure("invalid_request", text.message) : text;
}

const formPair = (name: string, value: string): string =>
  new URLSearchParams([[name, value]]).toString();
const pieceName = (piece: string): string =>
  new URLSearchParams(piece.split("=", 1)[0]).keys().next().value ?? "";

/**
 * The URL with each authored entry set, in the given (sorted) order: a key's first existing piece
 * is replaced in place and its later duplicates removed, an absent key is appended. Only the set
 * pieces are re-encoded (form encoding, space as `+`); every other piece keeps its exact spelling
 * (`?flag`, `%20`), and with no entries the query is untouched. Kotlin and Swift do the same.
 */
function withQuery(target: URL, entries: readonly [string, string][]): string {
  if (entries.length === 0) {
    return target.toString();
  }
  const href = target.href;
  const hashAt = href.indexOf("#");
  const fragment = hashAt < 0 ? "" : href.slice(hashAt);
  const beforeFragment = hashAt < 0 ? href : href.slice(0, hashAt);
  const queryAt = beforeFragment.indexOf("?");
  const base = queryAt < 0 ? beforeFragment : beforeFragment.slice(0, queryAt);
  const pieces = (queryAt < 0 ? "" : beforeFragment.slice(queryAt + 1))
    .split("&")
    .filter((piece) => piece.length > 0);
  for (const [name, value] of entries) {
    const encoded = formPair(name, value);
    const first = pieces.findIndex((piece) => pieceName(piece) === name);
    if (first < 0) {
      pieces.push(encoded);
      continue;
    }
    pieces[first] = encoded;
    for (let at = pieces.length - 1; at > first; at--) {
      if (pieceName(pieces[at]!) === name) {
        pieces.splice(at, 1);
      }
    }
  }
  return `${base}?${pieces.join("&")}${fragment}`;
}

/** Adds one resolved header or query entry to the request being built. */
function addEntry(
  into: { headers: Record<string, string>; query: [string, string][] },
  field: "headers" | "query",
  name: string,
  text: string,
) {
  if (field === "headers") {
    return addHeader(into.headers, name, text);
  }
  into.query.push([name, text]);
  return undefined;
}

/** Adds a resolved header; a name repeated in another letter case is an `invalid_request`. */
function addHeader(headers: Record<string, string>, name: string, text: string) {
  if (Object.keys(headers).some((seen) => seen.toLowerCase() === name.toLowerCase())) {
    return failure("invalid_request", `headers.${name}: duplicate header name`);
  }
  headers[name] = text;
  return undefined;
}

/** Swift cannot keep JSON key order, so query entries use one canonical order everywhere. */
function entriesOf(action: Record<string, unknown>, field: "headers" | "query") {
  const entries = Object.entries((action[field] ?? {}) as Record<string, unknown>);
  return field === "query" ? entries.sort(compareUtf16) : entries;
}

const compareUtf16 = ([a]: [string, unknown], [b]: [string, unknown]): number =>
  a < b ? -1 : a > b ? 1 : 0;

/**
 * The executable reference for a device runtime: resolves a `request`'s bindings against the
 * committed `state` and `data` at the action. `url` is the action's `url` after the usual text
 * placeholders (`{key}`, `{data:/pointer}`, repeat) are bound; `item` and `index` bindings must
 * already be expanded to `{value}`. Each `query` entry is set (not appended) on the URL, in
 * sorted key order (UTF-16 code units, the rule every runtime shares), touching only its own
 * pieces (see `withQuery`), so a query key already in `url` is replaced. A binding whose source is missing
 * or is not a scalar (header, query) fails the request as `invalid_request`.
 */
export function resolvePrototypeRequest(
  action: Record<string, unknown>,
  url: string,
  inputs: PrototypeDataWriteInputs,
): ResolvedPrototypeRequestResult {
  const target = parseHttpUrl(url);
  if (!(target instanceof URL)) {
    return target;
  }
  const headers: Record<string, string> = {};
  const query: [string, string][] = [];
  for (const field of ["headers", "query"] as const) {
    for (const [name, raw] of entriesOf(action, field)) {
      const entry = entryText(raw, `${field}.${name}`, inputs);
      if (!("text" in entry)) {
        return entry;
      }
      const rejected = addEntry({ headers, query }, field, name, entry.text);
      if (rejected) {
        return rejected;
      }
    }
  }
  const body =
    action.body === undefined
      ? undefined
      : resolvePrototypeDataWriteValue(action.body as RuntimeBinding, inputs);
  if (body && !body.success) {
    return failure("invalid_request", `body: ${body.error.message}`);
  }
  const method =
    (action.method as PrototypeRequestMethod | undefined) ?? PROTOTYPE_REQUEST_DEFAULT_METHOD;
  return {
    success: true,
    request: {
      method,
      url: withQuery(target, query),
      headers,
      ...(body ? { body: body.value } : {}),
    },
  };
}

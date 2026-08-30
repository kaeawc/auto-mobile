// JSON-RPC (and JSON generally) cannot represent non-finite numbers — `JSON.stringify`
// coerces Infinity/-Infinity/NaN to `null`. The daemon carries tool-call requests
// over a socket AND a loopback StreamableHTTP hop, so a non-finite argument a caller
// produced (e.g. `a / b` with `b === 0`) is silently flattened to `null` before the
// daemon request log or the tool schema ever sees it (#5854 §2).
//
// To keep the value faithful across those hops, the daemon client encodes each
// non-finite number as a JSON-safe SENTINEL object on the wire, and the receiving
// MCP request handler decodes it back to the real number before logging and
// validation. The sentinel is a plain `{ [TAG]: "Infinity" }` object, so it passes
// through every intermediate JSON.parse/stringify (including the MCP SDK's HTTP
// transport, which this code cannot hook) untouched.
//
// #5863 hardens two robustness gaps left open by #5860:
//   1. Collision — a real payload object that literally has the shape
//      `{ [TAG]: "Infinity" }` would decode to the number Infinity. {@link encodeNonFinite}
//      ESCAPES any real object that carries the reserved TAG key, so on the wire a
//      bare sentinel shape can only ever come from our own encoder, and every real
//      payload round-trips unchanged.
//   2. Provenance — {@link reviveNonFiniteArguments} decodes only requests the client
//      actually encoded (flagged via `DAEMON_NON_FINITE_ENCODED_PARAM`), so direct
//      in-memory / stdio clients skip the walk entirely.

import { DAEMON_NON_FINITE_ENCODED_PARAM } from "../daemon/constants";

// Deliberately unlikely to collide with a real payload key.
const NON_FINITE_TAG = "__autoMobileNonFinite__";

// Key of the escape wrapper's single field. Only ever appears nested under
// NON_FINITE_TAG in an escaped-object sentinel, never at a payload's top level.
const ESCAPE_KEY = "__esc__";

type NonFiniteMarker = "Infinity" | "-Infinity" | "NaN";

function markerFor(value: number): NonFiniteMarker | null {
  if (Number.isNaN(value)) {
    return "NaN";
  }
  if (value === Infinity) {
    return "Infinity";
  }
  if (value === -Infinity) {
    return "-Infinity";
  }
  return null;
}

function numberFor(marker: NonFiniteMarker): number {
  if (marker === "NaN") {
    return NaN;
  }
  return marker === "Infinity" ? Infinity : -Infinity;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Rebuild an object from decoded/encoded entries with Object.fromEntries so an own
// "__proto__" key (valid JSON, e.g. a header map) is set as an own data property
// rather than invoking the prototype setter — plain `out[key] = …` would drop it and
// could pollute the prototype.
function fromEntries(entries: Array<[string, unknown]>): Record<string, unknown> {
  return Object.fromEntries(entries);
}

// A number-sentinel: single key TAG whose value is a recognized marker string.
function numberSentinelMarker(value: Record<string, unknown>): NonFiniteMarker | null {
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== NON_FINITE_TAG) {
    return null;
  }
  const marker = value[NON_FINITE_TAG];
  return marker === "Infinity" || marker === "-Infinity" || marker === "NaN" ? marker : null;
}

// An escaped-object sentinel: single key TAG whose value is `{ [ESCAPE_KEY]: entries }`
// where `entries` is an array of the original object's [key, encodedValue] pairs.
function escapedEntries(value: Record<string, unknown>): Array<[string, unknown]> | null {
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== NON_FINITE_TAG) {
    return null;
  }
  const inner = value[NON_FINITE_TAG];
  if (!isPlainObject(inner)) {
    return null;
  }
  const innerKeys = Object.keys(inner);
  if (innerKeys.length !== 1 || innerKeys[0] !== ESCAPE_KEY) {
    return null;
  }
  const entries = inner[ESCAPE_KEY];
  return Array.isArray(entries) ? (entries as Array<[string, unknown]>) : null;
}

function encodeInto(value: unknown, state: { encoded: boolean }): unknown {
  if (typeof value === "number") {
    const marker = markerFor(value);
    if (marker) {
      state.encoded = true;
      return { [NON_FINITE_TAG]: marker };
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((child) => encodeInto(child, state));
  }
  if (isPlainObject(value)) {
    const encodedEntries = Object.entries(value).map(
      ([key, child]) => [key, encodeInto(child, state)] as [string, unknown],
    );
    // If the (encoded) object carries the reserved TAG key, its bare shape could be
    // misread as a sentinel on decode. Escape it: stash the entries under
    // `{ [TAG]: { [ESCAPE_KEY]: entries } }`, which decode reverses. This makes a
    // raw sentinel shape on the wire provably our own.
    if (Object.prototype.hasOwnProperty.call(value, NON_FINITE_TAG)) {
      return { [NON_FINITE_TAG]: { [ESCAPE_KEY]: encodedEntries } };
    }
    return fromEntries(encodedEntries);
  }
  return value;
}

/**
 * Encode non-finite numbers as JSON-safe sentinels and escape any real object that
 * collides with the sentinel shape. Returns a decoded-safe copy plus whether any
 * non-finite number was actually encoded (transport provenance — the client only
 * flags requests where this is true). The input is not mutated.
 */
export function encodeNonFinite(value: unknown): { value: unknown; encoded: boolean } {
  const state = { encoded: false };
  const encoded = encodeInto(value, state);
  return { value: encoded, encoded: state.encoded };
}

/**
 * Reverse {@link encodeNonFinite}: restore non-finite numbers and un-escape real
 * objects that used the reserved TAG key. Returns a decoded copy; the input is not
 * mutated. A payload with no sentinels is a cheap structural walk.
 */
export function decodeNonFinite(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(decodeNonFinite);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const marker = numberSentinelMarker(value);
  if (marker) {
    return numberFor(marker);
  }
  const escaped = escapedEntries(value);
  if (escaped) {
    return fromEntries(escaped.map(([key, child]) => [key, decodeNonFinite(child)]));
  }
  return fromEntries(
    Object.entries(value).map(([key, child]) => [key, decodeNonFinite(child)]),
  );
}

/**
 * Provenance-scoped revival for a tool call's `arguments` (#5863). Decodes sentinels
 * ONLY when the arguments carry the encoded flag the daemon client sets, then strips
 * the flag. Arguments without the flag — direct in-memory / stdio clients that never
 * encoded — are returned untouched, so no valid payload is walked or misread.
 */
export function reviveNonFiniteArguments(args: unknown): unknown {
  if (!isPlainObject(args)) {
    return args;
  }
  if (args[DAEMON_NON_FINITE_ENCODED_PARAM] !== true) {
    return args;
  }
  const rest = { ...args };
  delete rest[DAEMON_NON_FINITE_ENCODED_PARAM];
  return decodeNonFinite(rest);
}

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

// Deliberately unlikely to collide with a real payload key.
const NON_FINITE_TAG = "__autoMobileNonFinite__";

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

// A `JSON.stringify` replacer that rewrites non-finite numbers as sentinel objects.
// `JSON.stringify` invokes the replacer with the live value BEFORE its own
// null-coercion, so returning an object here is what actually reaches the wire.
export function nonFiniteReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "number") {
    const marker = markerFor(value);
    if (marker) {
      return { [NON_FINITE_TAG]: marker };
    }
  }
  return value;
}

function sentinelMarker(value: object): NonFiniteMarker | null {
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== NON_FINITE_TAG) {
    return null;
  }
  const marker = (value as Record<string, unknown>)[NON_FINITE_TAG];
  return marker === "Infinity" || marker === "-Infinity" || marker === "NaN" ? marker : null;
}

// Recursively convert sentinel objects produced by {@link nonFiniteReplacer} back
// into their non-finite numbers. Returns a decoded copy; the input is not mutated.
// Anything that is not a sentinel is passed through unchanged, so calling this on a
// payload with no sentinels (the common case) is a cheap structural walk.
export function reviveNonFiniteNumbers(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(reviveNonFiniteNumbers);
  }
  const marker = sentinelMarker(value);
  if (marker) {
    return numberFor(marker);
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = reviveNonFiniteNumbers(child);
  }
  return out;
}

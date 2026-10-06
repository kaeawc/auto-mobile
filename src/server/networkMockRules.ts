import { MockRule, NetworkState } from "./NetworkState";
import { errorMessage } from "../utils/describeUnknownError";

/**
 * Wire shape for a single mock rule sent to a device's CtrlProxy over the
 * `set_network_mock_rules` message. Mirrors {@link MockRule} but is the
 * serialized contract — kept as its own type so the host-side serializer can
 * evolve independently of the in-memory store.
 */
export interface NetworkMockRuleSync {
  mockId: string;
  host: string;
  path: string;
  method: string;
  limit: number | null;
  remaining: number | null;
  statusCode: number;
  responseHeaders: Record<string, string>;
  responseBody: string;
  contentType: string;
}

/**
 * Build the device-bound mock-rule payload for ONE device from the current
 * {@link NetworkState} (issue #10061: a device only ever receives its own rules).
 *
 * Single source of truth for the host → device mock-rule mapping shared by the
 * Android and iOS CtrlProxy clients (reconnect sync) and the `network` tool
 * (live sync). `remaining` is the install-time count (`limit`): the server never
 * tracks consumption, and the device-side NetworkMockRuleStore keeps the live
 * count per `mockId` across a re-push (issue #10060), so a rule it already holds
 * is never re-armed by this value.
 */
export function buildNetworkMockRules(
  state: NetworkState,
  deviceId: string,
): NetworkMockRuleSync[] {
  return Array.from(state.getMocks(deviceId).values()).map((r: MockRule) => ({
    mockId: r.mockId,
    host: r.host,
    path: r.path,
    method: r.method,
    limit: r.limit,
    remaining: r.limit,
    statusCode: r.statusCode,
    responseHeaders: r.responseHeaders,
    responseBody: r.responseBody,
    contentType: r.contentType,
  }));
}

// --- host/path pattern validation ---------------------------------------------------------------
//
// `mockNetwork` host/path patterns are compiled on the device (Kotlin `Regex` on Android,
// `NSRegularExpression` on iOS), not by JavaScript. The engines disagree, so the host only rejects
// what is certainly invalid on the device and otherwise lets the device's engine decide. It does NOT
// emulate the device engine (JVM, Android ICU and JS regex differ from one another).

/** Leading inline-flag groups such as `(?i)` or `(?is-m)`: accepted by both device engines, not by JS. */
const LEADING_INLINE_FLAGS = /^(?:\(\?(?=[a-zA-Z-])[a-zA-Z]*(?:-[a-zA-Z]+)?\))+/;
const INLINE_FLAG_GROUP = /\(\?(?=[a-zA-Z-])([a-zA-Z]*)(?:-[a-zA-Z]+)?\)/g;
/** `{n}`, `{n,}` and `{n,m}`: the only brace forms a device engine accepts outside a class/escape. */
const BRACE_QUANTIFIER = /^\{\d+(?:,\d*)?\}/;

/** Index just past the escape sequence that starts at `start` (a backslash). */
function skipEscape(pattern: string, start: number): number {
  const next = pattern[start + 1];
  if (next === "Q") {
    const end = pattern.indexOf("\\E", start + 2);
    return end === -1 ? pattern.length : end + 2;
  }
  const bracedEscape = next === "p" || next === "P" || next === "x" || next === "N";
  if (bracedEscape && pattern[start + 2] === "{") {
    const close = pattern.indexOf("}", start + 3);
    return close === -1 ? pattern.length : close + 1;
  }
  return start + 2;
}

/** Index just past the character class opening at `start`; JS already validated it is closed. */
function skipCharacterClass(pattern: string, start: number): number {
  let index = start + 1;
  while (index < pattern.length && pattern[index] !== "]") {
    index = pattern[index] === "\\" ? index + 2 : index + 1;
  }
  return index + 1;
}

/** Index of the first `{` that does not begin a valid quantifier, or -1. */
function findUnescapedBrace(pattern: string): number {
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index];
    if (char === "\\") {
      index = skipEscape(pattern, index);
    } else if (char === "[") {
      index = skipCharacterClass(pattern, index);
    } else if (char !== "{") {
      index += 1;
    } else {
      const quantifier = BRACE_QUANTIFIER.exec(pattern.slice(index));
      if (quantifier === null) {
        return index;
      }
      index += quantifier[0].length;
    }
  }
  return -1;
}

/**
 * Return why `pattern` is certainly not a valid device regex, or `null` when the host cannot tell
 * (the device compiles it and is the source of truth).
 *
 * - Leading inline flags (`(?i)`) are accepted: both device engines support them although
 *   JavaScript's `RegExp` rejects them.
 * - An unescaped `{` that is not a `{n}`, `{n,}` or `{n,m}` quantifier is rejected: JavaScript
 *   treats it as a literal but the JVM and ICU engines throw (`/users/{id}` never compiles there).
 * - Under the `x` (free-spacing) flag brace structure is not analysed beyond JavaScript's own
 *   check, so nothing the device might accept is refused.
 */
export function describeInvalidMockPattern(pattern: string): string | null {
  const flagsPrefix = LEADING_INLINE_FLAGS.exec(pattern)?.[0] ?? "";
  const body = pattern.slice(flagsPrefix.length);
  try {
    new RegExp(body);
  } catch (error) {
    return errorMessage(error);
  }
  const freeSpacing = Array.from(flagsPrefix.matchAll(INLINE_FLAG_GROUP)).some((group) =>
    group[1].includes("x"),
  );
  const brace = freeSpacing ? -1 : findUnescapedBrace(body);
  if (brace === -1) {
    return null;
  }
  return (
    `unescaped '{' at index ${flagsPrefix.length + brace} is not a {n}, {n,} or {n,m} quantifier; ` +
    `the device regex engine rejects it although JavaScript accepts it as a literal. ` +
    `Escape it as '\\{' to match a literal brace`
  );
}

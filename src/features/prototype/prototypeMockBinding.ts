/**
 * Placeholder binding for canned mock responses (#14271): `{params.id}`, `{query.q}` and
 * `{body:/pointer}`, the same placeholder family as specs and no expressions. A string that is
 * exactly one placeholder takes the bound value's type; a placeholder inside longer text is
 * interpolated as text. An unbound placeholder is `null` (exact) or empty (interpolated).
 */
import { logger } from "../../utils/logger";
import { resolvePrototypeDataPointer } from "./prototypeData";
import { MAX_PROTOTYPE_RESPONSE_BYTES } from "./prototypeRequestLimits";
import type { PrototypeRequestJson } from "./prototypeRequestProtocol";

export interface MockBindingContext {
  params: Record<string, string>;
  query: Record<string, string>;
  body: PrototypeRequestJson | undefined;
}

const PLACEHOLDER = /\{(params\.[A-Za-z][A-Za-z0-9_]*|query\.[^{}\s]+|body:\/[^{}\s]*)\}/g;
const EXACT = new RegExp(`^${PLACEHOLDER.source}$`);

function lookup(token: string, context: MockBindingContext): PrototypeRequestJson | undefined {
  // Own properties only: `{query.toString}` must be unbound, not the inherited function.
  if (token.startsWith("params.")) {
    return ownValue(context.params, token.slice("params.".length));
  }
  if (token.startsWith("query.")) {
    return ownValue(context.query, token.slice("query.".length));
  }
  return resolvePrototypeDataPointer(context.body, token.slice("body:".length)) as
    | PrototypeRequestJson
    | undefined;
}

function ownValue(values: Record<string, string>, name: string): string | undefined {
  return Object.hasOwn(values, name) ? values[name] : undefined;
}

function asText(value: PrototypeRequestJson | undefined): string {
  if (value === undefined || value === null) {
    return "";
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Binding would produce more than the response cap; the request then fails as `too_large`. */
export class MockResponseTooLargeError extends Error {}

/**
 * Binds placeholders in `value`. The output is charged against `limit` characters as it is built,
 * so a small body with many placeholders over a long query cannot expand to a huge string before
 * the response cap is checked: the first charge past the limit throws.
 */
export function bindMockValue(
  value: PrototypeRequestJson,
  context: MockBindingContext,
  limit: number = MAX_PROTOTYPE_RESPONSE_BYTES,
): PrototypeRequestJson {
  let left = limit;
  const charge = (size: number): void => {
    left -= size;
    if (left < 0) {
      throw new MockResponseTooLargeError(`Response body exceeds ${limit} bytes.`);
    }
  };
  // A value bound by an exact placeholder is shared, not copied; its serialized size is charged
  // per use and measured once per token.
  const sizes = new Map<string, number>();
  const sizeOf = (token: string, bound: PrototypeRequestJson): number => {
    let size = sizes.get(token);
    if (size === undefined) {
      size = JSON.stringify(bound).length;
      sizes.set(token, size);
    }
    return size;
  };
  const bind = (entry: PrototypeRequestJson): PrototypeRequestJson => {
    if (typeof entry === "string") {
      const exact = EXACT.exec(entry);
      if (exact) {
        const bound = lookup(exact[1]!, context) ?? null;
        charge(sizeOf(exact[1]!, bound));
        return bound;
      }
      // Literal text only: each placeholder is charged for what it emits, not for its own syntax.
      charge(entry.replace(PLACEHOLDER, "").length);
      return entry.replace(PLACEHOLDER, (_match, token: string) => {
        const text = asText(lookup(token, context));
        charge(text.length);
        return text;
      });
    }
    if (Array.isArray(entry)) {
      // Brackets and the commas between elements.
      charge(2 + Math.max(0, entry.length - 1));
      return entry.map(bind);
    }
    if (typeof entry === "object" && entry !== null) {
      // Braces and the commas between members.
      charge(2 + Math.max(0, Object.keys(entry).length - 1));
      return Object.fromEntries(
        Object.entries(entry).map(([key, member]) => {
          charge(key.length + 3);
          return [key, bind(member)];
        }),
      );
    }
    charge(JSON.stringify(entry).length);
    return entry;
  };
  return bind(value);
}

/** Matches `/feed/:id` against a request path; the captured parameters, or undefined on a miss. */
export function matchMockPath(pattern: string, path: string): Record<string, string> | undefined {
  const want = pattern.split("/");
  const got = path.split("/");
  if (want.length !== got.length) {
    return undefined;
  }
  const params: Record<string, string> = {};
  for (const [index, segment] of want.entries()) {
    const actual = got[index]!;
    if (segment.startsWith(":")) {
      params[segment.slice(1)] = decodeURIComponentSafe(actual);
    } else if (segment !== actual) {
      return undefined;
    }
  }
  return params;
}

export function decodeURIComponentSafe(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch (error) {
    // A malformed escape keeps its literal text, so a hand-typed path still matches.
    logger.debug("[PrototypeMock] path segment is not valid percent-encoding.");
    return segment;
  }
}

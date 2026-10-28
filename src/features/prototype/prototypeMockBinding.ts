/**
 * Placeholder binding for canned mock responses (#14271): `{params.id}`, `{query.q}` and
 * `{body:/pointer}`, the same placeholder family as specs and no expressions. A string that is
 * exactly one placeholder takes the bound value's type; a placeholder inside longer text is
 * interpolated as text. An unbound placeholder is `null` (exact) or empty (interpolated).
 */
import { logger } from "../../utils/logger";
import { resolvePrototypeDataPointer } from "./prototypeData";
import type { PrototypeRequestJson } from "./prototypeRequestProtocol";

export interface MockBindingContext {
  params: Record<string, string>;
  query: Record<string, string>;
  body: PrototypeRequestJson | undefined;
}

const PLACEHOLDER = /\{(params\.[A-Za-z][A-Za-z0-9_]*|query\.[^{}\s]+|body:\/[^{}\s]*)\}/g;
const EXACT = new RegExp(`^${PLACEHOLDER.source}$`);

function lookup(token: string, context: MockBindingContext): PrototypeRequestJson | undefined {
  if (token.startsWith("params.")) {
    return context.params[token.slice("params.".length)];
  }
  if (token.startsWith("query.")) {
    return context.query[token.slice("query.".length)];
  }
  return resolvePrototypeDataPointer(context.body, token.slice("body:".length)) as
    | PrototypeRequestJson
    | undefined;
}

function asText(value: PrototypeRequestJson | undefined): string {
  if (value === undefined || value === null) {
    return "";
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function bindMockValue(
  value: PrototypeRequestJson,
  context: MockBindingContext,
): PrototypeRequestJson {
  if (typeof value === "string") {
    const exact = EXACT.exec(value);
    if (exact) {
      return lookup(exact[1]!, context) ?? null;
    }
    return value.replace(PLACEHOLDER, (_match, token: string) => asText(lookup(token, context)));
  }
  if (Array.isArray(value)) {
    return value.map((entry) => bindMockValue(entry, context));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, bindMockValue(entry, context)]),
    );
  }
  return value;
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

function decodeURIComponentSafe(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch (error) {
    // A malformed escape keeps its literal text, so a hand-typed path still matches.
    logger.debug("[PrototypeMock] path segment is not valid percent-encoding.");
    return segment;
  }
}

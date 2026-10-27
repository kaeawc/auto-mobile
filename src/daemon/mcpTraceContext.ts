import { AsyncLocalStorage } from "node:async_hooks";
import {
  TRACEPARENT_META_KEY,
  TRACESTATE_META_KEY,
  BAGGAGE_META_KEY,
} from "@modelcontextprotocol/server";

export interface McpTraceContext {
  readonly traceparent: string;
  readonly traceId: string;
  readonly parentId: string;
  readonly traceFlags: string;
  readonly tracestate?: string;
  readonly baggage?: string;
}

const traceStorage = new AsyncLocalStorage<McpTraceContext | undefined>();

export function withMcpTrace<T>(ctx: McpTraceContext | undefined, fn: () => T): T {
  return traceStorage.run(ctx, fn);
}

export function currentMcpTrace(): McpTraceContext | undefined {
  return traceStorage.getStore();
}

// These expressions validate W3C wire fields, not serialized JSON. No tracing dependency is
// needed: node:async_hooks supplies isolation and the SDK supplies the envelope key names.
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const TRACESTATE_KEY =
  /^(?:[a-z][a-z0-9_*/-]{0,255}|[a-z0-9][a-z0-9_*/-]{0,240}@[a-z][a-z0-9_*/-]{0,13})$/;
const TRACESTATE_VALUE = /^[\x20-\x2b\x2d-\x3c\x3e-\x7e]{0,255}[\x21-\x2b\x2d-\x3c\x3e-\x7e]$/;
const BAGGAGE_KEY = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const BAGGAGE_VALUE = /^(?:[\x21\x23-\x24\x26-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]|%[0-9a-fA-F]{2})*$/;

function trimOws(value: string): string {
  return value.replace(/^[ \t]+|[ \t]+$/g, "");
}

function validatedTracestate(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 512 || /[^\x20-\x7e\t]/.test(value)) {
    return undefined;
  }
  const members = value.split(",");
  if (members.length > 32) {
    return undefined;
  }
  const keys = new Set<string>();
  for (const member of members) {
    const entry = trimOws(member);
    if (entry === "") {
      continue;
    }
    const separator = entry.indexOf("=");
    const key = entry.slice(0, separator);
    const entryValue = entry.slice(separator + 1);
    if (
      separator < 0 ||
      !TRACESTATE_KEY.test(key) ||
      !TRACESTATE_VALUE.test(entryValue) ||
      keys.has(key)
    ) {
      return undefined;
    }
    keys.add(key);
  }
  return value;
}

function validBaggagePair(entry: string, property: boolean): boolean {
  const separator = entry.indexOf("=");
  if (separator < 0) {
    return property && BAGGAGE_KEY.test(trimOws(entry));
  }
  return (
    BAGGAGE_KEY.test(trimOws(entry.slice(0, separator))) &&
    BAGGAGE_VALUE.test(trimOws(entry.slice(separator + 1)))
  );
}

function validatedBaggage(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 8192 || /[^\x20-\x7e\t]/.test(value)) {
    return undefined;
  }
  const members = value.split(",");
  if (members.length > 180) {
    return undefined;
  }
  const valid = members.every((member) =>
    member.split(";").every((entry, index) => validBaggagePair(entry, index > 0)),
  );
  return valid ? value : undefined;
}

/** Invalid optional fields are dropped independently; an invalid parent gives no context. */
export function parseMcpTrace(meta: unknown): McpTraceContext | undefined {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return undefined;
  }
  const fields = meta as Record<string, unknown>;
  const traceparent = fields[TRACEPARENT_META_KEY];
  if (typeof traceparent !== "string" || traceparent.length !== 55) {
    return undefined;
  }
  const match = TRACEPARENT.exec(traceparent);
  if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2])) {
    return undefined;
  }
  return Object.freeze({
    traceparent,
    traceId: match[1],
    parentId: match[2],
    traceFlags: match[3],
    tracestate: validatedTracestate(fields[TRACESTATE_META_KEY]),
    baggage: validatedBaggage(fields[BAGGAGE_META_KEY]),
  });
}

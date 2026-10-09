/**
 * The device session a daemon `tools/call` was routed to and admitted under (#10974).
 *
 * A proxy forwards selector calls (`deviceId`/`platform`, no `sessionUuid`) and lets the daemon
 * resolve the session. To credit the session that call used, the daemon echoes it in the result's
 * `_meta`; the proxy credits exactly that session instead of inferring it from the selector. The
 * field is additive: it is omitted for reads (watching is not use, #10964), for calls refused at
 * admission, and for sessionless calls, and clients that do not know it ignore it.
 */
export const ROUTED_SESSION_META_KEY = "automobile/routedSessionUuid";

/** Add the routed session to a tool result's `_meta`; returns the result unchanged without one. */
export function withRoutedSessionMeta<T>(result: T, sessionUuid: string | undefined): T {
  if (!sessionUuid || result === null || typeof result !== "object") {
    return result;
  }
  const existing = (result as { _meta?: unknown })._meta;
  const meta = existing !== null && typeof existing === "object" ? existing : {};
  return { ...result, _meta: { ...meta, [ROUTED_SESSION_META_KEY]: sessionUuid } };
}

/** The routed session a daemon echoed in a tool result, when it did. */
export function routedSessionUuidFromResult(result: unknown): string | undefined {
  if (result === null || typeof result !== "object") {
    return undefined;
  }
  const meta = (result as { _meta?: unknown })._meta;
  if (meta === null || typeof meta !== "object") {
    return undefined;
  }
  const value = (meta as Record<string, unknown>)[ROUTED_SESSION_META_KEY];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

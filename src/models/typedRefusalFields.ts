/** The wire fields of a typed refusal: a `code` a client can branch on and whether to retry. */
export interface TypedRefusalFields {
  code: string;
  retryable: boolean;
  retryAfterMs?: number;
  nextAction?: string;
  details?: Record<string, unknown>;
}

/**
 * The typed refusal fields an error carries, read structurally so every refusal class (capacity,
 * discovery, acquisition, session) crosses a wire without a per-class branch (#11236, #11244).
 * Only an error with both a string `code` and a boolean `retryable` is a typed refusal; anything
 * else (e.g. a Node `ENOENT`) yields `undefined`.
 */
export function typedRefusalFields(error: unknown): TypedRefusalFields | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const field = (key: string): unknown => Reflect.get(error, key);
  const code = field("code");
  const retryable = field("retryable");
  if (typeof code !== "string" || typeof retryable !== "boolean") {
    return undefined;
  }
  const retryAfterMs = field("retryAfterMs");
  const nextAction = field("nextAction");
  const details = field("details");
  return {
    code,
    retryable,
    ...(typeof retryAfterMs === "number" ? { retryAfterMs } : {}),
    ...(typeof nextAction === "string" ? { nextAction } : {}),
    ...(typeof details === "object" && details !== null && !Array.isArray(details)
      ? { details: Object.fromEntries(Object.entries(details)) }
      : {}),
  };
}

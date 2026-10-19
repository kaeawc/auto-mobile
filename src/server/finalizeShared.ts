import { stringifyToolResponse } from "../utils/toolUtils";
import { DEFAULT_OBSERVATION_INLINE_MAX_BYTES, emittedByteLength } from "./finalizeSizing";

export const OBSERVE_WAIT_METADATA_KEYS = [
  "awaitedElement",
  "awaitDuration",
  "awaitTimeout",
  "matched",
  "settled",
  "timedOut",
  "timeoutReason",
  "polls",
  "waitMs",
  "matchedElement",
  "candidates",
] as const;

/** Request-local renderings: inline text strips extras; complete JSON preserves them. */
export class ToolResponseSerialization {
  private readonly inline = new Map<unknown, string>();
  private readonly complete = new Map<unknown, string>();

  text(payload: unknown): string {
    if (!this.inline.has(payload)) {
      this.inline.set(payload, stringifyToolResponse(payload));
    }
    return this.inline.get(payload)!;
  }

  artifact(payload: unknown): string {
    if (!this.complete.has(payload)) {
      this.complete.set(payload, JSON.stringify(payload));
    }
    return this.complete.get(payload)!;
  }
}

/** Whether the payload, as the client will actually receive it, is over the ceiling. */
export function exceedsInlineLimit(
  payload: Record<string, unknown>,
  hasStructured: boolean,
  serialization: ToolResponseSerialization,
): boolean {
  return (
    emittedByteLength(payload, hasStructured, serialization) > DEFAULT_OBSERVATION_INLINE_MAX_BYTES
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

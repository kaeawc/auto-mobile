import type { ToolResponseSerialization } from "./finalizeShared";
import { logger } from "../utils/logger";

export const DEFAULT_OBSERVATION_INLINE_MAX_BYTES = 64 * 1024;

/**
 * Bytes this payload will actually put on the wire (#6870 review).
 *
 * The text part is rendered with `stringifyToolResponse`, whose replacer drops
 * every property named `extras`. But `structuredContent` is assigned the
 * UNSTRIPPED payload object and is serialized by the transport with a plain
 * `JSON.stringify`, extras included. Measuring only the stripped rendering let a
 * result whose bulk is accessibility `extras` measure as a handful of bytes and
 * sail straight past the hard ceiling while 70 KB of structured content went to
 * the client. Measure the larger of the two renderings, so the gate bounds
 * whichever representation is actually emitted.
 */
export function emittedByteLength(
  payload: Record<string, unknown>,
  hasStructured: boolean,
  serialization: ToolResponseSerialization,
): number {
  const strippedBytes = Buffer.byteLength(serialization.text(payload), "utf8");
  if (!hasStructured) {
    return strippedBytes;
  }
  return Math.max(strippedBytes, structuredByteLength(payload, strippedBytes, serialization));
}

function structuredByteLength(
  payload: Record<string, unknown>,
  fallback: number,
  serialization: ToolResponseSerialization,
): number {
  try {
    return Buffer.byteLength(serialization.artifact(payload), "utf8");
  } catch (error) {
    // A payload the transport itself cannot serialize (a cycle, a BigInt) has no
    // structured byte count to compare against; the stripped rendering is the
    // only measurement available. Safe to swallow: this is sizing, not delivery.
    logger.debug(`finalizeToolResponse: structured payload is not measurable: ${error}`);
    return fallback;
  }
}

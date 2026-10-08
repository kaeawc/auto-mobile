import { ActionableError } from "../models/ActionableError";
import { logger } from "../utils/logger";

/** The message every resource uses when a URI path segment is not valid percent-encoding. */
export const MALFORMED_URI_SEGMENT_MESSAGE =
  "Malformed resource URI: a path segment is not valid percent-encoding.";

/** A resource URI path segment is not valid percent-encoding: the client's invalid params. */
export class MalformedResourceUriError extends ActionableError {
  constructor() {
    super(MALFORMED_URI_SEGMENT_MESSAGE);
    this.name = "MalformedResourceUriError";
  }
}

/**
 * Decode a percent-encoded URI path segment, returning null when the encoding is
 * malformed (a bare `%`, `%zz`, a truncated multi-byte escape).
 *
 * `ResourceRegistry` passes path captures through undecoded, so every handler that
 * decodes one owns the failure: `decodeURIComponent` throws a raw `URIError` that
 * would otherwise escape past the handler's own JSON error envelope and surface to
 * the client as an opaque protocol error (#5734, #5853, #10117). Callers return
 * their resource-specific envelope when this yields null.
 */
export function safeDecodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    // A malformed client URI is expected input validation, not a server fault; the
    // caller turns the null into its typed error envelope.
    logger.debug(`[ResourceUri] Malformed URI segment '${value}': ${error}`);
    return null;
  }
}

/**
 * Like {@link safeDecodeSegment}, for contract parsers whose callers already
 * surface thrown errors to the client: throws a {@link MalformedResourceUriError}
 * (an ActionableError the resource registry maps to invalid params) instead of the
 * raw `URIError`.
 */
export function decodeSegmentOrThrow(value: string): string {
  const decoded = safeDecodeSegment(value);
  if (decoded === null) {
    throw new MalformedResourceUriError();
  }
  return decoded;
}

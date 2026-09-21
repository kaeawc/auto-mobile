const REDACTED_URI_MARKER = "<redacted>";
const URI_SCHEME = /^([a-z][a-z0-9+.-]*):/i;

/**
 * Produces a safe URI summary for public errors and durable diagnostics.
 *
 * A destination's scheme and host identify its handler without exposing
 * userinfo or any request-specific path, query, or fragment data.
 */
export function redactUri(rawUrl: string): string {
  const scheme = rawUrl.match(URI_SCHEME)?.[1];

  if (!URL.canParse(rawUrl)) {
    return scheme ? `${scheme}:${REDACTED_URI_MARKER}` : REDACTED_URI_MARKER;
  }

  const url = new URL(rawUrl);
  if (url.host) {
    return `${url.protocol}//${url.host}/${REDACTED_URI_MARKER}`;
  }
  return `${url.protocol}${REDACTED_URI_MARKER}`;
}

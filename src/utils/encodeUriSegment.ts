/**
 * `encodeURIComponent` that cannot throw on a device-reported string.
 *
 * `encodeURIComponent` throws a `URIError` on a lone UTF-16 surrogate, which a device
 * can report in an app id, file name, database path, table or store name. Resource
 * URI builders run for well-formed client requests, so such a name must never turn
 * into an error. The string is well-formed first: a lone surrogate becomes U+FFFD,
 * which encodes as `%EF%BF%BD`. Strings that are already well-formed encode exactly as
 * `encodeURIComponent` would.
 */
export function encodeUriSegment(value: string): string {
  return encodeURIComponent(value.toWellFormed());
}

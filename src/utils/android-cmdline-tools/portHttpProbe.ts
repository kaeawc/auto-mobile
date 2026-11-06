import { shellQuote } from "../shellQuote";

/** One HTTP request sent from the device to `127.0.0.1:<devicePort>`, through a reverse. */
export interface PortHttpProbeRequest {
  /** Request target; starts with `/`, printable ASCII, no spaces. */
  path: string;
  /** `Host` header; default `localhost:<devicePort>`. */
  hostHeader?: string;
  /** Whole seconds the device waits for the response. */
  timeoutSeconds: number;
}

/** What the device saw after sending the request. */
export type PortHttpProbeOutcome =
  /** A status line arrived; `body` is what followed the headers (possibly cut short). */
  | { kind: "response"; status: number; body: string }
  /** Connected, but no HTTP status line came back (closed at once, or something else spoke). */
  | { kind: "no_response"; detail: string }
  /** Connected and nothing at all came back before the device's timeout. */
  | { kind: "timeout" }
  /** Nothing listens on the device port (no reverse). */
  | { kind: "refused" }
  /** The shell has no usable `timeout` or `nc`, or printed something unrecognised. */
  | { kind: "unsupported"; detail: string };

// The same marker as the TCP probe, so its toybox captures of a refused connect and a missing binary
// are outputs of this script too: both end before any request byte is sent.
const EXIT_MARKER = "automobile-probe-exit=";
const TIMEOUT_KILLED_EXIT = 124;
const MISSING_BINARY_EXITS = new Set([126, 127]);

/** A path that may be sent: starts with `/`, printable ASCII, no spaces or controls. */
export const PROBE_PATH_PATTERN = /^\/[\x21-\x7e]*$/;
/** A Host header value that may be sent: a host name or IP literal, with an optional port. */
export const PROBE_HOST_HEADER_PATTERN = /^[A-Za-z0-9.\-:\[\]]+$/;

const isProbePath = (path: string): boolean => PROBE_PATH_PATTERN.test(path);
const isProbeHostHeader = (host: string): boolean => PROBE_HOST_HEADER_PATTERN.test(host);

/**
 * The device shell script for one HTTP probe. The request lines are `printf` arguments, never its
 * format, so a `%` in the path is sent as is. `Connection: close` asks the server to close after
 * the response; the `sleep` keeps `nc`'s stdin open (it quits at EOF) until the `timeout` ends it.
 */
export function portHttpProbeScript(devicePort: number, request: PortHttpProbeRequest): string {
  if (!isProbePath(request.path)) {
    throw new Error(`invalid HTTP probe path: ${JSON.stringify(request.path)}`);
  }
  const host = request.hostHeader ?? `localhost:${devicePort}`;
  if (!isProbeHostHeader(host)) {
    throw new Error(`invalid HTTP probe Host header: ${JSON.stringify(host)}`);
  }
  const seconds = Math.max(1, Math.ceil(request.timeoutSeconds));
  const lines = [`GET ${request.path} HTTP/1.0`, `Host: ${host}`, "Connection: close", ""];
  return (
    `(printf '%s\\r\\n' ${lines.map(shellQuote).join(" ")}; sleep ${seconds + 0.1}) | ` +
    `timeout ${seconds} nc -w ${seconds} 127.0.0.1 ${devicePort} 2>&1; ` +
    `printf "\\n${EXIT_MARKER}%s\\n" $?`
  );
}

const STATUS_LINE = /^HTTP\/\d(?:\.\d)? (\d{3})(?: |\r?$)/;

/** Text after the first blank line (the end of the headers), or empty when there is none. */
function bodyOf(response: string): string {
  const crlf = response.indexOf("\r\n\r\n");
  if (crlf >= 0) {
    return response.slice(crlf + 4);
  }
  const lf = response.indexOf("\n\n");
  return lf >= 0 ? response.slice(lf + 2) : "";
}

const oneLine = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" ");

/**
 * Parses the output of {@link portHttpProbeScript}. A status line at the start of the output is a
 * response whatever the exit status (the server may have held the connection past the timeout).
 * Otherwise: exit 1 with `Connection refused` is refused, 126/127 is unsupported, 124 with no
 * output is a timeout, and anything else is no HTTP response.
 */
export function parsePortHttpProbeOutput(stdout: string): PortHttpProbeOutcome {
  const markerAt = stdout.lastIndexOf(EXIT_MARKER);
  if (markerAt < 0) {
    return { kind: "unsupported", detail: oneLine(stdout) || "no output" };
  }
  const exitText = (stdout.slice(markerAt + EXIT_MARKER.length).split("\n")[0] ?? "").trim();
  // The script prints "\n" before the marker; that newline is not part of the response.
  const response = stdout.slice(0, markerAt).replace(/\n$/, "");
  const status = STATUS_LINE.exec(response.split("\n")[0] ?? "");
  if (status?.[1] !== undefined) {
    return { kind: "response", status: Number(status[1]), body: bodyOf(response) };
  }
  return withoutResponse(oneLine(response), exitText);
}

/** The outcome when no status line came back, from the device's text and `nc`'s exit status. */
function withoutResponse(detail: string, exitText: string): PortHttpProbeOutcome {
  const exit = /^\d+$/.test(exitText) ? Number(exitText) : NaN;
  if (exit === 1 && /connection refused/i.test(detail)) {
    return { kind: "refused" };
  }
  if (MISSING_BINARY_EXITS.has(exit) || Number.isNaN(exit)) {
    return { kind: "unsupported", detail: detail || `exit ${exitText}` };
  }
  if (exit === TIMEOUT_KILLED_EXIT && detail === "") {
    return { kind: "timeout" };
  }
  return { kind: "no_response", detail: detail || "connection closed without a response" };
}

/**
 * Executes host-proxied prototype `request` calls under an egress policy (#12527). Every
 * destination and redirect is checked before connecting to a validated, pinned IP address.
 * Local destinations and daemon ports on private addresses are restricted. Failures are typed outcomes.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { prototypeDaemonPorts } from "./prototypeDaemonPorts";
import { pinnedPrototypeFetch, PrototypeResponseTooLargeError } from "./prototypePinnedTransport";
import {
  checkUrl,
  destinationPort,
  forbiddenHeaderOf,
  StrictEgressPolicy,
  type EgressPolicy,
  type HostResolver,
  type ResolvedHostAddress,
} from "./prototypeEgressPolicy";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import {
  DEFAULT_PROTOTYPE_REQUEST_TIMEOUT_MS,
  MAX_PROTOTYPE_REQUEST_TIMEOUT_MS,
  MAX_PROTOTYPE_RESPONSE_BYTES,
} from "./prototypeRequestLimits";
import type {
  PrototypeRequestErrorCode,
  PrototypeRequestJson,
  PrototypeRequestMethod,
} from "./prototypeRequestProtocol";

export interface PrototypeHttpRequest {
  method: PrototypeRequestMethod;
  url: string;
  headers?: Record<string, string>;
  body?: PrototypeRequestJson;
  timeoutMs?: number;
}

export type PrototypeHttpOutcome =
  | {
      ok: true;
      status: number;
      headers: Record<string, string>;
      body: PrototypeRequestJson | null;
      durationMs: number;
    }
  | {
      ok: false;
      error: { code: PrototypeRequestErrorCode; message: string };
      durationMs: number;
    };

export interface PrototypeHttpExecutor {
  /** Aborting `signal` ends the call with a `cancelled` outcome. */
  execute(request: PrototypeHttpRequest, signal: AbortSignal): Promise<PrototypeHttpOutcome>;
}

/** The URL is normalized; transports must connect only to `pinned`, preserving the URL's authority. */
export type PrototypeFetch = (
  url: string,
  init: RequestInit,
  pinned: ResolvedHostAddress,
  maxResponseBytes: number,
) => Promise<Response>;

export interface FetchPrototypeHttpExecutorOptions {
  fetch?: PrototypeFetch;
  policy?: EgressPolicy;
  resolver?: HostResolver;
  timer: Pick<Timer, "setTimeout" | "clearTimeout" | "now">;
  maxResponseBytes?: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECT_HOPS = 5;

const BODYLESS_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);
const REQUEST_BODY_HEADERS = new Set([
  "content-type",
  "content-encoding",
  "content-language",
  "content-location",
]);

/**
 * The JSON text with every object's keys in sorted (UTF-16 code unit) order, recursively: the
 * canonical body serialization shared by every runtime, whatever order the spec authored them in.
 * It is built as text because a JS object lists integer-like keys first, whatever their order.
 */
function canonicalJson(value: PrototypeRequestJson): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const members = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value);
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

function isConnectionRefused(error: unknown): boolean {
  const record = error as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = record?.code ?? record?.cause?.code;
  return code === "ECONNREFUSED" || code === "ConnectionRefused";
}

/** Markers that cannot collide with a body: a raw-text body may be any string, even `too_large`. */
const TOO_LARGE = Symbol("too_large");
const LITERAL_NULL = Symbol("literal_null");

/** A number token such as `1e400` parses to Infinity, which JSON text cannot carry. */
function hasNonFiniteNumber(value: PrototypeRequestJson): boolean {
  if (typeof value === "number") {
    return !Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.some(hasNonFiniteNumber);
  }
  return (
    typeof value === "object" && value !== null && Object.values(value).some(hasNonFiniteNumber)
  );
}

function parseBody(text: string): PrototypeRequestJson | null | typeof LITERAL_NULL {
  if (text.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as PrototypeRequestJson;
    if (hasNonFiniteNumber(parsed)) {
      // Not representable as JSON on the wire: like the device transports, the response carries the raw text.
      return text;
    }
    // `null` on the wire means "empty body", so a JSON `null` body is reported apart.
    return parsed === null ? LITERAL_NULL : parsed;
  } catch (error) {
    // Not JSON is a supported shape: the response carries the raw string.
    logger.debug("[PrototypeHttpExecutor] body is not JSON.");
    return text;
  }
}

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const FORBIDDEN_HEADER_VALUE = /[\0\r\n]/;

/** RFC 9110 field syntax, checked before fetch so the outcome is `invalid_request`, not `network`. */
function headerProblemOf(headers: Record<string, string> | undefined): string | undefined {
  if (forbiddenHeaderOf(headers) !== undefined) {
    return "A request header is not permitted.";
  }
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (!HEADER_NAME.test(name)) {
      return "Header name is not an HTTP token.";
    }
    if (FORBIDDEN_HEADER_VALUE.test(value)) {
      return "A header value contains a CR, LF or NUL character.";
    }
  }
  return undefined;
}

/** Checks that need no network, so their outcome is deterministic. */
function requestProblemOf(
  request: PrototypeHttpRequest,
): { code: PrototypeRequestErrorCode; message: string } | undefined {
  const urlProblem = urlProblemOf(request.url);
  if (urlProblem !== undefined) {
    return { code: "invalid_url", message: urlProblem };
  }
  const headerProblem = headerProblemOf(request.headers);
  return headerProblem === undefined
    ? undefined
    : { code: "invalid_request", message: headerProblem };
}

function urlProblemOf(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:"
      ? undefined
      : `Only http and https URLs are supported, got ${url.protocol}`;
  } catch (error) {
    // The parse failure is the finding: report it as the typed invalid_url outcome.
    logger.debug("[PrototypeHttpExecutor] URL parse failed.");
    return "Not an absolute HTTP URL.";
  }
}

function redirectedRequest(
  request: PrototypeHttpRequest,
  status: number,
  from: URL,
  to: URL,
): PrototypeHttpRequest {
  // Arbitrary authored headers may carry credentials; generated body headers are rebuilt.
  const redirected = {
    ...request,
    headers: from.origin === to.origin ? request.headers : undefined,
  };
  const rewrite =
    ((status === 301 || status === 302) && request.method === "POST") ||
    (status === 303 && !BODYLESS_METHODS.has(request.method));
  if (!rewrite) {
    return redirected;
  }
  const headers =
    redirected.headers === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(redirected.headers).filter(
            ([name]) => !REQUEST_BODY_HEADERS.has(name.toLowerCase()),
          ),
        );
  return { ...redirected, method: "GET", body: undefined, headers };
}

function redirectUrl(location: string, base: URL): URL | undefined {
  try {
    return new URL(location, base);
  } catch (error) {
    // Invalid Location is an expected response shape, reported as a typed invalid_response.
    logger.debug("[PrototypeHttpExecutor] redirect URL parse failed.");
    return undefined;
  }
}

function failed(
  code: PrototypeRequestErrorCode,
  message: string,
  durationMs: number,
): PrototypeHttpOutcome {
  return { ok: false, error: { code, message }, durationMs };
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export class FetchPrototypeHttpExecutor implements PrototypeHttpExecutor {
  private readonly fetchImpl: PrototypeFetch;
  private readonly maxBytes: number;
  private readonly policy: EgressPolicy;
  private readonly resolver: HostResolver;

  constructor(private readonly options: FetchPrototypeHttpExecutorOptions) {
    this.fetchImpl = options.fetch ?? pinnedPrototypeFetch;
    this.maxBytes = options.maxResponseBytes ?? MAX_PROTOTYPE_RESPONSE_BYTES;
    this.policy = options.policy ?? new StrictEgressPolicy(prototypeDaemonPorts);
    this.resolver =
      options.resolver ?? ((hostname) => lookup(hostname, { all: true, verbatim: true }));
  }

  async execute(request: PrototypeHttpRequest, signal: AbortSignal): Promise<PrototypeHttpOutcome> {
    const { timer } = this.options;
    const startedAt = timer.now();
    const fail = (code: PrototypeRequestErrorCode, message: string): PrototypeHttpOutcome => ({
      ok: false,
      error: { code, message },
      durationMs: timer.now() - startedAt,
    });

    const problem = requestProblemOf(request);
    if (problem !== undefined) {
      return fail(problem.code, problem.message);
    }
    if (signal.aborted) {
      return fail("cancelled", "Request was cancelled before it started.");
    }

    const timeoutMs = Math.min(
      request.timeoutMs ?? DEFAULT_PROTOTYPE_REQUEST_TIMEOUT_MS,
      MAX_PROTOTYPE_REQUEST_TIMEOUT_MS,
    );
    const timeoutController = new AbortController();
    let timedOut = false;
    const handle = timer.setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, timeoutMs);
    const combined = AbortSignal.any([signal, timeoutController.signal]);

    try {
      const result = await this.fetchResponse(request, combined, startedAt);
      if (!("response" in result)) {
        return result;
      }
      return await this.outcomeOf(result.response, result.method, combined, startedAt);
    } catch (error) {
      // Transport error text may contain query strings or credentials; retain only its category.
      const refused = isConnectionRefused(error);
      logger.warn("[PrototypeHttpExecutor] request could not complete.", {
        connectionRefused: refused,
        aborted: combined.aborted,
        timedOut,
      });
      if (combined.aborted) {
        return timedOut
          ? fail("timeout", `Request timed out after ${timeoutMs}ms.`)
          : fail("cancelled", "Request was cancelled.");
      }
      if (refused) {
        return fail("connection_refused", "Connection refused.");
      }
      if (error instanceof PrototypeResponseTooLargeError) {
        return fail("too_large", `Response body exceeds ${this.maxBytes} bytes.`);
      }
      return fail("network", "The request could not complete.");
    } finally {
      timer.clearTimeout(handle);
    }
  }

  /** Checks and resolves each hop once, then passes only a validated IP to the transport. */
  private async fetchResponse(
    original: PrototypeHttpRequest,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<{ response: Response; method: PrototypeRequestMethod } | PrototypeHttpOutcome> {
    let request = original;
    let url = new URL(request.url);
    const fail = (code: PrototypeRequestErrorCode, message: string) =>
      failed(code, message, this.options.timer.now() - startedAt);
    for (let hop = 0; ; hop++) {
      signal.throwIfAborted();
      const problem = requestProblemOf({ ...request, url: url.href });
      if (problem !== undefined) {
        return fail(problem.code, problem.message);
      }
      const pinned = await this.pinDestination(url, signal);
      if ("code" in pinned) {
        return fail(pinned.code, pinned.message);
      }
      signal.throwIfAborted();
      const response = await this.fetchImpl(
        url.href,
        this.requestInit(request, signal),
        pinned,
        this.maxBytes,
      );
      if (!REDIRECT_STATUSES.has(response.status)) {
        return { response, method: request.method };
      }
      await response.body?.cancel();
      if (hop === MAX_REDIRECT_HOPS) {
        return fail("network", "Too many redirects.");
      }
      const location = response.headers.get("location");
      if (!location) {
        return fail("invalid_response", "Redirect response has no Location header.");
      }
      const next = redirectUrl(location, url);
      if (next === undefined) {
        return fail("invalid_response", "Redirect Location is not a valid URL.");
      }
      if (url.protocol === "https:" && next.protocol === "http:") {
        return fail("blocked_destination", "The destination is not permitted: scheme downgrade.");
      }
      request = redirectedRequest(request, response.status, url, next);
      url = next;
    }
  }

  private async pinDestination(
    url: URL,
    signal: AbortSignal,
  ): Promise<ResolvedHostAddress | { code: PrototypeRequestErrorCode; message: string }> {
    if (url.username || url.password) {
      return { code: "invalid_request", message: "URL credentials are not permitted." };
    }
    const blocked = checkUrl(url, this.policy);
    if (blocked !== undefined) {
      return { code: "blocked_destination", message: blocked };
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const literalFamily = isIP(hostname);
    const addresses = literalFamily
      ? [{ address: hostname, family: literalFamily }]
      : await raceWithDeadline(() => this.resolver(hostname), {
          timer: this.options.timer,
          signal,
          label: "Prototype destination resolution",
        });
    signal.throwIfAborted();
    if (addresses.length === 0) {
      return { code: "network", message: "The destination did not resolve to an address." };
    }
    if (
      addresses.some(
        ({ address, family }) =>
          !isIP(address) ||
          isIP(address) !== family ||
          !this.policy.permitsAddress(address, destinationPort(url)),
      )
    ) {
      return { code: "blocked_destination", message: "The destination is not permitted." };
    }
    return addresses[0]!;
  }

  /** The outcome of an answered request: the status decides before any body is consumed. */
  private async outcomeOf(
    response: Response,
    method: PrototypeRequestMethod,
    signal: AbortSignal,
    startedAt: number,
  ): Promise<PrototypeHttpOutcome> {
    const durationMs = (): number => this.options.timer.now() - startedAt;
    const headers = Object.fromEntries(response.headers.entries());
    if (response.status < 200 || response.status > 299) {
      // The status decides the outcome (`http_error`) and a non-2xx body is never used, so it is
      // neither read nor capped: an oversized error page must not be reported as `too_large`.
      await response.body?.cancel();
      return { ok: true, status: response.status, headers, body: null, durationMs: durationMs() };
    }
    const body = await this.readBody(response, method, signal);
    if (body === TOO_LARGE) {
      return failed("too_large", `Response body exceeds ${this.maxBytes} bytes.`, durationMs());
    }
    if (body === LITERAL_NULL) {
      return failed(
        "invalid_response",
        "A response body of JSON null cannot be stored in /data.",
        durationMs(),
      );
    }
    return { ok: true, status: response.status, headers, body, durationMs: durationMs() };
  }

  private requestInit(request: PrototypeHttpRequest, signal: AbortSignal): RequestInit {
    const headers = { ...request.headers };
    let body: string | undefined;
    if (request.body !== undefined && !BODYLESS_METHODS.has(request.method)) {
      if (typeof request.body === "string") {
        body = request.body;
      } else {
        body = canonicalJson(request.body);
        if (!hasHeader(headers, "content-type")) {
          headers["Content-Type"] = "application/json";
        }
      }
    }
    return { method: request.method, headers, body, signal, redirect: "manual" };
  }

  /** Reads a 2xx body incrementally and stops as soon as the cap is crossed. */
  private async readBody(
    response: Response,
    method: PrototypeRequestMethod,
    signal: AbortSignal,
  ): Promise<PrototypeRequestJson | null | typeof TOO_LARGE | typeof LITERAL_NULL> {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > this.maxBytes) {
      await response.body?.cancel();
      return TOO_LARGE;
    }
    if (method === "HEAD" || response.body === null) {
      return null;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await raceWithDeadline(() => reader.read(), {
        timer: this.options.timer,
        signal,
        label: "Prototype response body",
      });
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > this.maxBytes) {
        await reader.cancel();
        return TOO_LARGE;
      }
      chunks.push(value);
    }
    return parseBody(new TextDecoder().decode(concat(chunks, total)));
  }
}

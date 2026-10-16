/**
 * Executes the HTTP call behind a host-proxied prototype `request` (#12527). Forwards to any
 * absolute http/https URL: there is deliberately no allowlist. Never throws; every failure is a
 * typed outcome.
 */
import { errorMessage } from "../../utils/describeUnknownError";
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

export type PrototypeFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface FetchPrototypeHttpExecutorOptions {
  fetch?: PrototypeFetch;
  timer: Pick<Timer, "setTimeout" | "clearTimeout" | "now">;
  maxResponseBytes?: number;
}

const BODYLESS_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

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

function parseBody(text: string): PrototypeRequestJson | null | typeof LITERAL_NULL {
  if (text.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as PrototypeRequestJson;
    // `null` on the wire means "empty body", so a JSON `null` body is reported apart.
    return parsed === null ? LITERAL_NULL : parsed;
  } catch (error) {
    // Not JSON is a supported shape: the response carries the raw string.
    logger.debug(`[PrototypeHttpExecutor] body is not JSON: ${errorMessage(error)}`);
    return text;
  }
}

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const FORBIDDEN_HEADER_VALUE = /[\0\r\n]/;

/** RFC 9110 field syntax, checked before fetch so the outcome is `invalid_request`, not `network`. */
function headerProblemOf(headers: Record<string, string> | undefined): string | undefined {
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (!HEADER_NAME.test(name)) {
      return `Header name is not an HTTP token: ${JSON.stringify(name)}`;
    }
    if (FORBIDDEN_HEADER_VALUE.test(value)) {
      return `Header ${name} has a value with a CR, LF or NUL character`;
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
    logger.debug(`[PrototypeHttpExecutor] URL parse failed: ${errorMessage(error)}`);
    return `Not an absolute URL: ${raw}`;
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

  constructor(private readonly options: FetchPrototypeHttpExecutorOptions) {
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.maxBytes = options.maxResponseBytes ?? MAX_PROTOTYPE_RESPONSE_BYTES;
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
      const response = await this.fetchImpl(request.url, this.requestInit(request, combined));
      return await this.outcomeOf(response, request.method, combined, startedAt);
    } catch (error) {
      if (combined.aborted) {
        return timedOut
          ? fail("timeout", `Request timed out after ${timeoutMs}ms.`)
          : fail("cancelled", "Request was cancelled.");
      }
      if (isConnectionRefused(error)) {
        return fail("connection_refused", `Connection refused: ${request.url}`);
      }
      logger.warn(`[PrototypeHttpExecutor] request failed: ${errorMessage(error)}`, error);
      return fail("network", errorMessage(error));
    } finally {
      timer.clearTimeout(handle);
    }
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
        body = JSON.stringify(request.body);
        if (!hasHeader(headers, "content-type")) {
          headers["Content-Type"] = "application/json";
        }
      }
    }
    return { method: request.method, headers, body, signal, redirect: "follow" };
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
      const { done, value } = await reader.read();
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

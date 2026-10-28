/**
 * Routes requests addressed to the reserved mock origin (#14271) to the session's mock backends and
 * everything else to the real executor. A mock request never reaches DNS, the egress policy or a
 * socket, so the unfiltered `fetch` path is not involved.
 */
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type { Timer } from "../../utils/SystemTimer";
import type {
  PrototypeHttpExecutor,
  PrototypeHttpOutcome,
  PrototypeHttpRequest,
} from "./PrototypeHttpExecutor";
import type { PrototypeMockBackendRegistry } from "./PrototypeMockBackendRegistry";
import { mockTargetOf } from "./prototypeMockOrigin";
import type { MockResponse } from "./PrototypeMockBackend";
import {
  DEFAULT_PROTOTYPE_REQUEST_TIMEOUT_MS,
  MAX_PROTOTYPE_REQUEST_TIMEOUT_MS,
  MAX_PROTOTYPE_RESPONSE_BYTES,
} from "./prototypeRequestLimits";
import type { PrototypeRequestJson } from "./prototypeRequestProtocol";

/** A raw text body that is JSON is parsed, as a real server's JSON body would be on the device. */
function requestBody(body: PrototypeRequestJson | undefined): PrototypeRequestJson | undefined {
  if (typeof body !== "string") {
    return body;
  }
  try {
    return JSON.parse(body) as PrototypeRequestJson;
  } catch (error) {
    // A non-JSON string body stays a string; the engine then rejects it where an object is needed.
    logger.debug("[PrototypeMock] request body is not JSON.");
    return body;
  }
}

/** Rejection marker for the request deadline, so it cannot be mistaken for any other failure. */
const TIMED_OUT = Symbol("mock request timed out");

export class MockRoutingPrototypeHttpExecutor implements PrototypeHttpExecutor {
  constructor(
    private readonly inner: PrototypeHttpExecutor,
    private readonly registry: PrototypeMockBackendRegistry,
    private readonly timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">,
  ) {}

  async execute(request: PrototypeHttpRequest, signal: AbortSignal): Promise<PrototypeHttpOutcome> {
    const target = mockTargetOf(request.url);
    if (target === undefined) {
      return this.inner.execute(request, signal);
    }
    const startedAt = this.timer.now();
    const durationMs = () => this.timer.now() - startedAt;
    const backend = this.registry.get(target.backendId);
    if (backend === undefined) {
      return {
        ok: false,
        error: {
          code: "network",
          message: `No mock backend "${target.backendId}" is defined.`,
        },
        durationMs: durationMs(),
      };
    }
    if (signal.aborted) {
      return {
        ok: false,
        error: { code: "cancelled", message: "Request was cancelled before it started." },
        durationMs: durationMs(),
      };
    }
    const timeoutMs = Math.min(
      request.timeoutMs ?? DEFAULT_PROTOTYPE_REQUEST_TIMEOUT_MS,
      MAX_PROTOTYPE_REQUEST_TIMEOUT_MS,
    );
    // The engine stops at the deadline too, so a request that timed out or was cancelled while it
    // waited on latency never writes to the shared backend afterwards.
    const stop = new AbortController();
    const engineSignal = AbortSignal.any([signal, stop.signal]);
    let response: MockResponse;
    try {
      response = await raceWithDeadline(
        () =>
          backend.answer(
            {
              method: request.method,
              path: target.path,
              query: target.query,
              body: requestBody(request.body),
            },
            engineSignal,
          ),
        {
          timer: this.timer,
          timeoutMs,
          signal,
          label: "Mock request",
          timeoutError: () => TIMED_OUT,
          onTimeout: () => stop.abort(),
        },
      );
    } catch (error) {
      return this.failure(error, signal, timeoutMs, durationMs());
    }
    if (Buffer.byteLength(JSON.stringify(response.body)) > MAX_PROTOTYPE_RESPONSE_BYTES) {
      return {
        ok: false,
        error: {
          code: "too_large",
          message: `Response body exceeds ${MAX_PROTOTYPE_RESPONSE_BYTES} bytes.`,
        },
        durationMs: durationMs(),
      };
    }
    return {
      ok: true,
      status: response.status,
      headers: response.headers,
      body: request.method === "HEAD" ? null : response.body,
      durationMs: durationMs(),
    };
  }

  private failure(
    error: unknown,
    signal: AbortSignal,
    timeoutMs: number,
    durationMs: number,
  ): PrototypeHttpOutcome {
    if (error === TIMED_OUT) {
      return {
        ok: false,
        error: { code: "timeout", message: `Request timed out after ${timeoutMs}ms.` },
        durationMs,
      };
    }
    if (signal.aborted) {
      return {
        ok: false,
        error: { code: "cancelled", message: "Request was cancelled." },
        durationMs,
      };
    }
    logger.warn(`[PrototypeMock] backend failed: ${errorMessage(error)}`, error);
    return {
      ok: false,
      error: { code: "network", message: "The mock backend failed." },
      durationMs,
    };
  }
}

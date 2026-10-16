import { applyPrototypeRequestOutcome } from "../../../src/features/prototype/prototypeRequestOutcome";
import { describe, expect, test } from "bun:test";
import {
  FetchPrototypeHttpExecutor,
  type PrototypeFetch,
  type PrototypeHttpExecutor,
  type PrototypeHttpOutcome,
  type PrototypeHttpRequest,
} from "../../../src/features/prototype/PrototypeHttpExecutor";
import { PrototypeRequestCoordinator } from "../../../src/features/prototype/PrototypeRequestCoordinator";
import { PrototypeEventCoordinator } from "../../../src/features/prototype/PrototypeEventCoordinator";
import { InMemoryPrototypeStatusStore } from "../../../src/features/prototype/PrototypeStatusStore";
import {
  createPrototypeRequestHost,
  webSocketResponseSender,
} from "../../../src/features/prototype/prototypeRequestHandler";
import {
  MAX_PROTOTYPE_REQUEST_TIMEOUT_MS,
  MAX_PROTOTYPE_REQUESTS_IN_FLIGHT,
} from "../../../src/features/prototype/prototypeRequestLimits";
import {
  prototypeResponseMessageSchema,
  type PrototypeResponseMessage,
} from "../../../src/features/prototype/prototypeRequestProtocol";
import { FakeTimer } from "../../fakes/FakeTimer";

const request: PrototypeHttpRequest = { method: "GET", url: "http://localhost:8080/feed" };
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function body(text: string, init: ResponseInit = {}): Response {
  return new Response(text, init);
}

/** A fetch that never answers and rejects like the runtime when its signal aborts. */
const hangingFetch: PrototypeFetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });

function executorFor(
  fetchImpl: PrototypeFetch,
  timer = new FakeTimer(),
  maxResponseBytes?: number,
) {
  return {
    timer,
    executor: new FetchPrototypeHttpExecutor({ fetch: fetchImpl, timer, maxResponseBytes }),
  };
}

function failureCode(outcome: PrototypeHttpOutcome): string | undefined {
  return outcome.ok ? undefined : outcome.error.code;
}

const signal = () => new AbortController().signal;

describe("FetchPrototypeHttpExecutor", () => {
  test("returns status, headers and parsed JSON", async () => {
    const { executor } = executorFor(async () =>
      body('{"items":[1,2]}', { status: 201, headers: { "x-id": "7" } }),
    );
    expect(await executor.execute(request, signal())).toMatchObject({
      ok: true,
      status: 201,
      body: { items: [1, 2] },
      headers: { "x-id": "7" },
      durationMs: 0,
    });
  });

  test("returns a non-JSON body as a string", async () => {
    const { executor } = executorFor(async () => body("plain text"));
    expect(await executor.execute(request, signal())).toMatchObject({
      ok: true,
      body: "plain text",
    });
  });

  test("sends JSON bodies with a content type", async () => {
    let seen: RequestInit | undefined;
    const { executor } = executorFor(async (_url, init) => {
      seen = init;
      return body("{}");
    });
    await executor.execute(
      { method: "POST", url: request.url, body: { state: "draft" } },
      signal(),
    );
    expect(seen?.body).toBe('{"state":"draft"}');
    expect(seen?.headers).toMatchObject({ "Content-Type": "application/json" });
  });

  test("times out through the timer seam", async () => {
    const { executor, timer } = executorFor(hangingFetch);
    const pending = executor.execute({ ...request, timeoutMs: 500 }, signal());
    timer.advanceTime(500);
    expect(failureCode(await pending)).toBe("timeout");
  });

  test("clamps the timeout to the maximum", async () => {
    const { executor, timer } = executorFor(hangingFetch);
    const pending = executor.execute({ ...request, timeoutMs: 999_999 }, signal());
    timer.advanceTime(MAX_PROTOTYPE_REQUEST_TIMEOUT_MS);
    expect(failureCode(await pending)).toBe("timeout");
  });

  test("aborts an oversize body once it crosses the cap", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(40));
      },
      cancel() {
        cancelled = true;
      },
    });
    const { executor } = executorFor(async () => new Response(stream), new FakeTimer(), 100);
    expect(failureCode(await executor.execute(request, signal()))).toBe("too_large");
    expect(cancelled).toBe(true);
  });

  test("rejects an oversize content-length without reading", async () => {
    const { executor } = executorFor(
      async () => body("x", { headers: { "content-length": "1000" } }),
      new FakeTimer(),
      100,
    );
    expect(failureCode(await executor.execute(request, signal()))).toBe("too_large");
  });

  test("a non-2xx status is an http outcome even when its body is over the cap", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(40));
      },
      cancel() {
        cancelled = true;
      },
    });
    const { executor } = executorFor(
      async () =>
        new Response(stream, {
          status: 500,
          headers: { "content-length": "1000", "x-id": "9" },
        }),
      new FakeTimer(),
      100,
    );
    const outcome = await executor.execute(request, signal());
    expect(outcome).toMatchObject({
      ok: true,
      status: 500,
      headers: { "x-id": "9" },
      body: null,
    });
    expect(cancelled).toBe(true);
    const response = { type: "prototype_response" as const, requestId: "r", ...outcome };
    expect(applyPrototypeRequestOutcome({}, "/data/feed", response).meta.error).toEqual({
      code: "http_error",
      message: "HTTP 500",
    });
  });

  test("a header value with CR, LF or NUL is invalid_request without calling fetch", async () => {
    let called = false;
    const { executor } = executorFor(async () => {
      called = true;
      return body("{}");
    });
    for (const value of ["a\r\nX-Evil: 1", "a\nb", "a\0b"]) {
      const outcome = await executor.execute({ ...request, headers: { "X-A": value } }, signal());
      expect(failureCode(outcome)).toBe("invalid_request");
    }
    const badName = await executor.execute({ ...request, headers: { "bad name": "v" } }, signal());
    expect(failureCode(badName)).toBe("invalid_request");
    expect(called).toBe(false);
  });

  test("a 2xx JSON null body is invalid_response; an empty body is still null", async () => {
    const literal = executorFor(async () => body("null")).executor;
    expect(failureCode(await literal.execute(request, signal()))).toBe("invalid_response");
    const empty = executorFor(async () => body("")).executor;
    expect(await empty.execute(request, signal())).toMatchObject({ ok: true, body: null });
    const word = executorFor(async () => body("too_large")).executor;
    expect(await word.execute(request, signal())).toMatchObject({ ok: true, body: "too_large" });
  });

  test("returns connection_refused as a typed error, not a throw", async () => {
    const { executor } = executorFor(async () => {
      throw Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" });
    });
    expect(failureCode(await executor.execute(request, signal()))).toBe("connection_refused");
  });

  test("returns network for other failures", async () => {
    const { executor } = executorFor(async () => {
      throw new Error("boom");
    });
    expect(failureCode(await executor.execute(request, signal()))).toBe("network");
  });

  test("rejects non-http URLs without calling fetch", async () => {
    let called = false;
    const { executor } = executorFor(async () => {
      called = true;
      return body("");
    });
    for (const url of ["file:///etc/passwd", "/relative", "not a url"]) {
      expect(failureCode(await executor.execute({ ...request, url }, signal()))).toBe(
        "invalid_url",
      );
    }
    expect(called).toBe(false);
  });

  test("allows localhost and private addresses", async () => {
    const urls: string[] = [];
    const { executor } = executorFor(async (url) => {
      urls.push(url);
      return body("{}");
    });
    for (const url of ["http://127.0.0.1:1/", "http://192.168.1.5/x", "http://10.0.2.2:8080/"]) {
      expect((await executor.execute({ ...request, url }, signal())).ok).toBe(true);
    }
    expect(urls).toHaveLength(3);
  });
});

/** An executor whose calls stay pending until their signal aborts. */
class PendingExecutor implements PrototypeHttpExecutor {
  readonly signals: AbortSignal[] = [];
  execute(_request: PrototypeHttpRequest, abort: AbortSignal): Promise<PrototypeHttpOutcome> {
    this.signals.push(abort);
    return new Promise((resolve) => {
      abort.addEventListener("abort", () =>
        resolve({ ok: false, error: { code: "cancelled", message: "x" }, durationMs: 0 }),
      );
    });
  }
}

describe("PrototypeRequestCoordinator", () => {
  test("refuses requests over the per-device limit", async () => {
    const coordinator = new PrototypeRequestCoordinator(new PendingExecutor());
    for (let i = 0; i < MAX_PROTOTYPE_REQUESTS_IN_FLIGHT; i++) {
      void coordinator.run({ deviceId: "d1", prototypeId: "p" }, request);
    }
    expect(failureCode(await coordinator.run({ deviceId: "d1", prototypeId: "p" }, request))).toBe(
      "too_many_in_flight",
    );
    void coordinator.run({ deviceId: "d2", prototypeId: "p" }, request);
    expect(coordinator.inFlightCount("d2")).toBe(1);
    coordinator.cancelDevice("d1");
    coordinator.cancelDevice("d2");
    await flush();
    expect(coordinator.inFlightCount()).toBe(0);
  });

  test("cancelPrototype only ends that prototype's requests", async () => {
    const executor = new PendingExecutor();
    const coordinator = new PrototypeRequestCoordinator(executor);
    const a = coordinator.run({ deviceId: "d", prototypeId: "a" }, request);
    void coordinator.run({ deviceId: "d", prototypeId: "b" }, request);
    coordinator.cancelPrototype("d", "a");
    expect(failureCode(await a)).toBe("cancelled");
    expect(executor.signals.map((s) => s.aborted)).toEqual([true, false]);
    coordinator.cancelDevice("d");
  });

  test("dismissing the prototype cancels its request via the event coordinator", async () => {
    const timer = new FakeTimer();
    const requests = new PrototypeRequestCoordinator(new PendingExecutor());
    const events = new PrototypeEventCoordinator(
      timer,
      new InMemoryPrototypeStatusStore(timer),
      undefined,
      requests,
    );
    events.show({ deviceId: "d" }, "p", { onPrototypeEvent: () => () => {} });
    const pending = requests.run({ deviceId: "d", prototypeId: "p" }, request);
    events.dismiss("d", "p");
    expect(failureCode(await pending)).toBe("cancelled");
  });
});

const frame = {
  type: "prototype_request",
  requestId: "r1",
  prototypeId: "p",
  method: "GET",
  url: "http://localhost/x",
};

describe("prototype request host", () => {
  test("answers a valid frame with a schema-valid prototype_response", async () => {
    const { executor } = executorFor(async () => body('{"ok":true}'));
    const host = createPrototypeRequestHost("d", new PrototypeRequestCoordinator(executor));
    const sent: PrototypeResponseMessage[] = [];
    await host.handleRequest(frame, (response) => sent.push(response));
    expect(sent).toHaveLength(1);
    expect(prototypeResponseMessageSchema.parse(sent[0])).toMatchObject({
      requestId: "r1",
      ok: true,
      body: { ok: true },
    });
  });

  test("answers a malformed frame with invalid_request", async () => {
    const host = createPrototypeRequestHost(
      "d",
      new PrototypeRequestCoordinator(new PendingExecutor()),
    );
    const sent: PrototypeResponseMessage[] = [];
    await host.handleRequest({ requestId: "r2", method: "TRACE" }, (r) => sent.push(r));
    expect(sent[0]).toMatchObject({
      requestId: "r2",
      ok: false,
      error: { code: "invalid_request" },
    });
  });

  test("closing one host leaves another host's request on the same device running", async () => {
    const executor = new PendingExecutor();
    const coordinator = new PrototypeRequestCoordinator(executor);
    const older = createPrototypeRequestHost("d", coordinator);
    const current = createPrototypeRequestHost("d", coordinator);
    const sentByCurrent: PrototypeResponseMessage[] = [];
    const olderDone = older.handleRequest(frame, () => undefined);
    const currentDone = current.handleRequest({ ...frame, requestId: "r2" }, (r) =>
      sentByCurrent.push(r),
    );
    older.handleDisconnect();
    await olderDone;
    expect(executor.signals.map((s) => s.aborted)).toEqual([true, false]);
    expect(coordinator.inFlightCount("d")).toBe(1);
    expect(sentByCurrent).toEqual([]);
    current.handleDisconnect();
    await currentDone;
    expect(coordinator.inFlightCount()).toBe(0);
  });

  test("a cancel frame aborts the fetch, frees the slot and sends no reply", async () => {
    const executor = new PendingExecutor();
    const coordinator = new PrototypeRequestCoordinator(executor);
    const host = createPrototypeRequestHost("d", coordinator);
    const sent: PrototypeResponseMessage[] = [];
    const done = host.handleRequest(frame, (r) => sent.push(r));
    expect(coordinator.inFlightCount("d")).toBe(1);
    host.handleCancel({ type: "prototype_request_cancel", requestId: "r1" });
    await done;
    expect(executor.signals.map((s) => s.aborted)).toEqual([true]);
    expect(coordinator.inFlightCount()).toBe(0);
    expect(sent).toEqual([]);
  });

  test("a cancel from another connection, or for an unknown id, is ignored", async () => {
    const executor = new PendingExecutor();
    const coordinator = new PrototypeRequestCoordinator(executor);
    const owner = createPrototypeRequestHost("d", coordinator);
    const other = createPrototypeRequestHost("d", coordinator);
    const done = owner.handleRequest(frame, () => undefined);
    other.handleCancel({ type: "prototype_request_cancel", requestId: "r1" });
    owner.handleCancel({ type: "prototype_request_cancel", requestId: "nope" });
    owner.handleCancel({ type: "prototype_request_cancel" });
    expect(executor.signals.map((s) => s.aborted)).toEqual([false]);
    expect(coordinator.inFlightCount("d")).toBe(1);
    owner.handleDisconnect();
    await done;
  });

  test("four superseded requests and a fifth all run because cancels free capacity", async () => {
    const executor = new PendingExecutor();
    const coordinator = new PrototypeRequestCoordinator(executor);
    const host = createPrototypeRequestHost("d", coordinator);
    const sent: PrototypeResponseMessage[] = [];
    const runs: Promise<void>[] = [];
    for (let i = 1; i <= MAX_PROTOTYPE_REQUESTS_IN_FLIGHT + 1; i++) {
      runs.push(host.handleRequest({ ...frame, requestId: `r${i}` }, (r) => sent.push(r)));
      if (i <= MAX_PROTOTYPE_REQUESTS_IN_FLIGHT) {
        host.handleCancel({ type: "prototype_request_cancel", requestId: `r${i}` });
      }
    }
    expect(coordinator.inFlightCount("d")).toBe(1);
    expect(sent).toEqual([]);
    host.handleDisconnect();
    await Promise.all(runs);
  });

  test("disconnect cancels the device's requests and a failed reply is swallowed", async () => {
    const coordinator = new PrototypeRequestCoordinator(new PendingExecutor());
    const host = createPrototypeRequestHost("d", coordinator);
    const done = host.handleRequest(frame, () => {
      throw new Error("socket closed");
    });
    host.handleDisconnect();
    await done;
    expect(coordinator.inFlightCount()).toBe(0);
  });
});

describe("webSocketResponseSender", () => {
  const response: PrototypeResponseMessage = {
    type: "prototype_response",
    requestId: "r",
    ok: false,
    error: { code: "cancelled", message: "x" },
    durationMs: 0,
  };

  test("writes JSON to an open socket and throws when closed", () => {
    const written: string[] = [];
    const open = { readyState: WebSocket.OPEN, send: (data: string) => written.push(data) };
    webSocketResponseSender(() => open)(response);
    expect(JSON.parse(written[0])).toMatchObject({ requestId: "r" });
    expect(() => webSocketResponseSender(() => null)(response)).toThrow("not connected");
  });
});

import { describe, expect, test } from "bun:test";
import type { PrototypeChannelOpenRequest } from "../../../src/features/prototype/PrototypeChannelExecutor";
import type { PrototypeFetch } from "../../../src/features/prototype/PrototypeHttpExecutor";
import { SsePrototypeChannelExecutor } from "../../../src/features/prototype/SsePrototypeChannelExecutor";
import { MAX_PROTOTYPE_CHANNEL_FRAME_BYTES } from "../../../src/features/prototype/prototypeChannelLimits";
import { DEFAULT_PROTOTYPE_REQUEST_TIMEOUT_MS } from "../../../src/features/prototype/prototypeRequestLimits";
import { FakeTimer } from "../../fakes/FakeTimer";
import { RecordingSink, settle } from "./prototypeChannelFakes";

const request: PrototypeChannelOpenRequest = {
  kind: "sse",
  url: "https://api.test/trips/1/events",
  headers: { Authorization: "Bearer t" },
};

/** A response whose body the test feeds chunk by chunk. */
class Stream {
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  cancelled = false;
  readonly response: Response;
  constructor(
    status = 200,
    headers: Record<string, string> = { "content-type": "text/event-stream" },
  ) {
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
      cancel: () => {
        this.cancelled = true;
      },
    });
    this.response = new Response(body, { status, headers });
  }
  write(text: string): void {
    this.writeBytes(new TextEncoder().encode(text));
  }
  writeBytes(bytes: Uint8Array): void {
    this.controller.enqueue(bytes);
  }
  end(): void {
    this.controller.close();
  }
}

interface Call {
  url: string;
  headers: Record<string, string>;
  pinned: { address: string; family: number };
  maxBytes: number;
}

function setup(respond: (call: number, calls: Call[]) => Response, resolved = ["8.8.8.8"]) {
  const timer = new FakeTimer();
  const sink = new RecordingSink();
  const controller = new AbortController();
  const calls: Call[] = [];
  const fetch: PrototypeFetch = async (url, init, pinned, maxBytes) => {
    calls.push({ url, headers: init.headers as Record<string, string>, pinned, maxBytes });
    return respond(calls.length, calls);
  };
  const executor = new SsePrototypeChannelExecutor({
    timer,
    fetch,
    resolver: async (hostname) =>
      hostname === "other.test"
        ? [{ address: "1.1.1.1", family: 4 }]
        : resolved.map((address) => ({ address, family: 4 })),
  });
  const open = async (req: PrototypeChannelOpenRequest = request) => {
    const handle = executor.open(req, sink, controller.signal);
    await settle();
    return handle;
  };
  return { timer, sink, controller, calls, open };
}

describe("SsePrototypeChannelExecutor", () => {
  test("sends the stream headers and last event id to the validated address and relays events", async () => {
    const stream = new Stream();
    const { sink, calls, open } = setup(() => stream.response);
    await open({ ...request, lastEventId: "41" });
    expect(calls[0]).toMatchObject({
      url: "https://api.test/trips/1/events",
      pinned: { address: "8.8.8.8", family: 4 },
      headers: {
        Authorization: "Bearer t",
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
        "Last-Event-ID": "41",
      },
    });
    stream.write('event: location\nid: 42\ndata: {"lat":1}\n\nda');
    await settle();
    stream.write("ta: second\n\n");
    stream.end();
    await settle();
    expect(sink.log).toEqual(["opened", "frame", "frame", "closed"]);
    expect(sink.frames).toEqual([
      { event: "location", data: '{"lat":1}', id: "42" },
      { data: "second", id: "42" },
    ]);
    expect(sink.closes).toEqual([{}]);
  });

  test("a multibyte character split across chunks is decoded once", async () => {
    const stream = new Stream();
    const { sink, open } = setup(() => stream.response);
    await open();
    const bytes = new TextEncoder().encode("data: é\n\n");
    const split = bytes.indexOf(0xc3) + 1;
    stream.writeBytes(bytes.slice(0, split));
    await settle();
    stream.writeBytes(bytes.slice(split));
    await settle();
    expect(sink.frames).toEqual([{ data: "é" }]);
  });

  test("a stream is not capped by total size", async () => {
    const { calls, open } = setup(() => new Stream().response);
    await open();
    expect(calls[0]!.maxBytes).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("a non-200 answer is handshake_failed with the status", async () => {
    const { sink, open } = setup(() => new Response("no", { status: 403 }));
    await open();
    expect(sink.log).toEqual(["closed"]);
    expect(sink.closes[0]?.error).toMatchObject({ code: "handshake_failed", status: 403 });
  });

  test("a 200 that is not an event stream is handshake_failed", async () => {
    const { sink, open } = setup(
      () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
    await open();
    expect(sink.closes[0]?.error).toMatchObject({ code: "handshake_failed", status: 200 });
  });

  test("a redirect is re-validated and followed, and credentials stay on the same origin only", async () => {
    const stream = new Stream();
    const { sink, calls, open } = setup((call) =>
      call === 1
        ? new Response(null, { status: 302, headers: { location: "/v2/events" } })
        : call === 2
          ? new Response(null, { status: 307, headers: { location: "https://other.test/e" } })
          : stream.response,
    );
    await open();
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.test/trips/1/events",
      "https://api.test/v2/events",
      "https://other.test/e",
    ]);
    expect(calls[1]!.headers.Authorization).toBe("Bearer t");
    expect(calls[2]!.headers.Authorization).toBeUndefined();
    expect(calls[2]!.headers.Accept).toBe("text/event-stream");
    expect(calls[2]!.pinned.address).toBe("1.1.1.1");
    expect(sink.log).toEqual(["opened"]);
  });

  test("a redirect to loopback, a scheme downgrade and a redirect loop are refused", async () => {
    const loopback = setup(
      () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/x" } }),
    );
    await loopback.open();
    expect(loopback.sink.closes[0]?.error?.code).toBe("blocked_destination");
    expect(loopback.calls).toHaveLength(1);

    const downgrade = setup(
      () => new Response(null, { status: 302, headers: { location: "http://api.test/x" } }),
    );
    await downgrade.open();
    expect(downgrade.sink.closes[0]?.error?.code).toBe("blocked_destination");

    const loop = setup(() => new Response(null, { status: 302, headers: { location: "/again" } }));
    await loop.open();
    expect(loop.sink.closes[0]?.error?.code).toBe("network");
    expect(loop.calls).toHaveLength(6);

    const missing = setup(() => new Response(null, { status: 302 }));
    await missing.open();
    expect(missing.sink.closes[0]?.error?.code).toBe("network");
  });

  test("a loopback DNS answer is blocked before any request", async () => {
    const { sink, calls, open } = setup(() => new Stream().response, ["127.0.0.1"]);
    await open();
    expect(sink.closes[0]?.error?.code).toBe("blocked_destination");
    expect(calls).toEqual([]);
  });

  test("an event above the limit closes with too_large, even before its blank line", async () => {
    const complete = new Stream();
    const a = setup(() => complete.response);
    await a.open();
    complete.write(`data: ${"x".repeat(MAX_PROTOTYPE_CHANNEL_FRAME_BYTES + 1)}\n\n`);
    await settle();
    expect(a.sink.closes[0]?.error?.code).toBe("too_large");
    expect(a.sink.frames).toEqual([]);
    expect(complete.cancelled).toBe(true);

    const open = new Stream();
    const b = setup(() => open.response);
    await b.open();
    open.write(`data: ${"x".repeat(MAX_PROTOTYPE_CHANNEL_FRAME_BYTES + 7)}`);
    await settle();
    expect(b.sink.closes[0]?.error?.code).toBe("too_large");
  });

  test("an event of exactly the limit is delivered", async () => {
    const stream = new Stream();
    const { sink, open } = setup(() => stream.response);
    await open();
    stream.write(`data: ${"x".repeat(MAX_PROTOTYPE_CHANNEL_FRAME_BYTES)}\n\n`);
    await settle();
    expect(sink.frames).toHaveLength(1);
    expect(sink.closes).toEqual([]);
  });

  test("a handshake that never answers times out", async () => {
    const { timer, sink, open } = setup(() => new Stream().response);
    const executorHang = new SsePrototypeChannelExecutor({
      timer,
      resolver: async () => [{ address: "8.8.8.8", family: 4 }],
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    executorHang.open(request, sink, new AbortController().signal);
    await settle();
    timer.advanceTime(DEFAULT_PROTOTYPE_REQUEST_TIMEOUT_MS);
    await settle();
    expect(sink.closes[0]?.error?.code).toBe("timeout");
    void open;
  });

  test("a refused connection is connection_refused and another failure is network", async () => {
    const refused = setup(() => {
      throw Object.assign(new Error("x"), { code: "ECONNREFUSED" });
    });
    await refused.open();
    expect(refused.sink.closes[0]?.error?.code).toBe("connection_refused");

    const other = setup(() => {
      throw new Error("reset");
    });
    await other.open();
    expect(other.sink.closes[0]?.error).toMatchObject({
      code: "network",
      message: "The event stream failed.",
    });
  });

  test("send is unsupported, and a device close ends the stream and reports once", async () => {
    const stream = new Stream();
    const { sink, open } = setup(() => stream.response);
    const handle = await open();
    expect(handle.send("x")).toEqual({ ok: false, reason: "unsupported" });
    handle.close(1000, "done");
    await settle();
    expect(sink.closes).toEqual([{ code: 1000, reason: "done" }]);
    expect(stream.cancelled).toBe(true);
  });

  test("aborting stops reading and reports nothing further", async () => {
    const stream = new Stream();
    const { sink, controller, open } = setup(() => stream.response);
    await open();
    controller.abort();
    await settle();
    expect(sink.log).toEqual(["opened"]);
    expect(stream.cancelled).toBe(true);
  });

  test("refuses a websocket URL and a reserved header without any request", async () => {
    for (const req of [
      { kind: "sse", url: "wss://api.test/x" },
      { kind: "sse", url: "https://api.test/x", headers: { "Last-Event-ID": "1" } },
    ] as const) {
      const { sink, calls, open } = setup(() => new Stream().response);
      await open(req);
      expect(sink.closes[0]?.error?.code).toMatch(/invalid_/);
      expect(calls).toEqual([]);
    }
  });
});

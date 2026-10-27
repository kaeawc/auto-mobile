import { describe, expect, test } from "bun:test";
import { PROTOTYPE_CHANNEL_PING_INTERVAL_MS } from "../../../src/features/prototype/PrototypeWebSocketChannel";
import { WebSocketPrototypeChannelExecutor } from "../../../src/features/prototype/WebSocketPrototypeChannelExecutor";
import type { PrototypeChannelOpenRequest } from "../../../src/features/prototype/PrototypeChannelExecutor";
import {
  MAX_PROTOTYPE_CHANNEL_FRAME_BYTES,
  MAX_PROTOTYPE_CHANNEL_SEND_BYTES,
} from "../../../src/features/prototype/prototypeChannelLimits";
import { DEFAULT_PROTOTYPE_REQUEST_TIMEOUT_MS } from "../../../src/features/prototype/prototypeRequestLimits";
import type { PrototypeChannelErrorCode } from "../../../src/features/prototype/prototypeChannelProtocol";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeSocketFactory, RecordingSink, settle } from "./prototypeChannelFakes";

const request: PrototypeChannelOpenRequest = {
  kind: "websocket",
  url: "wss://chat.test/rooms/1",
  protocols: ["chat.v1"],
  headers: { Authorization: "Bearer t" },
};

function setup(resolve: string[] = ["8.8.8.8"]) {
  const timer = new FakeTimer();
  const sockets = new FakeSocketFactory();
  const sink = new RecordingSink();
  const controller = new AbortController();
  const executor = new WebSocketPrototypeChannelExecutor({
    timer,
    socketFactory: sockets.factory,
    resolver: async () =>
      resolve.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
  });
  const open = async (req: PrototypeChannelOpenRequest = request) => {
    const handle = executor.open(req, sink, controller.signal);
    await settle();
    return handle;
  };
  return { timer, sockets, sink, controller, open };
}

describe("WebSocketPrototypeChannelExecutor", () => {
  test("connects to the validated address with the authored URL, subprotocols and headers", async () => {
    const { sockets, open } = setup(["93.184.216.34"]);
    await open();
    expect(sockets.last.connect).toMatchObject({
      url: "wss://chat.test/rooms/1",
      protocols: ["chat.v1"],
      headers: { Authorization: "Bearer t" },
      pinned: { address: "93.184.216.34", family: 4 },
      maxPayload: MAX_PROTOTYPE_CHANNEL_FRAME_BYTES,
    });
  });

  test("relays open, frames and a normal close in order, then ignores anything after", async () => {
    const { sockets, sink, open } = setup();
    await open();
    sockets.last.events.open("chat.v1");
    sockets.last.events.message("hello");
    sockets.last.events.close(1000, "bye");
    sockets.last.events.message("late");
    sockets.last.events.error(new Error("late"));
    expect(sink.log).toEqual(["opened", "frame", "closed"]);
    expect(sink.opens).toEqual(["chat.v1"]);
    expect(sink.frames).toEqual([{ data: "hello" }]);
    expect(sink.closes).toEqual([{ code: 1000, reason: "bye" }]);
  });

  test("an empty negotiated subprotocol is reported as none", async () => {
    const { sockets, sink, open } = setup();
    await open();
    sockets.last.events.open("");
    expect(sink.opens).toEqual([undefined]);
  });

  test("send writes a text frame once open and is refused before and after", async () => {
    const { sockets, open } = setup();
    const handle = await open();
    expect(handle.send("early")).toEqual({ ok: false, reason: "not_open" });
    sockets.last.events.open("");
    expect(handle.send("hi")).toEqual({ ok: true });
    expect(sockets.last.sent).toEqual(["hi"]);
    expect(handle.send("x".repeat(MAX_PROTOTYPE_CHANNEL_SEND_BYTES + 1))).toEqual({
      ok: false,
      reason: "too_large",
    });
    sockets.last.events.close(1006, "");
    expect(handle.send("after")).toEqual({ ok: false, reason: "not_open" });
  });

  test("a device close sends the close code and reports the peer's close", async () => {
    const { sockets, sink, open } = setup();
    const handle = await open();
    sockets.last.events.open("");
    handle.close(4000, "done");
    expect(sockets.last.closes).toEqual([{ code: 4000, reason: "done" }]);
    expect(sink.closes).toEqual([]);
    sockets.last.events.close(4000, "done");
    expect(sink.closes).toEqual([{ code: 4000, reason: "done" }]);
  });

  test("a handshake redirect or other HTTP answer is handshake_failed with the status", async () => {
    const { sockets, sink, open } = setup();
    await open();
    sockets.last.events.unexpectedResponse(302);
    expect(sink.closes).toEqual([
      { error: expect.objectContaining({ code: "handshake_failed", status: 302 }) },
    ]);
    expect(sockets.last.terminated).toBe(true);
  });

  test("a frame above the limit closes the connection with too_large", async () => {
    const { sockets, sink, open } = setup();
    await open();
    sockets.last.events.open("");
    sockets.last.events.message("é".repeat(MAX_PROTOTYPE_CHANNEL_FRAME_BYTES / 2 + 1));
    expect(sink.frames).toEqual([]);
    expect(sink.closes[0]?.error?.code).toBe("too_large");
    expect(sockets.last.terminated).toBe(true);
  });

  test("a frame the socket itself refused as too large closes with too_large", async () => {
    const { sockets, sink, open } = setup();
    await open();
    sockets.last.events.open("");
    sockets.last.events.tooLarge();
    expect(sink.closes[0]?.error?.code).toBe("too_large");
  });

  test("an exact-limit frame is delivered", async () => {
    const { sockets, sink, open } = setup();
    await open();
    sockets.last.events.open("");
    sockets.last.events.message("a".repeat(MAX_PROTOTYPE_CHANNEL_FRAME_BYTES));
    expect(sink.frames).toHaveLength(1);
  });

  test("a handshake that never completes times out", async () => {
    const { timer, sockets, sink, open } = setup();
    await open();
    timer.advanceTime(DEFAULT_PROTOTYPE_REQUEST_TIMEOUT_MS);
    expect(sink.closes[0]?.error?.code).toBe("timeout");
    expect(sockets.last.terminated).toBe(true);
  });

  test("a resolver that never answers times out and frees the channel without a socket", async () => {
    const { timer, sockets, sink, controller } = setup();
    const executor = new WebSocketPrototypeChannelExecutor({
      timer,
      socketFactory: sockets.factory,
      resolver: () => new Promise(() => {}),
    });
    executor.open(request, sink, controller.signal);
    await settle();
    expect(sink.closes).toEqual([]);
    timer.advanceTime(DEFAULT_PROTOTYPE_REQUEST_TIMEOUT_MS);
    await settle();
    expect(sink.closes).toHaveLength(1);
    expect(sink.closes[0]?.error?.code).toBe("timeout");
    expect(sockets.sockets).toEqual([]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("opening disarms the handshake timeout", async () => {
    const { timer, sockets, sink, open } = setup();
    await open();
    sockets.last.events.open("");
    timer.advanceTime(DEFAULT_PROTOTYPE_REQUEST_TIMEOUT_MS);
    expect(sink.closes).toEqual([]);
    expect(sockets.last.terminated).toBe(false);
  });

  test("pings every interval and a missed pong closes with network", async () => {
    const { timer, sockets, sink, open } = setup();
    await open();
    sockets.last.events.open("");
    timer.advanceTime(PROTOTYPE_CHANNEL_PING_INTERVAL_MS);
    expect(sockets.last.pings).toBe(1);
    sockets.last.events.pong();
    timer.advanceTime(PROTOTYPE_CHANNEL_PING_INTERVAL_MS);
    expect(sockets.last.pings).toBe(2);
    expect(sink.closes).toEqual([]);
    timer.advanceTime(PROTOTYPE_CHANNEL_PING_INTERVAL_MS);
    expect(sink.closes[0]?.error).toMatchObject({ code: "network" });
    expect(sockets.last.terminated).toBe(true);
    expect(timer.getPendingIntervalCount()).toBe(0);
  });

  test("a loopback literal, a loopback DNS answer and localhost are blocked before any socket", async () => {
    for (const [url, answers] of [
      ["ws://127.0.0.1:9/x", ["8.8.8.8"]],
      ["ws://localhost/x", ["8.8.8.8"]],
      ["wss://rebind.test/x", ["8.8.8.8", "127.0.0.1"]],
      ["wss://rebind.test/x", ["::1"]],
    ] as const) {
      const { sockets, sink, open } = setup([...answers]);
      await open({ kind: "websocket", url });
      expect(sink.closes[0]?.error?.code).toBe("blocked_destination");
      expect(sockets.sockets).toEqual([]);
    }
  });

  test("an unresolvable host is a network error", async () => {
    const { sockets, sink, open } = setup([]);
    await open();
    expect(sink.closes[0]?.error?.code).toBe("network");
    expect(sockets.sockets).toEqual([]);
  });

  test("refuses a wrong scheme, forbidden headers and credentials without connecting", async () => {
    const cases: [PrototypeChannelOpenRequest, PrototypeChannelErrorCode][] = [
      [{ kind: "websocket", url: "https://chat.test/x" }, "invalid_url"],
      [{ kind: "websocket", url: "not a url" }, "invalid_url"],
      [
        { kind: "websocket", url: "wss://chat.test/x", headers: { Cookie: "a=b" } },
        "invalid_request",
      ],
      [
        { kind: "websocket", url: "wss://chat.test/x", headers: { "Sec-WebSocket-Key": "k" } },
        "invalid_request",
      ],
      [
        { kind: "websocket", url: "wss://chat.test/x", headers: { "last-event-id": "1" } },
        "invalid_request",
      ],
      [{ kind: "websocket", url: "wss://u:p@chat.test/x" }, "invalid_request"],
    ];
    for (const [req, code] of cases) {
      const { sockets, sink, open } = setup();
      await open(req);
      expect(sink.closes[0]?.error?.code).toBe(code);
      expect(sockets.sockets).toEqual([]);
    }
  });

  test("a socket error reports network, and a refused connection reports connection_refused", async () => {
    const first = setup();
    await first.open();
    first.sockets.last.events.error(new Error("boom"));
    expect(first.sink.closes[0]?.error).toMatchObject({
      code: "network",
      message: "The connection failed.",
    });

    const second = setup();
    await second.open();
    second.sockets.last.events.error(Object.assign(new Error("x"), { code: "ECONNREFUSED" }));
    expect(second.sink.closes[0]?.error?.code).toBe("connection_refused");
  });

  test("aborting ends the connection silently and stops the timers", async () => {
    const { timer, sockets, sink, controller, open } = setup();
    await open();
    sockets.last.events.open("");
    controller.abort();
    sockets.last.events.close(1001, "Cancelled");
    expect(sink.log).toEqual(["opened"]);
    expect(sockets.last.terminated).toBe(true);
    expect(timer.getPendingIntervalCount()).toBe(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("aborting before the destination resolves never creates a socket", async () => {
    const { sockets, sink, controller, open } = setup();
    controller.abort();
    await open();
    expect(sockets.sockets).toEqual([]);
    expect(sink.log).toEqual([]);
  });

  test("closing before the socket exists reports the close without connecting", async () => {
    const { timer, sockets, sink, controller } = setup();
    const executor = new WebSocketPrototypeChannelExecutor({
      timer,
      socketFactory: sockets.factory,
      resolver: () => new Promise(() => {}),
    });
    const handle = executor.open(request, sink, controller.signal);
    handle.close(1000);
    expect(sink.closes).toEqual([{ code: 1000 }]);
    expect(sockets.sockets).toEqual([]);
  });
});

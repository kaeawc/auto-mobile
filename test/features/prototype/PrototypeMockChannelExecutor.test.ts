import { describe, expect, test } from "bun:test";
import type {
  PrototypeChannelExecutor,
  PrototypeChannelHandle,
  PrototypeChannelOpenRequest,
  PrototypeChannelSink,
} from "../../../src/features/prototype/PrototypeChannelExecutor";
import { KindPrototypeChannelExecutor } from "../../../src/features/prototype/PrototypeChannelExecutor";
import { PrototypeMockBackendRegistry } from "../../../src/features/prototype/PrototypeMockBackendRegistry";
import { MockRoutingPrototypeChannelExecutor } from "../../../src/features/prototype/PrototypeMockChannelExecutor";
import { createPrototypeChannelCoordinator } from "../../../src/features/prototype/prototypeChannelWiring";
import { WebSocketPrototypeChannelExecutor } from "../../../src/features/prototype/WebSocketPrototypeChannelExecutor";
import { SsePrototypeChannelExecutor } from "../../../src/features/prototype/SsePrototypeChannelExecutor";
import { MAX_PROTOTYPE_CHANNEL_SEND_BYTES } from "../../../src/features/prototype/prototypeChannelLimits";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeSocketFactory, RecordingSink, settle } from "./prototypeChannelFakes";

class RecordingExecutor implements PrototypeChannelExecutor {
  readonly calls: [PrototypeChannelOpenRequest, PrototypeChannelSink, AbortSignal][] = [];
  readonly handle: PrototypeChannelHandle = { send: () => ({ ok: true }), close: () => {} };
  open(request: PrototypeChannelOpenRequest, sink: PrototypeChannelSink, signal: AbortSignal) {
    this.calls.push([request, sink, signal]);
    return this.handle;
  }
}

class FakeRegistry extends PrototypeMockBackendRegistry {
  readonly lookups: string[] = [];
  override get(id: string) {
    this.lookups.push(id);
    return super.get(id);
  }
}

function setup() {
  const timer = new FakeTimer();
  const registry = new FakeRegistry({ ids: new FakeIdGenerator(), timer });
  const inner = new RecordingExecutor();
  const sink = new RecordingSink();
  const controller = new AbortController();
  return {
    timer,
    registry,
    inner,
    sink,
    controller,
    executor: new MockRoutingPrototypeChannelExecutor(inner, registry),
  };
}

const mockRequests: PrototypeChannelOpenRequest[] = [
  { kind: "websocket", url: "ws://shop.mock.automobile.invalid/room" },
  { kind: "websocket", url: "wss://shop.mock.automobile.invalid/room" },
  { kind: "sse", url: "http://shop.mock.automobile.invalid/events" },
  { kind: "sse", url: "https://shop.mock.automobile.invalid/events" },
];

describe("MockRoutingPrototypeChannelExecutor", () => {
  test.each(mockRequests)("unknown backend closes with network for $url", (request) => {
    const { executor, inner, sink, controller, registry } = setup();
    const handle = executor.open(request, sink, controller.signal);
    expect(inner.calls).toEqual([]);
    expect(registry.lookups).toEqual(["shop"]);
    expect(sink.closes).toEqual([
      { error: { code: "network", message: 'No mock backend "shop" is defined.' } },
    ]);
    expect(handle.send("hello")).toEqual({ ok: false, reason: "not_open" });
    handle.close();
    expect(sink.log).toEqual(["closed"]);
  });

  test.each(mockRequests)("a path no room matches is refused with 404 for $url", (request) => {
    const { executor, inner, sink, controller, registry } = setup();
    registry.define("shop", { rooms: [{ path: "/other" }] });
    executor.open(request, sink, controller.signal);
    expect(inner.calls).toEqual([]);
    expect(sink.log).toEqual(["closed"]);
    expect(sink.closes[0]?.error).toMatchObject({ code: "handshake_failed", status: 404 });
  });

  test("a scheme that does not fit the kind is invalid_url, as for a real host", () => {
    const { executor, sink, controller, registry } = setup();
    registry.define("shop", { rooms: [{ path: "/room" }] });
    executor.open(
      { kind: "sse", url: "wss://shop.mock.automobile.invalid/room" },
      sink,
      controller.signal,
    );
    expect(sink.closes[0]?.error?.code).toBe("invalid_url");
  });

  test("a websocket opens, gets onConnect frames, relays to its peer and closes with the device's code", () => {
    const { executor, controller, registry } = setup();
    registry.define("shop", {
      rooms: [{ path: "/rooms/:id", relay: true, onConnect: [{ hello: "{params.id}" }] }],
    });
    const url = "wss://shop.mock.automobile.invalid/rooms/a";
    const a = new RecordingSink();
    const b = new RecordingSink();
    const handleA = executor.open(
      { kind: "websocket", url, protocols: ["chat"] },
      a,
      controller.signal,
    );
    executor.open({ kind: "websocket", url }, b, controller.signal);
    expect(a.log).toEqual(["opened", "frame"]);
    expect(a.opens).toEqual(["chat"]);
    expect(a.frames).toEqual([{ data: '{"hello":"a"}' }]);
    expect(handleA.send("msg")).toEqual({ ok: true });
    expect(b.frames.at(-1)).toEqual({ data: "msg" });
    handleA.close(4000, "done");
    expect(a.closes).toEqual([{ code: 4000, reason: "done" }]);
    expect(handleA.send("late")).toEqual({ ok: false, reason: "not_open" });
    expect(registry.get("shop")!.publish("/rooms/a", "x")).toBe(1);
  });

  test("an SSE channel receives publishes and cannot send", () => {
    const { executor, sink, controller, registry } = setup();
    registry.define("shop", { rooms: [{ path: "/events" }] });
    const handle = executor.open(
      { kind: "sse", url: "https://shop.mock.automobile.invalid/events" },
      sink,
      controller.signal,
    );
    registry.get("shop")!.publish("/events", { n: 1 });
    expect(sink.frames).toEqual([{ data: '{"n":1}' }]);
    expect(handle.send("x")).toEqual({ ok: false, reason: "unsupported" });
  });

  test("aborting leaves the room silently; clearing the backend closes open channels", () => {
    const { executor, registry } = setup();
    registry.define("shop", { rooms: [{ path: "/r" }] });
    const url = "wss://shop.mock.automobile.invalid/r";
    const aborted = new AbortController();
    const quiet = new RecordingSink();
    executor.open({ kind: "websocket", url }, quiet, aborted.signal);
    aborted.abort();
    const open = new RecordingSink();
    executor.open({ kind: "websocket", url }, open, new AbortController().signal);
    expect(registry.get("shop")!.publish("/r", "x")).toBe(1);
    registry.clear("shop");
    expect(quiet.log).toEqual(["opened"]);
    expect(open.closes).toEqual([{ code: 1001, reason: 'Mock backend "shop" was cleared.' }]);
  });

  test("a device send over the send cap is refused", () => {
    const { executor, sink, controller, registry } = setup();
    registry.define("shop", { rooms: [{ path: "/r", echo: true }] });
    const handle = executor.open(
      { kind: "websocket", url: "wss://shop.mock.automobile.invalid/r" },
      sink,
      controller.signal,
    );
    expect(handle.send("x".repeat(MAX_PROTOTYPE_CHANNEL_SEND_BYTES + 1))).toEqual({
      ok: false,
      reason: "too_large",
    });
  });

  test.each(["wss://example.com/room", "https://example.com/events", "not a URL"])(
    "delegates a non-mock request unchanged: %s",
    (url) => {
      const { executor, inner, sink, controller, registry } = setup();
      const request: PrototypeChannelOpenRequest = {
        kind: "websocket",
        url,
        protocols: ["chat"],
        headers: { Authorization: "token" },
      };
      expect(executor.open(request, sink, controller.signal)).toBe(inner.handle);
      expect(inner.calls[0]?.[0]).toBe(request);
      expect(inner.calls[0]?.[1]).toBe(sink);
      expect(inner.calls[0]?.[2]).toBe(controller.signal);
      expect(registry.lookups).toEqual([]);
    },
  );

  test("an already aborted signal ends silently before routing", () => {
    const { executor, inner, sink, controller, registry } = setup();
    controller.abort();
    for (const request of [...mockRequests, { kind: "sse", url: "https://example.com" } as const]) {
      const handle = executor.open(request, sink, controller.signal);
      expect(handle.send("hello")).toEqual({ ok: false, reason: "not_open" });
      handle.close();
    }
    expect([inner.calls, registry.lookups, sink.log]).toEqual([[], [], []]);
  });

  test("mock origins bypass real transports' DNS, policy and socket seams", async () => {
    const { timer, registry, sink, controller } = setup();
    const calls: string[] = [];
    const resolver = async () => {
      calls.push("DNS");
      return [{ address: "8.8.8.8", family: 4 }];
    };
    const policy = {
      permitsHostname: () => {
        calls.push("hostname policy");
        return true;
      },
      permitsAddress: () => {
        calls.push("address policy");
        return true;
      },
    };
    const sockets = new FakeSocketFactory();
    const inner = new KindPrototypeChannelExecutor(
      new WebSocketPrototypeChannelExecutor({
        timer,
        resolver,
        policy,
        socketFactory: sockets.factory,
      }),
      new SsePrototypeChannelExecutor({
        timer,
        resolver,
        policy,
        fetch: async () => {
          calls.push("fetch");
          return new Response("");
        },
      }),
    );
    const executor = new MockRoutingPrototypeChannelExecutor(inner, registry);
    for (const request of mockRequests) {
      executor.open(request, sink, controller.signal);
    }
    await settle();
    expect(calls).toEqual([]);
    expect(sockets.sockets).toEqual([]);
    expect(sink.closes).toHaveLength(mockRequests.length);
    registry.define("shop", { rooms: [{ path: "/room" }, { path: "/events" }] });
    const served = new RecordingSink();
    for (const request of mockRequests) {
      executor.open(request, served, controller.signal);
    }
    await settle();
    expect(calls).toEqual([]);
    expect(sockets.sockets).toEqual([]);
    expect(served.opens).toHaveLength(mockRequests.length);
  });

  test("coordinator wiring routes mocks while retaining the injected executor", () => {
    const { timer, registry, inner, sink } = setup();
    const coordinator = createPrototypeChannelCoordinator(timer, registry, inner);
    const target = {
      deviceId: "device",
      prototypeId: "prototype",
      connection: Symbol(),
      connectionId: "c",
    };
    coordinator.open(target, mockRequests[0]!, sink);
    expect(inner.calls).toEqual([]);
    expect(sink.closes[0]?.error?.code).toBe("network");
    expect(coordinator.openCount()).toBe(0);
    const request: PrototypeChannelOpenRequest = { kind: "websocket", url: "wss://example.com" };
    coordinator.open(target, request, sink);
    expect(inner.calls[0]?.[0]).toBe(request);
    coordinator.cancelDevice("device");
  });
});

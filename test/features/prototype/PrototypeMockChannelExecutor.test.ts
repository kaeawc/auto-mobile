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

  test.each(mockRequests)("known backend refuses unsupported channels for $url", (request) => {
    const { executor, inner, sink, controller, registry } = setup();
    registry.define("shop", { collections: {} });
    executor.open(request, sink, controller.signal);
    expect(inner.calls).toEqual([]);
    expect(sink.closes).toEqual([
      { error: { code: "network", message: 'Mock backend "shop" has no channel support yet.' } },
    ]);
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

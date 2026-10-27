import { describe, expect, test } from "bun:test";
import {
  PrototypeChannelCoordinator,
  type PrototypeChannelTarget,
} from "../../../src/features/prototype/PrototypeChannelCoordinator";
import type {
  PrototypeChannelExecutor,
  PrototypeChannelHandle,
  PrototypeChannelOpenRequest,
  PrototypeChannelSink,
} from "../../../src/features/prototype/PrototypeChannelExecutor";
import { RecordingSink } from "./prototypeChannelFakes";

class FakeExecutor implements PrototypeChannelExecutor {
  readonly opens: {
    request: PrototypeChannelOpenRequest;
    sink: PrototypeChannelSink;
    signal: AbortSignal;
  }[] = [];
  readonly sent: string[] = [];
  readonly closeCalls: (number | undefined)[] = [];
  open(
    request: PrototypeChannelOpenRequest,
    sink: PrototypeChannelSink,
    signal: AbortSignal,
  ): PrototypeChannelHandle {
    this.opens.push({ request, sink, signal });
    return {
      send: (data) => {
        this.sent.push(data);
        return { ok: true };
      },
      close: (code) => {
        this.closeCalls.push(code);
      },
    };
  }
}

const request: PrototypeChannelOpenRequest = { kind: "websocket", url: "wss://a.test/x" };
const socketA = Symbol("a");
const socketB = Symbol("b");
const target = (over: Partial<PrototypeChannelTarget> = {}): PrototypeChannelTarget => ({
  deviceId: "dev",
  prototypeId: "p1",
  connection: socketA,
  connectionId: "c1",
  ...over,
});

describe("PrototypeChannelCoordinator", () => {
  test("opens, relays sends and closes by connection id", () => {
    const executor = new FakeExecutor();
    const coordinator = new PrototypeChannelCoordinator(executor);
    expect(coordinator.open(target(), request, new RecordingSink())).toEqual({ ok: true });
    expect(coordinator.openCount("dev")).toBe(1);
    expect(coordinator.send(socketA, "c1", "hi")).toEqual({ ok: true });
    expect(executor.sent).toEqual(["hi"]);
    expect(coordinator.send(socketB, "c1", "hi")).toBeUndefined();
    expect(coordinator.send(socketA, "other", "hi")).toBeUndefined();
    expect(coordinator.close(socketA, "c1", 1000)).toBe(true);
    expect(coordinator.close(socketA, "zzz")).toBe(false);
    expect(executor.closeCalls).toEqual([1000]);
  });

  test("a closed connection frees its slot and reaches the sink once", () => {
    const executor = new FakeExecutor();
    const coordinator = new PrototypeChannelCoordinator(executor, 1);
    const sink = new RecordingSink();
    coordinator.open(target(), request, sink);
    executor.opens[0]!.sink.opened("p");
    executor.opens[0]!.sink.closed({ code: 1000 });
    expect(sink.log).toEqual(["opened", "closed"]);
    expect(coordinator.openCount()).toBe(0);
    expect(coordinator.open(target({ connectionId: "c2" }), request, new RecordingSink())).toEqual({
      ok: true,
    });
  });

  test("refuses more than the per-device cap, counting devices separately", () => {
    const coordinator = new PrototypeChannelCoordinator(new FakeExecutor(), 2);
    coordinator.open(target({ connectionId: "1" }), request, new RecordingSink());
    coordinator.open(target({ connectionId: "2" }), request, new RecordingSink());
    const refused = coordinator.open(target({ connectionId: "3" }), request, new RecordingSink());
    expect(refused).toMatchObject({ ok: false, error: { code: "too_many_in_flight" } });
    expect(
      coordinator.open(
        target({ deviceId: "other", connectionId: "3" }),
        request,
        new RecordingSink(),
      ),
    ).toEqual({
      ok: true,
    });
  });

  test("refuses a connection id that is already open on the same socket", () => {
    const coordinator = new PrototypeChannelCoordinator(new FakeExecutor());
    coordinator.open(target(), request, new RecordingSink());
    expect(coordinator.open(target(), request, new RecordingSink())).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    expect(coordinator.open(target({ connection: socketB }), request, new RecordingSink())).toEqual(
      { ok: true },
    );
  });

  test("cancelPrototype aborts only that prototype on that device and frees its slots", () => {
    const executor = new FakeExecutor();
    const coordinator = new PrototypeChannelCoordinator(executor, 2);
    coordinator.open(target({ connectionId: "1" }), request, new RecordingSink());
    coordinator.open(
      target({ connectionId: "2", prototypeId: "p2" }),
      request,
      new RecordingSink(),
    );
    coordinator.cancelPrototype("dev", "p1");
    expect(executor.opens.map((o) => o.signal.aborted)).toEqual([true, false]);
    expect(coordinator.openCount()).toBe(1);
    expect(coordinator.open(target({ connectionId: "3" }), request, new RecordingSink())).toEqual({
      ok: true,
    });
  });

  test("cancelDevice aborts every channel on the device, whichever socket opened it", () => {
    const executor = new FakeExecutor();
    const coordinator = new PrototypeChannelCoordinator(executor);
    coordinator.open(target({ connectionId: "1" }), request, new RecordingSink());
    coordinator.open(
      target({ connectionId: "1", connection: socketB }),
      request,
      new RecordingSink(),
    );
    coordinator.open(
      target({ deviceId: "other", connectionId: "9" }),
      request,
      new RecordingSink(),
    );
    coordinator.cancelDevice("dev");
    expect(executor.opens.map((o) => o.signal.aborted)).toEqual([true, true, false]);
  });

  test("cancelConnection leaves another socket's channels on the same device open", () => {
    const executor = new FakeExecutor();
    const coordinator = new PrototypeChannelCoordinator(executor);
    coordinator.open(target(), request, new RecordingSink());
    coordinator.open(target({ connection: socketB }), request, new RecordingSink());
    coordinator.cancelConnection(socketA);
    expect(executor.opens.map((o) => o.signal.aborted)).toEqual([true, false]);
    expect(coordinator.openCount()).toBe(1);
  });

  test("a close reported synchronously from open still frees the slot", () => {
    const coordinator = new PrototypeChannelCoordinator({
      open: (_request, sink) => {
        sink.closed({ error: { code: "invalid_url", message: "bad" } });
        return { send: () => ({ ok: false, reason: "not_open" }), close: () => {} };
      },
    });
    const sink = new RecordingSink();
    coordinator.open(target(), request, sink);
    expect(sink.log).toEqual(["closed"]);
    expect(coordinator.openCount()).toBe(0);
  });
});

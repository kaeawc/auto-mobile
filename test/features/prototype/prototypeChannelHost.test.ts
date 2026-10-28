import { describe, expect, test } from "bun:test";
import { PrototypeChannelCoordinator } from "../../../src/features/prototype/PrototypeChannelCoordinator";
import type {
  PrototypeChannelExecutor,
  PrototypeChannelOpenRequest,
  PrototypeChannelSink,
} from "../../../src/features/prototype/PrototypeChannelExecutor";
import {
  createPrototypeChannelHost,
  type PrototypeChannelSender,
} from "../../../src/features/prototype/prototypeChannelHost";
import type { PrototypeChannelOutboundMessage } from "../../../src/features/prototype/prototypeChannelProtocol";

class ScriptedExecutor implements PrototypeChannelExecutor {
  requests: PrototypeChannelOpenRequest[] = [];
  sinks: PrototypeChannelSink[] = [];
  signals: AbortSignal[] = [];
  sent: string[] = [];
  closed: (number | undefined)[] = [];
  open(request: PrototypeChannelOpenRequest, sink: PrototypeChannelSink, signal: AbortSignal) {
    this.requests.push(request);
    this.sinks.push(sink);
    this.signals.push(signal);
    return {
      send: (data: string) => {
        this.sent.push(data);
        return { ok: true } as const;
      },
      close: (code?: number) => {
        this.closed.push(code);
      },
    };
  }
}

const openFrame = {
  type: "prototype_channel_open",
  connectionId: "c1",
  prototypeId: "p1",
  channel: "chat",
  kind: "websocket",
  url: "wss://chat.test/x",
  protocols: ["chat.v1"],
  headers: { A: "b" },
};

function setup() {
  const executor = new ScriptedExecutor();
  const coordinator = new PrototypeChannelCoordinator(executor, 1);
  const host = createPrototypeChannelHost("dev", coordinator);
  const out: PrototypeChannelOutboundMessage[] = [];
  const send: PrototypeChannelSender = (message) => {
    out.push(message);
  };
  return { executor, coordinator, host, out, send };
}

describe("createPrototypeChannelHost", () => {
  test("relays opened, frames and closed with the device's connection id", () => {
    const { executor, host, out, send } = setup();
    host.handleOpen(openFrame, send);
    expect(executor.requests[0]).toMatchObject({
      kind: "websocket",
      url: "wss://chat.test/x",
      protocols: ["chat.v1"],
    });
    executor.sinks[0]!.opened("chat.v1");
    executor.sinks[0]!.frame({ data: "d", event: "e", id: "7" });
    executor.sinks[0]!.closed({ code: 1000, reason: "bye" });
    expect(out).toEqual([
      { type: "prototype_channel_opened", connectionId: "c1", protocol: "chat.v1" },
      { type: "prototype_channel_frame", connectionId: "c1", data: "d", event: "e", id: "7" },
      { type: "prototype_channel_closed", connectionId: "c1", code: 1000, reason: "bye" },
    ]);
  });

  test("an invalid open is answered with a closed frame carrying the connection id", () => {
    const { executor, host, out, send } = setup();
    host.handleOpen(
      { type: "prototype_channel_open", connectionId: "c9", kind: "carrier-pigeon" },
      send,
    );
    expect(executor.requests).toEqual([]);
    expect(out).toEqual([
      expect.objectContaining({
        type: "prototype_channel_closed",
        connectionId: "c9",
        error: expect.objectContaining({ code: "invalid_request" }),
      }),
    ]);
  });

  test("an open past the per-device cap is answered with closed and too_many_in_flight", () => {
    const { host, out, send } = setup();
    host.handleOpen(openFrame, send);
    host.handleOpen({ ...openFrame, connectionId: "c2" }, send);
    expect(out).toEqual([
      {
        type: "prototype_channel_closed",
        connectionId: "c2",
        error: expect.objectContaining({ code: "too_many_in_flight" }),
      },
    ]);
  });

  test("device send and close frames reach the connection; malformed ones are ignored", () => {
    const { executor, host, send } = setup();
    host.handleOpen(openFrame, send);
    host.handleSend({ type: "prototype_channel_send", connectionId: "c1", data: "hi" });
    host.handleSend({ type: "prototype_channel_send", connectionId: "c1" });
    host.handleSend({ type: "prototype_channel_send", connectionId: "nope", data: "x" });
    host.handleClose({ type: "prototype_channel_close", connectionId: "c1", code: 4001 });
    host.handleClose({ type: "prototype_channel_close" });
    expect(executor.sent).toEqual(["hi"]);
    expect(executor.closed).toEqual([4001]);
  });

  test("a disconnect aborts this socket's channels and keeps another host's", () => {
    const { executor, coordinator, host, send } = setup();
    const other = createPrototypeChannelHost("dev", new PrototypeChannelCoordinator(executor, 5));
    host.handleOpen(openFrame, send);
    other.handleOpen({ ...openFrame, connectionId: "c1" }, send);
    host.handleDisconnect();
    expect(executor.signals.map((s) => s.aborted)).toEqual([true, false]);
    expect(coordinator.openCount()).toBe(0);
  });

  test("a sender that throws does not break the connection", () => {
    const { executor, host } = setup();
    host.handleOpen(openFrame, () => {
      throw new Error("socket closed");
    });
    expect(() => executor.sinks[0]!.opened()).not.toThrow();
  });
});

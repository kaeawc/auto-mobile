import { describe, expect, test } from "bun:test";
import {
  PROTOTYPE_CHANNEL_DEVICE_FRAME_TYPES,
  routePrototypeChannelFrame,
  webSocketChannelSender,
  type PrototypeChannelHost,
  type PrototypeChannelSender,
} from "../../../src/features/prototype/prototypeChannelHost";
import {
  attachAndroidPrototypeChannels,
  attachIosPrototypeChannels,
  combinedPrototypeCancellation,
} from "../../../src/features/prototype/prototypeChannelWiring";
import { PrototypeChannelCoordinator } from "../../../src/features/prototype/PrototypeChannelCoordinator";
import type { PrototypeChannelOutboundMessage } from "../../../src/features/prototype/prototypeChannelProtocol";

class RecordingHost implements PrototypeChannelHost {
  readonly calls: [string, unknown][] = [];
  disconnects = 0;
  handleOpen(frame: unknown): void {
    this.calls.push(["open", frame]);
  }
  handleSend(frame: unknown): void {
    this.calls.push(["send", frame]);
  }
  handleClose(frame: unknown): void {
    this.calls.push(["close", frame]);
  }
  handleDisconnect(): void {
    this.disconnects++;
  }
}

describe("routePrototypeChannelFrame", () => {
  test("hands each device frame type to the matching host method", () => {
    const host = new RecordingHost();
    const sent: PrototypeChannelOutboundMessage[] = [];
    const send: PrototypeChannelSender = (message) => {
      sent.push(message);
    };
    for (const type of [
      "prototype_channel_open",
      "prototype_channel_send",
      "prototype_channel_close",
    ]) {
      routePrototypeChannelFrame(host, { type, connectionId: "c" }, send);
    }
    expect(host.calls.map(([name]) => name)).toEqual(["open", "send", "close"]);
    expect(sent).toEqual([]);
  });

  test("ignores other frame types", () => {
    const host = new RecordingHost();
    routePrototypeChannelFrame(host, { type: "prototype_request" }, () => {});
    routePrototypeChannelFrame(host, null, () => {});
    routePrototypeChannelFrame(host, "open", () => {});
    expect(host.calls).toEqual([]);
  });

  test("with no host attached an open is answered with a closed frame carrying its connection id", () => {
    const sent: PrototypeChannelOutboundMessage[] = [];
    routePrototypeChannelFrame(
      undefined,
      { type: "prototype_channel_open", connectionId: "c9" },
      (message) => {
        sent.push(message);
      },
    );
    expect(sent).toEqual([
      {
        type: "prototype_channel_closed",
        connectionId: "c9",
        error: { code: "network", message: "The host channel proxy is not available." },
      },
    ]);
  });

  test("with no host attached a send or close is dropped silently", () => {
    const sent: unknown[] = [];
    for (const type of ["prototype_channel_send", "prototype_channel_close"]) {
      routePrototypeChannelFrame(undefined, { type, connectionId: "c" }, (message) => {
        sent.push(message);
      });
    }
    expect(sent).toEqual([]);
  });

  test("the routed types are exactly the three device frames", () => {
    expect([...PROTOTYPE_CHANNEL_DEVICE_FRAME_TYPES].sort()).toEqual([
      "prototype_channel_close",
      "prototype_channel_open",
      "prototype_channel_send",
    ]);
  });
});

describe("webSocketChannelSender", () => {
  const message: PrototypeChannelOutboundMessage = {
    type: "prototype_channel_opened",
    connectionId: "c1",
  };

  test("writes JSON to an open socket", () => {
    const written: string[] = [];
    webSocketChannelSender(() => ({
      readyState: WebSocket.OPEN,
      send: (data) => written.push(String(data)),
    }))(message);
    expect(written.map((text) => JSON.parse(text))).toEqual([message]);
  });

  test("throws when there is no socket or it is not open", () => {
    expect(() => webSocketChannelSender(() => null)(message)).toThrow("WebSocket not connected");
    expect(() =>
      webSocketChannelSender(() => ({ readyState: WebSocket.CLOSED, send: () => {} }))(message),
    ).toThrow("WebSocket not connected");
  });
});

describe("channel wiring", () => {
  const coordinator = new PrototypeChannelCoordinator({
    open: () => ({ send: () => ({ ok: true }), close: () => {} }),
  });

  test("attaches a channel host to an Android client and an iOS agent, and to neither without a coordinator", () => {
    const attached: unknown[] = [];
    attachAndroidPrototypeChannels(
      { attachPrototypeChannelHost: (host) => attached.push(host) },
      "dev",
      coordinator,
    );
    attachIosPrototypeChannels(
      { attachChannelHost: (host) => attached.push(host) },
      "dev",
      coordinator,
    );
    expect(attached).toHaveLength(2);
    attachAndroidPrototypeChannels(
      { attachPrototypeChannelHost: (host) => attached.push(host) },
      "dev",
      undefined,
    );
    attachIosPrototypeChannels(
      { attachChannelHost: (host) => attached.push(host) },
      "dev",
      undefined,
    );
    expect(attached).toHaveLength(2);
    expect(() => attachAndroidPrototypeChannels({}, "dev", coordinator)).not.toThrow();
  });

  test("combined cancellation forwards both calls to every part", () => {
    const log: string[] = [];
    const part = (name: string) => ({
      cancelPrototype: (device: string, id: string) => log.push(`${name}:p:${device}/${id}`),
      cancelDevice: (device: string) => log.push(`${name}:d:${device}`),
    });
    const combined = combinedPrototypeCancellation(part("a"), part("b"));
    combined.cancelPrototype("dev", "p1");
    combined.cancelDevice("dev");
    expect(log).toEqual(["a:p:dev/p1", "b:p:dev/p1", "a:d:dev", "b:d:dev"]);
  });
});

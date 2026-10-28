import { describe, expect, test } from "bun:test";
import {
  connectPrototypeAgent,
  PROTOTYPE_AGENT_PROTOCOL_VERSION,
  type PrototypeAgentClient,
} from "../../../../src/features/prototype/ios/prototypeAgentClient";
import type {
  PrototypeChannelHost,
  PrototypeChannelSender,
} from "../../../../src/features/prototype/prototypeChannelHost";
import {
  FakePrototypeAgentConnector,
  FakePrototypeAgentSocket,
} from "../../../fakes/FakePrototypeAgentSocket";
import { FakeTimer } from "../../../fakes/FakeTimer";

class RecordingChannelHost implements PrototypeChannelHost {
  readonly frames: [string, unknown][] = [];
  disconnects = 0;
  handleOpen(frame: unknown, send: PrototypeChannelSender): void {
    this.frames.push(["open", frame]);
    send({ type: "prototype_channel_opened", connectionId: "c1" });
  }
  handleSend(frame: unknown): void {
    this.frames.push(["send", frame]);
  }
  handleClose(frame: unknown): void {
    this.frames.push(["close", frame]);
  }
  handleDisconnect(): void {
    this.disconnects += 1;
  }
}

const open = { type: "prototype_channel_open", connectionId: "c1", url: "wss://chat.test/x" };

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

async function connected(): Promise<{
  socket: FakePrototypeAgentSocket;
  client: PrototypeAgentClient;
}> {
  const socket = new FakePrototypeAgentSocket();
  const connecting = connectPrototypeAgent({
    port: 1234,
    token: "t",
    connector: new FakePrototypeAgentConnector(socket),
    timer: new FakeTimer(),
  });
  await flush();
  socket.push({
    type: "hello_result",
    agentVersion: "0.1.0",
    protocolVersion: PROTOTYPE_AGENT_PROTOCOL_VERSION,
    capabilities: ["show_prototype"],
  });
  const client = await connecting;
  socket.written.length = 0;
  return { socket, client };
}

describe("iOS prototype agent channel routing (#14268)", () => {
  test("routes open, send and close to the attached host and writes its replies", async () => {
    const { socket, client } = await connected();
    const host = new RecordingChannelHost();
    client.attachChannelHost?.(host);
    socket.push(open);
    socket.push({ type: "prototype_channel_send", connectionId: "c1", data: "hi" });
    socket.push({ type: "prototype_channel_close", connectionId: "c1" });
    await flush();
    expect(host.frames.map(([name]) => name)).toEqual(["open", "send", "close"]);
    expect(socket.frames()).toEqual([{ type: "prototype_channel_opened", connectionId: "c1" }]);
  });

  test("answers an open with a closed frame when no host is attached", async () => {
    const { socket } = await connected();
    socket.push(open);
    await flush();
    expect(socket.frames()).toEqual([
      {
        type: "prototype_channel_closed",
        connectionId: "c1",
        error: { code: "network", message: "The host channel proxy is not available." },
      },
    ]);
  });

  test("ends the host's channels when the connection closes", async () => {
    const { socket, client } = await connected();
    const host = new RecordingChannelHost();
    client.attachChannelHost?.(host);
    socket.closeFromAgent();
    expect(host.disconnects).toBe(1);
  });
});

import { describe, expect, test } from "bun:test";
import {
  connectPrototypeAgent,
  PROTOTYPE_AGENT_PROTOCOL_VERSION,
  type PrototypeAgentClient,
} from "../../../../src/features/prototype/ios/prototypeAgentClient";
import {
  createPrototypeRequestHost,
  type PrototypeRequestHost,
  type PrototypeResponseSender,
} from "../../../../src/features/prototype/prototypeRequestHandler";
import { attachIosPrototypeRequests } from "../../../../src/features/prototype/prototypeRequestWiring";
import {
  FakePrototypeAgentConnector,
  FakePrototypeAgentSocket,
} from "../../../fakes/FakePrototypeAgentSocket";
import { FakeTimer } from "../../../fakes/FakeTimer";

const frame = {
  type: "prototype_request",
  requestId: "q1",
  prototypeId: "p1",
  method: "GET",
  url: "https://example.test/feed",
};

class RecordingHost implements PrototypeRequestHost {
  readonly frames: unknown[] = [];
  disconnects = 0;
  handleRequest(received: unknown, send: PrototypeResponseSender): Promise<void> {
    this.frames.push(received);
    send({
      type: "prototype_response",
      requestId: "q1",
      ok: true,
      status: 200,
      headers: {},
      body: { n: 1 },
      durationMs: 3,
    });
    return Promise.resolve();
  }
  readonly cancels: unknown[] = [];
  handleCancel(received: unknown): void {
    this.cancels.push(received);
  }
  handleDisconnect(): void {
    this.disconnects += 1;
  }
}

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

describe("iOS prototype agent request routing (#12529)", () => {
  test("routes prototype_request to the attached host and writes its response", async () => {
    const { socket, client } = await connected();
    const host = new RecordingHost();
    client.attachRequestHost?.(host);
    socket.push(frame);
    await flush();
    expect(host.frames).toEqual([frame]);
    expect(socket.frames()).toEqual([
      {
        type: "prototype_response",
        requestId: "q1",
        ok: true,
        status: 200,
        headers: {},
        body: { n: 1 },
        durationMs: 3,
      },
    ]);
  });

  test("answers a network error when no host is attached", async () => {
    const { socket } = await connected();
    socket.push(frame);
    await flush();
    expect(socket.frames()).toEqual([
      {
        type: "prototype_response",
        requestId: "q1",
        ok: false,
        error: { code: "network", message: "The host request proxy is not available." },
        durationMs: 0,
      },
    ]);
  });

  test("routes a prototype_request_cancel frame to the host without replying", async () => {
    const { socket, client } = await connected();
    const host = new RecordingHost();
    client.attachRequestHost?.(host);
    const cancel = { type: "prototype_request_cancel", requestId: "q1" };
    socket.push(cancel);
    await flush();
    expect(host.cancels).toEqual([cancel]);
    expect(host.frames).toEqual([]);
    expect(socket.frames()).toEqual([]);
  });

  test("cancels the host's requests when the connection closes", async () => {
    const { socket, client } = await connected();
    const host = new RecordingHost();
    client.attachRequestHost?.(host);
    socket.closeFromAgent();
    expect(host.disconnects).toBe(1);
  });

  test("a response after close is dropped without throwing", async () => {
    const { socket, client } = await connected();
    let release: (() => void) | undefined;
    const slow = createPrototypeRequestHost("dev", {
      run: () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ ok: false, error: { code: "cancelled", message: "x" }, durationMs: 0 });
        }),
      cancelConnection: () => undefined,
      cancelRequest: () => false,
    });
    client.attachRequestHost?.(slow);
    socket.push(frame);
    await flush();
    client.close();
    release?.();
    await flush();
    expect(socket.frames()).toEqual([]);
  });

  test("attachIosPrototypeRequests attaches a host only when a coordinator exists", () => {
    const attached: unknown[] = [];
    const agent = { attachRequestHost: (host: unknown) => attached.push(host) };
    attachIosPrototypeRequests(agent, "dev", undefined);
    expect(attached).toHaveLength(0);
    attachIosPrototypeRequests(agent, "dev", {} as never);
    expect(attached).toHaveLength(1);
  });
});

import { afterAll, describe, expect, test } from "bun:test";
import { WebSocketServer } from "ws";
import { permissivePrototypeEgressPolicy } from "../../fakes/FakePrototypeEgressPolicy";
import { KindPrototypeChannelExecutor } from "../../../src/features/prototype/PrototypeChannelExecutor";
import { SsePrototypeChannelExecutor } from "../../../src/features/prototype/SsePrototypeChannelExecutor";
import { WebSocketPrototypeChannelExecutor } from "../../../src/features/prototype/WebSocketPrototypeChannelExecutor";
import { SystemTimer, defaultTimer } from "../../../src/utils/SystemTimer";
import { RecordingSink } from "./prototypeChannelFakes";

const wss = new WebSocketServer({
  host: "127.0.0.1",
  port: 0,
  handleProtocols: (p) => [...p][0] ?? false,
});
wss.on("connection", (socket) => {
  socket.on("message", (data) => socket.send(`echo:${data.toString()}`));
});
const sse = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    if (new URL(req.url).pathname === "/redirect") {
      return new Response(null, { status: 302, headers: { Location: "/events" } });
    }
    const lastId = req.headers.get("last-event-id") ?? "none";
    return new Response(`id: 1\nevent: hello\ndata: ${lastId}\n\ndata: a\ndata: b\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  },
});
afterAll(() => {
  wss.close();
  void sse.stop(true);
});

const address = wss.address();
const wsPort = typeof address === "object" && address !== null ? address.port : 0;

const timer = new SystemTimer();
const resolver = async () => [{ address: "127.0.0.1", family: 4 }];
const executor = new KindPrototypeChannelExecutor(
  new WebSocketPrototypeChannelExecutor({
    timer,
    policy: permissivePrototypeEgressPolicy,
    resolver,
  }),
  new SsePrototypeChannelExecutor({ timer, policy: permissivePrototypeEgressPolicy, resolver }),
);

const until = async (done: () => boolean): Promise<void> => {
  for (let i = 0; i < 400 && !done(); i++) {
    await defaultTimer.sleep(5);
  }
};

describe("host channel transports against in-process servers", () => {
  test("a WebSocket reaches the server by the pinned address under the authored hostname", async () => {
    const sink = new RecordingSink();
    const handle = executor.open(
      {
        kind: "websocket",
        url: `ws://chat.test:${wsPort}/room`,
        protocols: ["chat.v1"],
      },
      sink,
      new AbortController().signal,
    );
    await until(() => sink.opens.length > 0);
    expect(sink.opens).toEqual(["chat.v1"]);
    expect(handle.send("ping")).toEqual({ ok: true });
    await until(() => sink.frames.length > 0);
    expect(sink.frames).toEqual([{ data: "echo:ping" }]);
    handle.close(1000, "done");
    await until(() => sink.closes.length > 0);
    expect(sink.closes[0]).toMatchObject({ code: 1000 });
  });

  test("a refused WebSocket upgrade is handshake_failed", async () => {
    const sink = new RecordingSink();
    executor.open(
      { kind: "websocket", url: `ws://chat.test:${sse.port}/room` },
      sink,
      new AbortController().signal,
    );
    await until(() => sink.closes.length > 0);
    expect(sink.closes[0]?.error?.code).toBe("handshake_failed");
  });

  test("an event stream is parsed, follows a redirect and resends Last-Event-ID", async () => {
    const sink = new RecordingSink();
    executor.open(
      { kind: "sse", url: `http://api.test:${sse.port}/redirect`, lastEventId: "41" },
      sink,
      new AbortController().signal,
    );
    await until(() => sink.closes.length > 0);
    expect(sink.frames).toEqual([
      { event: "hello", data: "41", id: "1" },
      { data: "a\nb", id: "1" },
    ]);
    expect(sink.closes).toEqual([{}]);
  });
});

import { AndroidCtrlProxyClient } from "../../src/features/observe/android/AndroidCtrlProxyClient";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeWebSocket } from "../fakes/FakeWebSocket";
import {
  runAndroidCtrlProxyContract,
  type AndroidCtrlProxyHarness,
  type AndroidCtrlProxyReplies,
  type ContractRequest,
} from "./AndroidCtrlProxyContract";

/** Request fields a caller chose; the rest (ids, deadlines, frame context) are transport detail. */
const ARGUMENTS: Record<string, readonly string[]> = {
  request_tap_coordinates: ["x", "y", "duration"],
  request_swipe: ["x1", "y1", "x2", "y2", "duration"],
  request_drag: ["x1", "y1", "x2", "y2", "pressDurationMs", "dragDurationMs", "holdDurationMs"],
};

/**
 * The real client over an already-open socket (the same seam the client's own input-delivery tests
 * use): each frame it sends is answered with the captured reply for that request type.
 */
async function realHarness(replies: AndroidCtrlProxyReplies): Promise<AndroidCtrlProxyHarness> {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const socket = new FakeWebSocket("ws://fake", "none", 0, timer);
  await Promise.resolve();
  const client = AndroidCtrlProxyClient.createForTesting(
    { deviceId: "contract-device", platform: "android", name: "contract" },
    new FakeAdbExecutor(),
    { webSocketFactory: () => socket, timer, idGenerator: new FakeIdGenerator() },
  );
  // The client's own tests drive the same private seams: an open socket, no reconnect, no redial.
  client.connectionTestHooks.socket = socket;
  client.connectionTestHooks.autoReconnectEnabled = false;
  client["connectWebSocket"] = async () => true;
  client["onConnectionClosed"] = () => {};
  socket.on("message", (data: string) => {
    void client["handleMessage"](data);
  });

  const sent: Record<string, unknown>[] = [];
  const send = socket.send.bind(socket);
  socket.send = (data: unknown) => {
    send(data as never);
    const request = JSON.parse(String(data)) as Record<string, unknown>;
    sent.push(request);
    const reply = replies[String(request.type)];
    if (reply) {
      queueMicrotask(() =>
        socket.simulateMessage(JSON.stringify({ ...reply, requestId: request.requestId })),
      );
    }
  };
  return {
    proxy: client,
    requests: () =>
      sent.map((request): ContractRequest => {
        const type = String(request.type);
        return {
          type,
          ...Object.fromEntries(
            (ARGUMENTS[type] ?? []).flatMap((key) => (key in request ? [[key, request[key]]] : [])),
          ),
        };
      }),
    close: async () => {
      await client.close();
    },
  };
}

/** The fake takes the very outcome the real client decodes from the same captured reply. */
async function fakeHarness(replies: AndroidCtrlProxyReplies): Promise<AndroidCtrlProxyHarness> {
  const proxy = new FakeCtrlProxy();
  for (const [type, wire] of Object.entries(replies)) {
    const outcome = {
      success: wire.success as boolean,
      ...(typeof wire.error === "string" ? { error: wire.error } : {}),
      totalTimeMs: 0,
    };
    if (type === "request_tap_coordinates") {
      proxy.setTapResult(outcome);
    } else if (type === "request_swipe") {
      proxy.setSwipeResult(outcome);
    } else if (type === "request_drag") {
      proxy.setDragResult(outcome);
    }
  }
  return {
    proxy,
    requests: () => proxy.getGestureRequestLog(),
    close: async () => {},
  };
}

runAndroidCtrlProxyContract("AndroidCtrlProxyClient (replayed device capture)", realHarness);
runAndroidCtrlProxyContract("FakeCtrlProxy", fakeHarness);

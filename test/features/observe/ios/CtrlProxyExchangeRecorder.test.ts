import { describe, expect, test } from "bun:test";
import {
  CtrlProxyExchangeRecorder,
  type ExchangeSink,
  IOS_CTRL_PROXY_RECORD_DIR_ENV,
  REDACTED_PASSWORD_TEXT,
  recordingWebSocketFactory,
  withCtrlProxyRecordingFromEnv,
} from "../../../../src/features/observe/ios/CtrlProxyExchangeRecorder";
import type { WebSocketFactory } from "../../../../src/features/observe/DeviceServiceClient";
import { FakeWebSocket } from "../../../fakes/FakeWebSocket";

class MemorySink implements ExchangeSink {
  readonly files = new Map<string, unknown>();

  write(fileName: string, contents: string): void {
    this.files.set(fileName, JSON.parse(contents));
  }
}

const hierarchyResponse = (requestId: string, root: Record<string, unknown>) =>
  JSON.stringify({ type: "hierarchy_update", requestId, data: { hierarchy: root } });

function recorderWithHierarchy(root: Record<string, unknown>): {
  recorder: CtrlProxyExchangeRecorder;
  sink: MemorySink;
} {
  const sink = new MemorySink();
  const recorder = new CtrlProxyExchangeRecorder(sink);
  recorder.onSent(JSON.stringify({ type: "request_hierarchy", requestId: "h1" }));
  recorder.onReceived(hierarchyResponse("h1", root));
  return { recorder, sink };
}

function setTextFile(sink: MemorySink): { request: { text: string } } {
  return sink.files.get("0002-request_set_text.json") as { request: { text: string } };
}

describe("CtrlProxyExchangeRecorder", () => {
  test("pairs a response with its request and writes pushes on their own", () => {
    const sink = new MemorySink();
    const recorder = new CtrlProxyExchangeRecorder(sink);

    recorder.onReceived(JSON.stringify({ type: "connected", supportedCommands: ["a"] }));
    recorder.onSent(JSON.stringify({ type: "request_tap_coordinates", requestId: "t1", x: 1 }));
    recorder.onReceived(JSON.stringify({ type: "tap_coordinates_result", requestId: "t1" }));
    recorder.onReceived("not json");

    expect([...sink.files.keys()]).toEqual([
      "0001-push-connected.json",
      "0002-request_tap_coordinates.json",
    ]);
    expect(sink.files.get("0002-request_tap_coordinates.json")).toEqual({
      request: { type: "request_tap_coordinates", requestId: "t1", x: 1 },
      response: { type: "tap_coordinates_result", requestId: "t1" },
    });
  });

  test("redacts typed text when no hierarchy has been seen", () => {
    const sink = new MemorySink();
    const recorder = new CtrlProxyExchangeRecorder(sink);

    recorder.onSent(
      JSON.stringify({ type: "request_append_text", requestId: "a1", text: "hunter2" }),
    );
    recorder.onReceived(JSON.stringify({ type: "append_text_result", requestId: "a1" }));

    expect(sink.files.get("0001-request_append_text.json")).toMatchObject({
      request: { text: REDACTED_PASSWORD_TEXT },
    });
  });

  test("redacts text typed into the focused password field", () => {
    const { recorder, sink } = recorderWithHierarchy({
      className: "Window",
      node: [{ className: "UISecureTextField", focused: "true", password: "true" }],
    });

    recorder.onSent(JSON.stringify({ type: "request_set_text", requestId: "s1", text: "hunter2" }));
    recorder.onReceived(JSON.stringify({ type: "set_text_result", requestId: "s1" }));

    expect(setTextFile(sink).request.text).toBe(REDACTED_PASSWORD_TEXT);
  });

  test("keeps text typed into a resolved non-password field", () => {
    const { recorder, sink } = recorderWithHierarchy({
      className: "Window",
      node: { className: "UITextField", resourceId: "email", password: "false" },
    });

    recorder.onSent(
      JSON.stringify({
        type: "request_set_text",
        requestId: "s1",
        text: "a@b.c",
        resourceId: "email",
      }),
    );
    recorder.onReceived(JSON.stringify({ type: "set_text_result", requestId: "s1" }));

    expect(setTextFile(sink).request.text).toBe("a@b.c");
  });

  test("redacts when the targeted resource id is not in the latest hierarchy", () => {
    const { recorder, sink } = recorderWithHierarchy({ className: "Window" });

    recorder.onSent(
      JSON.stringify({
        type: "request_set_text",
        requestId: "s1",
        text: "x",
        resourceId: "missing",
      }),
    );
    recorder.onReceived(JSON.stringify({ type: "set_text_result", requestId: "s1" }));

    expect(setTextFile(sink).request.text).toBe(REDACTED_PASSWORD_TEXT);
  });

  test("the recording factory records what the socket sends and receives", () => {
    const sink = new MemorySink();
    let socket: FakeWebSocket | null = null;
    const inner: WebSocketFactory = (url) => {
      socket = new FakeWebSocket(url);
      socket.readyState = 1;
      return socket as never;
    };
    const ws = recordingWebSocketFactory(inner, new CtrlProxyExchangeRecorder(sink))("ws://x");

    ws.send(JSON.stringify({ type: "request_press_home", requestId: "p1" }));
    (socket as unknown as FakeWebSocket).simulateMessage(
      JSON.stringify({ type: "press_home_result", requestId: "p1", success: true }),
    );

    expect(sink.files.get("0001-request_press_home.json")).toMatchObject({
      response: { success: true },
    });
  });

  test("leaves the factory untouched unless the env var names a directory", () => {
    const factory: WebSocketFactory = () => {
      throw new Error("unused");
    };
    expect(withCtrlProxyRecordingFromEnv(factory, {})).toBe(factory);
    expect(withCtrlProxyRecordingFromEnv(factory, { [IOS_CTRL_PROXY_RECORD_DIR_ENV]: "  " })).toBe(
      factory,
    );
    const directories: string[] = [];
    const wrapped = withCtrlProxyRecordingFromEnv(
      factory,
      { [IOS_CTRL_PROXY_RECORD_DIR_ENV]: "/captures" },
      (directory) => {
        directories.push(directory);
        return new MemorySink();
      },
    );
    expect(wrapped).not.toBe(factory);
    expect(directories).toEqual(["/captures"]);
  });
});

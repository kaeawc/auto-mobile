import { describe, expect, test } from "bun:test";
import {
  DEFAULT_WEBRTC_STREAM_REQUEST_TIMEOUT_MS,
  sendWebRtcStreamRequest,
} from "../../src/daemon/webrtcStreamClient";
import type {
  WebRtcStreamSocketRequest,
  WebRtcStreamSocketResponse,
} from "../../src/daemon/webrtcStreamSocketTypes";
import { FakeSocket } from "../fakes/FakeNetServer";
import { FakeTimer } from "../fakes/FakeTimer";

const request: WebRtcStreamSocketRequest = { action: "status", id: "request-1" };
const response: WebRtcStreamSocketResponse = {
  type: "webrtc_stream_response",
  success: true,
  id: "request-1",
  action: "status",
};

async function createRequestHarness() {
  const socket = new FakeSocket();
  const timer = new FakeTimer();
  const result = sendWebRtcStreamRequest(request, {
    socketPath: "/fake/webrtc.sock",
    timeoutMs: 1000,
    socketFactory: () => socket,
    timer,
  });
  await new Promise<void>((resolve) => process.nextTick(resolve));
  expect(socket.getWrittenMessages()).toEqual([request]);
  return { socket, timer, result };
}

describe("webrtcStreamClient", () => {
  test("default timeout is longer than the server's initial audio startup gate", () => {
    expect(DEFAULT_WEBRTC_STREAM_REQUEST_TIMEOUT_MS).toBeGreaterThan(30_000);
  });

  test("skips an initial blank line and resolves before the request timeout", async () => {
    const { socket, timer, result } = await createRequestHarness();

    socket.simulateData("\n");
    socket.simulateData(`${JSON.stringify(response)}\n`);
    timer.advanceTime(1000);

    await expect(result).resolves.toEqual(response);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("skips blank lines between replies and trims CRLF framing", async () => {
    const { socket, timer, result } = await createRequestHarness();

    socket.simulateData(`\n\r\n${JSON.stringify(response)}\r\n`);

    await expect(result).resolves.toEqual(response);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("keeps an incomplete response buffered across chunks", async () => {
    const { socket, timer, result } = await createRequestHarness();
    const serialized = JSON.stringify(response);
    const splitAt = Math.floor(serialized.length / 2);

    socket.simulateData(serialized.slice(0, splitAt));
    expect(timer.getPendingTimeoutCount()).toBe(1);
    socket.simulateData(`${serialized.slice(splitAt)}\n`);

    await expect(result).resolves.toEqual(response);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("rejects malformed first non-empty line without reading later lines", async () => {
    const { socket, timer, result } = await createRequestHarness();

    socket.simulateData(`not-json\n${JSON.stringify(response)}\n`);

    await expect(result).rejects.toThrow(SyntaxError);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });
});

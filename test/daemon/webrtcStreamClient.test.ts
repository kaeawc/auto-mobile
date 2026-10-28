import { describe, expect, test } from "bun:test";
import {
  DEFAULT_WEBRTC_STREAM_REQUEST_TIMEOUT_MS,
  sendWebRtcStreamRequest,
} from "../../scripts/lib/webrtcStreamClient";
import type {
  WebRtcStreamSocketRequest,
  WebRtcStreamSocketResponse,
} from "../../src/daemon/webrtcStreamSocketTypes";
import { FakeSocket } from "../fakes/FakeNetServer";
import { FakeTimer } from "../fakes/FakeTimer";
import { DaemonFrameTooLargeError } from "../../src/daemon/wire/DaemonFrameTooLargeError";
import { ActionableError } from "../../src/models/ActionableError";

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

for (const shape of [
  42,
  {},
  { type: "webrtc_stream_response" },
  { type: "webrtc_stream_response", success: "yes" },
]) {
  test(`rejects wrong-shape WebRTC answer ${JSON.stringify(shape)}`, async () => {
    const { socket, timer, result } = await createRequestHarness();
    socket.simulateData(JSON.stringify(shape) + "\n");
    await expect(result).rejects.toThrow(ActionableError);
    expect(socket.destroyed).toBe(true);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });
}

test("oversized unterminated WebRTC answer closes the socket and clears its timer", async () => {
  const socket = new FakeSocket();
  const timer = new FakeTimer();
  const result = sendWebRtcStreamRequest(request, {
    socketPath: "/fake/webrtc.sock",
    socketFactory: () => socket,
    timer,
    maxFrameBytes: 64,
  }).catch((error: unknown) => error);
  socket.simulateData("x".repeat(65));
  expect(socket.destroyed).toBe(true);
  expect(await result).toBeInstanceOf(DaemonFrameTooLargeError);
  expect(timer.getPendingTimeoutCount()).toBe(0);
});

test("valid WebRTC envelope preserves extras and unchecked additive fields across split UTF-8", async () => {
  const { socket, timer, result } = await createRequestHarness();
  const futureResponse = { ...response, extra: "😀", action: 42, stream: "future" };
  const bytes = Buffer.from(JSON.stringify(futureResponse) + "\n");
  const split = bytes.indexOf(Buffer.from("😀")) + 1;
  socket.feed(bytes.subarray(0, split));
  socket.feed(bytes.subarray(split));
  expect<unknown>(await result).toEqual(futureResponse);
  expect(socket.destroyed).toBe(true);
  expect(timer.getPendingTimeoutCount()).toBe(0);
});

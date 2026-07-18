import { describe, expect, test } from "bun:test";
import { DEFAULT_WEBRTC_STREAM_REQUEST_TIMEOUT_MS } from "../../src/daemon/webrtcStreamClient";

describe("webrtcStreamClient", () => {
  test("default timeout is longer than the server's initial audio startup gate", () => {
    expect(DEFAULT_WEBRTC_STREAM_REQUEST_TIMEOUT_MS).toBeGreaterThan(30_000);
  });
});

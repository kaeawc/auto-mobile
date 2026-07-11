import { describe, expect, test } from "bun:test";
import { WebRtcPublisher } from "../../../src/features/webrtc/WebRtcPublisher";
import type { WhipClient, WhipClientOptions } from "../../../src/features/webrtc/WhipClient";

/**
 * Unit tests for publisher wiring that can be asserted without a real peer
 * connection. The full media path is covered by WebRtcPublisher.loopback.test.ts
 * and the coordination-server e2e test.
 */
describe("WebRtcPublisher WHIP endpoint", () => {
  function captureEndpoint(whipEndpoint: string, streamId: string): string {
    let captured: WhipClientOptions | undefined;

    new WebRtcPublisher(
      { streamId, whipEndpoint },
      {
        createWhipClient: options => {
          captured = options;
          return {} as unknown as WhipClient;
        },
      }
    );
    return captured!.endpoint;
  }

  test("appends the stream id as a query parameter", () => {
    expect(captureEndpoint("https://coord.example.com/whip", "ci-run-42")).toBe(
      "https://coord.example.com/whip?streamId=ci-run-42"
    );
  });

  test("preserves an existing streamId query parameter", () => {
    expect(captureEndpoint("https://coord.example.com/whip?streamId=explicit", "generated")).toBe(
      "https://coord.example.com/whip?streamId=explicit"
    );
  });

  test("keeps other query parameters intact", () => {
    const endpoint = captureEndpoint("https://coord.example.com/whip?region=us", "s1");
    expect(endpoint).toContain("region=us");
    expect(endpoint).toContain("streamId=s1");
  });
});

describe("WebRtcPublisher.notifySourceFailed", () => {
  test("is a no-op after close (does not throw)", async () => {
    const publisher = new WebRtcPublisher(
      { streamId: "s", whipEndpoint: "https://coord/whip" },
      { createWhipClient: () => ({}) as unknown as WhipClient }
    );
    await publisher.stop();
    expect(() => publisher.notifySourceFailed()).not.toThrow();
  });
});

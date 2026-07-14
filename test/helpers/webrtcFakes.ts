import type { FetchLike } from "../../src/features/webrtc/WhipClient";

export interface RecordedWhipRequest {
  url: string;
  method: string;
}

export class FakeConnectedPeerConnection {
  closed = false;
  connectionState = "connected";
  iceGatheringState = "complete";
  connectionStateChange = { subscribe: () => {} };
  iceGatheringStateChange = { watch: async () => {} };
  localDescription = { sdp: "v=0" };

  addTransceiver() {
    return { sender: { ssrc: 1 } };
  }

  async createOffer() {
    return { type: "offer", sdp: "v=0" };
  }

  async setLocalDescription() {}

  async setRemoteDescription() {}

  async close() {
    this.closed = true;
  }
}

export class FakeH264Source {
  started = false;
  stopped = false;

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}

export function createSuccessfulWhipFetch(
  requests: RecordedWhipRequest[],
  location: string = "/whip/resource/debug-1"
): FetchLike {
  return async (url, init) => {
    requests.push({ url, method: init.method });
    return {
      status: 201,
      ok: true,
      headers: { get: name => (name.toLowerCase() === "location" ? location : null) },
      text: async () => "v=0",
    };
  };
}

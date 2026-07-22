import type { FetchLike } from "../../src/features/webrtc/WhipClient";

export const VIDEO_ONLY_WHIP_ANSWER = [
  "v=0",
  "m=video 9 UDP/TLS/RTP/SAVPF 96",
  "a=recvonly",
  "a=rtpmap:96 H264/90000",
  "",
].join("\r\n");

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
      text: async () => VIDEO_ONLY_WHIP_ANSWER,
    };
  };
}

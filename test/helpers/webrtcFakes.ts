import type { FetchLike } from "../../src/features/webrtc/WhipClient";

/**
 * Build a WHEP answer that accepts a video-only H.264 ingest at the given
 * `profile-level-id`. A conformant WHIP server echoes the profile the publisher
 * offered, so a Main session (Android, issue #4756) must be answered with a Main
 * profile-level-id and a Baseline session (iOS/synthetic) with a Baseline one.
 */
export function videoOnlyWhipAnswer(profileLevelId: string = "42e02a"): string {
  return [
    "v=0",
    "m=video 9 UDP/TLS/RTP/SAVPF 96",
    "a=recvonly",
    "a=rtpmap:96 H264/90000",
    `a=fmtp:96 packetization-mode=1;profile-level-id=${profileLevelId}`,
    "",
  ].join("\r\n");
}

/** Baseline (`42e02a`) video-only WHIP answer for constrained-baseline sessions. */
export const VIDEO_ONLY_WHIP_ANSWER = videoOnlyWhipAnswer();

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
    return { sender: { ssrc: 1, onPictureLossIndication: { subscribe: () => {} } } };
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
  location: string = "/whip/resource/debug-1",
  // Default Baseline; an Android session negotiates Main and its WHIP server
  // must answer Main (issue #4756), so callers targeting Android pass `4d002a`.
  profileLevelId: string = "42e02a",
): FetchLike {
  const answerSdp = videoOnlyWhipAnswer(profileLevelId);
  return async (url, init) => {
    requests.push({ url, method: init.method });
    return {
      status: 201,
      ok: true,
      headers: { get: (name) => (name.toLowerCase() === "location" ? location : null) },
      text: async () => answerSdp,
    };
  };
}

import type { MediaStreamTrack, RTCPeerConnection } from "werift";

/** An ICE candidate as the trickle forwarder takes it; `null`/`undefined` ends gathering. */
export type TrickleCandidate =
  | { candidate: string; sdpMid?: string; sdpMLineIndex?: number }
  | null
  | undefined;

/** A transceiver as the publisher uses it: its sender's SSRC and PLI feed. */
interface PublisherTransceiver {
  readonly sender: {
    readonly ssrc: number;
    readonly onPictureLossIndication: { subscribe(listener: () => void): unknown };
  };
}

/** A session description as the publisher passes it between offer creation and installation. */
interface PublisherSessionDescription {
  readonly type: "offer" | "answer" | "pranswer";
  readonly sdp: string;
}

/**
 * The slice of werift's `RTCPeerConnection` the publisher drives. The real class satisfies it,
 * and so does a test double that models only these members, with no assertion at either end.
 */
export interface PublisherPeerConnection {
  readonly connectionState: RTCPeerConnection["connectionState"];
  readonly iceGatheringState: RTCPeerConnection["iceGatheringState"];
  readonly localDescription: { readonly sdp: string } | null | undefined;
  readonly connectionStateChange: {
    subscribe(listener: (state: RTCPeerConnection["connectionState"]) => void): unknown;
  };
  readonly iceGatheringStateChange: {
    watch(
      predicate: (state: RTCPeerConnection["iceGatheringState"]) => boolean,
      timeoutMs: number,
    ): Promise<unknown>;
  };
  readonly onIceCandidate: {
    subscribe(listener: (candidate: TrickleCandidate) => void): { unSubscribe: () => void };
  };
  addTransceiver(track: MediaStreamTrack, options: { direction: "sendonly" }): PublisherTransceiver;
  createOffer(): Promise<PublisherSessionDescription>;
  setLocalDescription(description: PublisherSessionDescription): Promise<unknown>;
  setRemoteDescription(description: PublisherSessionDescription): Promise<unknown>;
  close(): Promise<unknown>;
}

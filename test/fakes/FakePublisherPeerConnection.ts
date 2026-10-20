import type {
  GatheredIceCandidate,
  PublisherPeerConnection,
} from "../../src/features/webrtc/PublisherPeerConnection";

type ConnectionState = PublisherPeerConnection["connectionState"];

/**
 * Peer connection fake for WebRtcPublisher tests: the offer/answer path succeeds,
 * and the events the publisher subscribes to can be driven from the test.
 */
export class FakePublisherPeerConnection implements PublisherPeerConnection {
  closed = false;
  connectionState: ConnectionState = "new";
  iceGatheringState: PublisherPeerConnection["iceGatheringState"] = "complete";
  localDescription: { sdp: string } = { sdp: "v=0" };
  /** When true, ICE gathering never completes (proves trickle does not block on it). */
  gatheringNeverCompletes = false;
  /** A candidate emitted synchronously while the local description is installed. */
  candidateDuringSetLocalDescription?: GatheredIceCandidate;
  /** PLI callbacks the publisher subscribed on video senders (fire to simulate a relayed PLI). */
  pliSubscribers: Array<() => void> = [];

  private candidateListener?: (candidate: GatheredIceCandidate | null | undefined) => void;
  private connectionStateListener?: (state: ConnectionState) => void;

  readonly connectionStateChange = {
    subscribe: (listener: (state: ConnectionState) => void) => {
      this.connectionStateListener = listener;
      return {
        unSubscribe: () => {
          this.connectionStateListener = undefined;
        },
      };
    },
  };
  readonly iceGatheringStateChange = {
    watch: (): Promise<unknown> =>
      this.gatheringNeverCompletes ? new Promise<void>(() => {}) : Promise.resolve(),
  };
  readonly onIceCandidate = {
    subscribe: (listener: (candidate: GatheredIceCandidate | null | undefined) => void) => {
      this.candidateListener = listener;
      return { unSubscribe: () => {} };
    },
  };

  addTransceiver(_track: { kind: string }) {
    return this.createTransceiver(1);
  }

  protected createTransceiver(ssrc: number) {
    return {
      sender: {
        ssrc,
        onPictureLossIndication: {
          subscribe: (listener: () => void) => this.pliSubscribers.push(listener),
        },
      },
    };
  }

  async createOffer() {
    return { type: "offer" as const, sdp: "v=0" };
  }

  async setLocalDescription() {
    if (this.candidateDuringSetLocalDescription) {
      this.emitCandidate(this.candidateDuringSetLocalDescription);
    }
  }

  async setRemoteDescription() {}

  async close() {
    this.closed = true;
  }

  emitCandidate(candidate: GatheredIceCandidate | null): void {
    this.candidateListener?.(candidate);
  }

  emitConnectionState(state: "connected" | "failed" | "disconnected"): void {
    this.connectionState = state;
    this.connectionStateListener?.(state);
  }
}

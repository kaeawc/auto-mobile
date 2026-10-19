import type { MediaStreamTrack, RTCPeerConnection } from "werift";

type ConnectionState = RTCPeerConnection["connectionState"];
type IceGatheringState = RTCPeerConnection["iceGatheringState"];
type LocalDescriptionInit = NonNullable<Parameters<RTCPeerConnection["setLocalDescription"]>[0]>;
type RemoteDescriptionInit = Parameters<RTCPeerConnection["setRemoteDescription"]>[0];

/** A gathered ICE candidate (or the end-of-candidates marker when absent). */
export interface GatheredIceCandidate {
  candidate: string;
  sdpMid?: string;
  sdpMLineIndex?: number;
}

/**
 * The peer-connection surface WebRtcPublisher consumes. Narrow on purpose so a
 * test fake can satisfy it without implementing the whole werift connection.
 */
export interface PublisherPeerConnection {
  readonly connectionState: ConnectionState;
  readonly iceGatheringState: IceGatheringState;
  readonly localDescription: { sdp: string } | null;
  readonly connectionStateChange: {
    subscribe(listener: (state: ConnectionState) => void): unknown;
  };
  readonly iceGatheringStateChange: {
    watch(predicate: (state: IceGatheringState) => boolean, timeoutMs?: number): Promise<unknown>;
  };
  readonly onIceCandidate: {
    subscribe(listener: (candidate: GatheredIceCandidate | null | undefined) => void): {
      unSubscribe: () => void;
    };
  };
  addTransceiver(
    track: MediaStreamTrack,
    options: { direction: "sendonly" },
  ): {
    sender: {
      readonly ssrc: number;
      readonly onPictureLossIndication: { subscribe(listener: () => void): unknown };
    };
  };
  createOffer(): Promise<LocalDescriptionInit>;
  setLocalDescription(description: LocalDescriptionInit): Promise<unknown>;
  setRemoteDescription(description: RemoteDescriptionInit): Promise<void>;
  close(): Promise<void>;
}

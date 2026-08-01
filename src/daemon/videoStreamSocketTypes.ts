/**
 * Wire types for the local video-stream relay socket (`~/.auto-mobile/video-stream.sock`).
 *
 * Unlike every other daemon socket this one is **not** newline-JSON end to end. A client sends a
 * single JSON subscribe line and receives a single JSON acknowledgement line; after that the
 * connection carries raw binary in the `VideoStreamProtocol` framing the on-device encoder already
 * speaks (see `android/video-server/.../VideoStreamProtocol.kt`), so a 4-8 Mbps H.264 stream does
 * not pay a ~33% base64 tax per frame.
 *
 * This is the local live-mirroring path. It is deliberately separate from the WebRTC/WHIP path,
 * which publishes to a remote coordination server for browser viewers and cannot be consumed
 * locally.
 */

export type VideoStreamAction = "subscribe" | "unsubscribe";

export interface VideoStreamSocketRequest {
  id?: string;
  action: VideoStreamAction;
  /**
   * Session UUID admitting this subscribe request (issue #4751). The daemon
   * authenticates against its live session registry (the #4655 session
   * mechanism) so an unauthenticated process cannot ride along on the raw H.264
   * screen stream, and rejects a subscribe to a device owned by another session.
   */
  sessionUuid?: string;
  /** Device to mirror. Defaults to the sole connected device when omitted. */
  deviceId?: string;
  /** Encoder bitrate hint, passed through to the capture source. */
  bitrateKbps?: number;
  /** Capture size hint. Decoders read true dimensions from the in-band SPS regardless. */
  size?: { width: number; height: number };
  /**
   * Capture quality preset, passed through to the capture source. Selects an
   * aspect-preserving resolution cap and default bitrate (see the device
   * `QualityPreset`: low=540p/2Mbps, medium=720p/4Mbps, high=1080p/8Mbps). The
   * right knob for many-stream farm viewers, which want lower decode cost per
   * pane; an explicit `size` wins over the preset's cap.
   */
  quality?: "low" | "medium" | "high";
  /**
   * Capture frame-rate hint, passed through to the capture source. When omitted
   * the relay pins its existing per-platform default; farm viewers can lower it
   * to shed encode + decode load across dozens of streams.
   */
  fps?: number;
}

export interface VideoStreamSocketResponse {
  id?: string;
  type: "video_stream_response";
  success: boolean;
  action?: VideoStreamAction;
  /** Device the stream is bound to, echoed so a client that omitted it learns the resolution. */
  deviceId?: string;
  /**
   * Framing that follows this line on the same connection. `h264` is the 12-byte legacy header
   * plus 12-byte packet headers; audio muxing is not offered by this relay.
   */
  framing?: "h264";
  error?: string;
}

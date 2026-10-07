import type {
  StreamSubscriptionEndReason,
  StreamSubscriptionKind,
} from "./streamSubscriptionPolicy";

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
 *
 * Admission still requires a live session and a device unowned or owned by that session.
 * An owning subscriber is an owner; an unowned-device subscriber is a read-only viewer. Viewers
 * survive ownership changes, and a live owner losing ownership downgrades to viewer. Either kind
 * ends when its own session ends (session_ended), the device is removed (device_removed) or
 * VM-restored (device_restored), its identity is quarantined (identity_quarantined), or the daemon
 * closes (daemon_shutdown).
 * Auth-off admits with owner semantics and skips ownership reconciliation and its notices.
 * Subscribe-time quality/fps/bitrate hints work for both kinds and can start/retain shared capture.
 * The relay has no post-subscribe controls: all extra lines are ignored without a reply (writing
 * JSON into a continuing binary stream would corrupt framing); viewers cannot send controls.
 *
 * Additive subscription notices use a 12-byte packet header: big-endian int64 ptsAndFlags with
 * bit 61 set, CONFIG (63), KEY (62), heartbeat (60) and dropped-frames (59) clear, code in bits
 * 0-58, followed by big-endian int32 zero payload length. Codes: 1=downgraded_to_viewer,
 * 2=device_removed, 3=identity_quarantined, 4=daemon_shutdown, 5=session_ended, 6=device_restored.
 * VM restore is a distinct end for the captured incarnation. Old clients ignore
 * the empty non-CONFIG payload. Downgrade sends only this packet and keeps flowing. End sends
 * this packet then a terminal JSON line and closes; pending/pre-ack sockets get only JSON.
 * To resume after an end, subscribe again on a fresh socket and pass admission again.
 */

export type VideoStreamAction = "subscribe" | "unsubscribe";

/** A recoverable host permission required before a stream can start. */
export interface VideoStreamPermission {
  kind: "screen_recording";
  status: "needs_approval";
  /** User-facing app or process label shown by the matching macOS permission prompt. */
  approvalTarget: string;
}

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
  /** Scope discovery to this platform; omission preserves discovery across both. */
  platform?: "android" | "ios";
  /** Encoder bitrate hint, passed through to the capture source. */
  bitrateKbps?: number;
  /** Capture size hint. Decoders read true dimensions from the in-band SPS regardless. */
  size?: { width: number; height: number };
  /**
   * Capture quality preset, passed through to the capture source. Selects an
   * aspect-preserving resolution cap and default bitrate (see the device
   * `QualityPreset`: low=540p/2Mbps, medium=720p/4Mbps, high=1080p/8Mbps). The
   * right knob for many-stream farm viewers, which want lower decode cost per
   * pane; an explicit `size` wins over the preset's cap. Captures are shared
   * per device. A late subscriber's explicit quality, fps, or bitrate hint
   * updates the shared encode for every viewer after a short debounce; the
   * latest explicit value wins per field, while omitted fields retain their
   * current values. Existing sockets remain connected and wait for the new
   * encoder's parameter sets and keyframe. Size stays fixed until the capture
   * is released. Resolution caps currently apply on Android; iOS honors the
   * preset's bitrate but self-scales resolution to Level 4.2.
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
  /** Structured recovery state; accompanied by a concise legacy error for older clients. */
  permission?: VideoStreamPermission;
  /**
   * Interval, in milliseconds, at which the relay writes a zero-payload heartbeat packet to a
   * promoted subscriber while the capture is producing data (issue #7549). Lets a desktop client
   * tell "quietly healthy" apart from "silently dead" for sources with no idle output of their own
   * (screenrecord, iOS), instead of assuming only the Android persistent-encoder heartbeat exists.
   * Omitted by an older daemon; the desktop treats that as "no heartbeat available" and falls back
   * to its prior per-platform stall policy.
   */
  heartbeatMs?: number;
  /** Current owner/viewer kind, on the subscribe ack and terminal line. */
  subscriptionKind?: StreamSubscriptionKind;
  /** Typed lifecycle/authentication end reason; present on terminal lines. */
  reason?: StreamSubscriptionEndReason;
  /** Final JSON line after subscription ends; the socket then ends. */
  terminal?: boolean;
  error?: string;
}

package dev.jasonpearson.automobile.video

import android.media.MediaCodecInfo

/**
 * The H.264 profile the on-device MediaCodec encoder ([VideoEncoder]) requests.
 *
 * Main profile (issue #4756) saves ~10-30% bitrate at equal quality versus Constrained Baseline —
 * CABAC entropy coding with no B-frames, so no added latency — and both werift and Chromium decode
 * it. WebRTC negotiates exactly one `profile-level-id` per WHIP session, so the host publisher
 * advertises the matching Main `profile-level-id` (`4d002a`) and validates this encoder's SPS
 * against it. iOS and synthetic sources keep negotiating Constrained Baseline on their own
 * sessions; a GLOBAL Main switch was the reverted #4877 regression.
 *
 * These are `public static final int` constants in `android.jar` (Baseline = 0x01, Main = 0x02), so
 * they are inlined at compile time and remain readable under the module's compile-only Android stub
 * (no MediaCodec runtime), which lets [H264EncoderProfileTest] pin the choice.
 */
internal object H264EncoderProfile {
  /** Profile passed to `MediaFormat.KEY_PROFILE`. */
  const val KEY_PROFILE: Int = MediaCodecInfo.CodecProfileLevel.AVCProfileMain
}

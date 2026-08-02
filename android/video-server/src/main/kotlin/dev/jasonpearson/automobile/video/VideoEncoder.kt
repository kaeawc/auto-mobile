package dev.jasonpearson.automobile.video

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.os.Build
import android.os.Bundle
import android.view.Surface

/**
 * MediaCodec wrapper for H.264 encoding with Surface input.
 *
 * Configures the encoder for low-latency streaming with:
 * - H.264 Main profile ([H264EncoderProfile]) — saves ~10-30% bitrate at equal quality vs
 *   Constrained Baseline (CABAC, no B-frames, so no added latency). werift and Chromium both decode
 *   Main. The host publisher advertises the matching `profile-level-id` per session (issue #4756).
 * - Surface input for zero-copy GPU rendering
 * - VBR bitrate mode so bursty screen content lets idle frames stay cheap and transitions borrow
 *   headroom
 * - Frame repeat for idle screen optimization
 */
class VideoEncoder(
  private val width: Int,
  private val height: Int,
  private val bitrate: Int,
  private val fps: Int,
) {
  private var codec: MediaCodec? = null

  /** Input surface for the VirtualDisplay to render to. Available after [start]. */
  var inputSurface: Surface? = null
    private set

  /**
   * Configure and start the encoder.
   *
   * @return The input Surface for the VirtualDisplay
   */
  fun start(): Surface {
    val format =
      MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height).apply {
        // Bitrate
        setInteger(MediaFormat.KEY_BIT_RATE, bitrate)

        // Frame rate hint (actual rate is variable based on display updates)
        setInteger(MediaFormat.KEY_FRAME_RATE, fps)

        // Periodic IDR cadence. This is deliberately longer than a single short
        // GOP because IDRs are already served on demand: a downstream viewer PLI
        // is relayed as requestKeyFrame() (PARAMETER_KEY_REQUEST_SYNC_FRAME), and
        // a reattaching client is replayed cached SPS/PPS plus the latest IDR. A
        // late WebRTC reader therefore recovers via those paths rather than by
        // waiting for the periodic keyframe, so the periodic interval can relax
        // from 2s to 5s to save bandwidth at high bitrate without regressing
        // late-viewer recovery. Idle displays still repeat frames below, so the
        // stream remains bounded.
        setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 5)

        // Surface input (zero-copy from GPU)
        setInteger(
          MediaFormat.KEY_COLOR_FORMAT,
          MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface,
        )

        // Repeat frame after 100ms of no changes (reduces idle bandwidth)
        setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 100_000)

        // Request Main profile (issue #4756) but let MediaCodec choose a supported
        // level for this device and capture size. Main is universally supported by
        // hardware AVC encoders on modern API levels; the host publisher validates
        // the emitted SPS profile against the negotiated Main profile-level-id
        // before forwarding, so a device that falls back to a different profile
        // reconnects safely instead of making MediaCodec.configure() fail up front.
        setInteger(MediaFormat.KEY_PROFILE, H264EncoderProfile.KEY_PROFILE)

        // VBR (not CBR) for bursty screen-automation content. The transport is
        // adb forward over USB, so CBR's predictable pacing buys little here while
        // it pads idle frames to hit the target bitrate and starves transitions of
        // headroom (#4740). VBR treats KEY_BIT_RATE as a ceiling: idle stretches
        // stay cheap and transitions borrow the headroom. CQ (constant quality)
        // was evaluated but rejected — it swaps the bitrate target for KEY_QUALITY
        // tuning that varies per device and cannot be bounded on the egress path.
        setInteger(
          MediaFormat.KEY_BITRATE_MODE,
          MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_VBR,
        )

        // Request low latency mode on Android 11+ (API 30)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
          setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
        }
      }

    val encoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
    encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)

    val surface = encoder.createInputSurface()
    inputSurface = surface

    encoder.start()
    codec = encoder
    // The first surface submission can otherwise be a non-IDR on some devices.
    // Make decoder readiness an explicit startup requirement.
    requestKeyFrame()

    return surface
  }

  /**
   * Dequeue an output buffer from the encoder.
   *
   * @param bufferInfo Buffer info to be populated
   * @param timeoutUs Timeout in microseconds (-1 for infinite)
   * @return Buffer index, or negative value on error/timeout
   */
  fun dequeueOutputBuffer(bufferInfo: MediaCodec.BufferInfo, timeoutUs: Long): Int {
    return codec?.dequeueOutputBuffer(bufferInfo, timeoutUs) ?: -1
  }

  /** Get the output buffer at the given index. */
  fun getOutputBuffer(index: Int): java.nio.ByteBuffer? {
    return codec?.getOutputBuffer(index)
  }

  /** Release the output buffer at the given index. */
  fun releaseOutputBuffer(index: Int) {
    codec?.releaseOutputBuffer(index, false)
  }

  /**
   * Ask the encoder to emit an IDR as soon as possible, rather than waiting for the periodic
   * I-frame interval. Serves a downstream keyframe request (a WHEP viewer PLI relayed by the host)
   * so a late or recovering viewer decodes promptly. Safe to call from any thread and after the
   * codec has been released.
   */
  fun requestKeyFrame() {
    try {
      codec?.setParameters(
        Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0) }
      )
    } catch (_: IllegalStateException) {
      // Codec released concurrently with the request; the next frame recovers.
    }
  }

  /** Stop and release the encoder. */
  fun stop() {
    codec?.let { encoder ->
      try {
        encoder.stop()
      } catch (_: IllegalStateException) {
        // Already stopped
      }
      encoder.release()
    }
    codec = null
    inputSurface = null
  }
}

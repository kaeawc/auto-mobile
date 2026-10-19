package dev.jasonpearson.automobile.video

import android.media.MediaCodec
import dev.jasonpearson.automobile.video.wrappers.DisplayControl

internal data class VideoRunOptions(
  val width: Int,
  val height: Int,
  val densityDpi: Int,
  val bitrate: Int,
  val fps: Int,
  val audioEnabled: Boolean,
  val session: VideoSessionOptions,
  val quality: QualityPreset,
  val sizeOverride: Pair<Int, Int>?,
)

/** Owns capture resources and encoding for one invocation of the server entry point. */
internal class VideoServerSession {
  @Volatile private var running = true

  @Volatile private var encoder: VideoEncoder? = null
  // Volatile: the encode loop reads it for forceFrame() while the shutdown hook nulls it (#4383).
  @Volatile private var capture: ScreenCapture? = null
  @Volatile private var audioCapture: AudioCapture? = null
  @Volatile private var streamWriter: VideoStreamWriter? = null
  @Volatile private var sessionLease: VideoSessionLease? = null
  @Volatile private var rotationMonitor: RotationMonitor? = null

  // The output dimensions the current encoder/capture were created at. The encode loop compares a
  // freshly-recomputed pair against these to decide whether a rotation actually changed the output
  // size (#4785); 0<->180 and 90<->270 rotations leave the size unchanged and need no swap.
  @Volatile private var currentOutputWidth = 0
  @Volatile private var currentOutputHeight = 0

  // Set by the rotation monitor when the display rotates; consumed on the encode-loop thread, which
  // owns the encoder/capture lifecycle, so the swap never races concurrent MediaCodec access.
  @Volatile private var rotationPending = false

  fun start(options: VideoRunOptions) {
    val (width, height, densityDpi, bitrate, fps, audioEnabled, session) = options
    sessionLease =
      session.token
        ?.let { VideoSessionLease(session, android.os.Process.myPid()) }
        ?.also { it.start() }
    // Create the initial encoder + capture at the startup dimensions.
    createEncoderAndCapture(width, height, densityDpi, bitrate, fps)

    // Backstop for idle-screen frame starvation (#4383): on a static screen the mirror
    // stops submitting buffers, so KEY_REPEAT_PREVIOUS_FRAME_AFTER alone does not reliably
    // sustain output and a keyframe request cannot yield a fresh IDR. The heartbeat tells us
    // when to nudge the VirtualDisplay into re-submitting a frame.
    val heartbeat =
      FrameHeartbeat(clock = FrameHeartbeat.Clock { android.os.SystemClock.uptimeMillis() })
    heartbeat.start()
    val stats =
      VideoStatsAccumulator(
          socketName = session.socketName,
          clock = VideoStatsAccumulator.Clock { android.os.SystemClock.uptimeMillis() },
          droppedCount = { streamWriter?.droppedCount() ?: 0L },
        )
        .also { it.start() }

    startWriter(options, heartbeat)
    if (audioEnabled) startAudio()

    // Detect rotation and recreate capture/encoder at the new orientation's dimensions (#4785).
    // The monitor only flags the change; the swap runs on this encode-loop thread, which owns the
    // encoder/capture lifecycle, so it never races concurrent MediaCodec access. FrameHeartbeat and
    // VideoSessionLease are untouched by the swap and keep running across it.
    rotationMonitor =
      RotationMonitor(
          reader = { DisplayControl.getDisplayInfo().rotation },
          registrar = { onChanged -> DisplayControl.registerDisplayListener(onChanged) },
        )
        .also { it.start { rotationPending = true } }

    println("Streaming started")

    encode(options, heartbeat, stats)
  }

  private fun startWriter(options: VideoRunOptions, heartbeat: FrameHeartbeat) {
    val (width, height, _, _, _, audioEnabled, session) = options
    // The writer keeps the encoder alive while its LocalSocket client reconnects, replays cached
    // decoder state, and requests a new IDR at attach.
    val writer =
      VideoStreamWriter(
        session.socketName,
        width,
        height,
        audioEnabled,
        expectedToken = session.token,
        // Attest the live display rotation on every CONFIG packet (issue #4786). Read at
        // config-packet-write time on the encode loop, so after the #4785 rotation swap the new
        // encoder's SPS/PPS carries the new orientation.
        rotationProvider = { DisplayControl.getDisplayInfo().rotation },
      )
    streamWriter = writer
    writer.startCommandReader { command ->
      if (command == VideoStreamProtocol.COMMAND_REQUEST_KEY_FRAME) {
        encoder?.requestKeyFrame()
        heartbeat.onKeyFrameRequested()
      }
    }
    VideoServer.startWriter(writer, session) {
      println("VIDEO_SESSION_CLIENT_ATTACH socket=${session.socketName}")
      encoder?.requestKeyFrame()
      heartbeat.onKeyFrameRequested()
    }
    session.token?.let {
      // `proto=` advertises the pre-stream token-handshake version so a handshake-aware host can
      // negotiate before connecting (issue #4729); a pre-handshake host simply ignores the field.
      println(
        "VIDEO_SESSION_READY token=$it pid=${android.os.Process.myPid()} " +
          "socket=${session.socketName} proto=${VideoHandshake.PROTOCOL_VERSION}",
      )
    }
  }

  private fun startAudio() {
    val capture = AudioCapture()
    audioCapture = capture
    capture.start(
      onData = { data, ptsUs -> streamWriter?.writeAudioPacket(data, ptsUs) == true },
      onError = { message ->
        System.err.println(message)
        running = false
      },
    )
  }

  private fun encode(
    options: VideoRunOptions,
    heartbeat: FrameHeartbeat,
    stats: VideoStatsAccumulator,
  ) {
    // Encoding loop
    val bufferInfo = MediaCodec.BufferInfo()
    while (running) {
      // Snapshot the volatile streamWriter the shutdown hook nulls concurrently; a null
      // means teardown has begun, so exit the loop cleanly instead of throwing (#4748).
      val currentWriter = VideoServer.encodeLoopSnapshot(streamWriter) ?: break
      if (rotationPending) {
        rotationPending = false
        swapCaptureForRotation(options, heartbeat)
      }
      // Snapshot after a rotation swap so this iteration uses the replacement encoder.
      val currentEncoder = VideoServer.encodeLoopSnapshot(encoder) ?: break
      try {
        if (!writeFrame(currentEncoder, currentWriter, bufferInfo, heartbeat, stats)) break

        VideoServer.recoverFromFrameDrop(
          currentWriter::consumeDropGap,
          currentEncoder::requestKeyFrame,
          heartbeat,
        )
      } catch (error: IllegalStateException) {
        // Shutdown may release the captured codec while an encoder call is in progress.
        if (!VideoServer.isShutdownRace(running, error)) {
          throw error
        }
        break
      }

      // Backstop the encoder's own idle repeats: if the mirror has gone quiet (or a
      // keyframe request produced nothing), nudge it into re-submitting a fresh frame.
      if (heartbeat.poll()) {
        capture?.forceFrame()
      }

      stats.poll()?.let(::println)

      if (currentWriter.reconnectWindowExpired()) {
        println("VIDEO_CLIENT_RECONNECT_EXPIRED socket=${options.session.socketName}")
        running = false
      }
    }

    running = false
  }

  private fun writeFrame(
    currentEncoder: VideoEncoder,
    currentWriter: VideoStreamWriter,
    bufferInfo: MediaCodec.BufferInfo,
    heartbeat: FrameHeartbeat,
    stats: VideoStatsAccumulator,
  ): Boolean {
    val index = currentEncoder.dequeueOutputBuffer(bufferInfo, 100_000) // 100ms timeout
    if (index >= 0) {
      val buffer = currentEncoder.getOutputBuffer(index)
      if (buffer != null) {
        val success = currentWriter.writePacket(buffer, bufferInfo)
        if (!success) {
          println("Client disconnected")
          return false
        }
        if (
          VideoServer.shouldCountVideoStatsFrame(
            isCodecConfig = (bufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0,
          )
        ) {
          stats.onFrame(bufferInfo.size)
        }
      }
      currentEncoder.releaseOutputBuffer(index)
      heartbeat.onFrameEmitted()

      // Check for end of stream
      if ((bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
        println("End of stream")
        return false
      }
    }
    return true
  }

  /**
   * Create the encoder and screen capture at [width]x[height] and record the pair as the current
   * output dimensions. Shared by the initial startup path and the rotation swap so both build the
   * capture stack identically.
   */
  private fun createEncoderAndCapture(
    width: Int,
    height: Int,
    densityDpi: Int,
    bitrate: Int,
    fps: Int,
  ) {
    val newEncoder = VideoEncoder(width = width, height = height, bitrate = bitrate, fps = fps)
    val surface = newEncoder.start()
    val newCapture = ScreenCapture(width, height, densityDpi)
    newCapture.start(surface)
    encoder = newEncoder
    capture = newCapture
    currentOutputWidth = width
    currentOutputHeight = height
  }

  /**
   * Recreate the encoder and VirtualDisplay at the current display orientation's dimensions after a
   * rotation (issue #4785). Runs on the encode-loop thread so it owns the encoder/capture lifecycle
   * exclusively.
   *
   * Re-reads the display to get the post-rotation size, recomputes the output dimensions with the
   * SAME preset scaling used at startup, and returns early when the size is unchanged (0<->180 and
   * 90<->270 rotations, or an explicit `--size` that pins WxH) so no needless swap churns the
   * stream. On a real size change it resets the writer's replay cache atomically BEFORE tearing
   * down the old encoder, so a client attaching mid-swap can never replay the new SPS/PPS against
   * the stale pre-rotation IDR; the new encoder's config+IDR then repopulate the cache and flow to
   * any attached client live, and to a reconnecting client via replay. Rotating back recomputes the
   * original dimensions and swaps again, so repeated rotations restore prior sizes.
   */
  private fun swapCaptureForRotation(options: VideoRunOptions, heartbeat: FrameHeartbeat) {
    val (_, _, _, bitrate, fps, _, _, quality, sizeOverride) = options
    val displayInfo = DisplayControl.getDisplayInfo()
    val next = VideoServer.resolveOutputDimensions(displayInfo, quality, sizeOverride)
    val current = currentOutputWidth to currentOutputHeight
    if (!VideoServer.dimensionsChanged(current, next)) {
      return
    }
    val (newWidth, newHeight) = next
    println(
      "VIDEO_ROTATION_SWAP rotation=${displayInfo.rotation} " +
        "from=${current.first}x${current.second} to=${newWidth}x$newHeight",
    )
    // Atomic w.r.t. the writer: clear the stale replay cache before the old encoder is gone so no
    // reconnecting client can be replayed a new-SPS/old-IDR mismatch mid-swap.
    streamWriter?.resetReplayCacheForResize()
    val oldCapture = capture
    val oldEncoder = encoder
    oldCapture?.stop()
    oldEncoder?.stop()
    createEncoderAndCapture(newWidth, newHeight, displayInfo.densityDpi, bitrate, fps)
    // Nudge a prompt fresh IDR so a static post-rotation screen does not starve viewers.
    heartbeat.onKeyFrameRequested()
  }

  fun shutdown() {
    running = false
    rotationMonitor?.stop()
    audioCapture?.stop()
    streamWriter?.stop()
    // Atomically detach the pair so concurrent shutdown calls cannot stop it twice.
    val (oldCapture, oldEncoder) =
      synchronized(this) {
        val detached = capture to encoder
        capture = null
        encoder = null
        detached
      }
    oldCapture?.stop()
    oldEncoder?.stop()

    rotationMonitor = null
    audioCapture = null
    streamWriter = null
    sessionLease?.stop()
    sessionLease = null

    println("Shutdown complete")
  }
}

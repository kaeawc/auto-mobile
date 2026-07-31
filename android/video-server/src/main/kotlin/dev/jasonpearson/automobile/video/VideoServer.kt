package dev.jasonpearson.automobile.video

import android.media.MediaCodec
import dev.jasonpearson.automobile.video.wrappers.DisplayControl

/**
 * Main entry point for the video streaming server.
 *
 * This server captures the device screen using VirtualDisplay, encodes it as H.264 using
 * MediaCodec, and streams the encoded video over a LocalSocket.
 *
 * ## Usage
 *
 * ```bash
 * # Build + push the DEX jar (includes the Kotlin stdlib)
 * ./gradlew :video-server:d8Dex
 * adb push android/video-server/build/libs/automobile-video.jar /data/local/tmp/
 *
 * # Run server
 * adb shell CLASSPATH=/data/local/tmp/automobile-video.jar \
 *     app_process / dev.jasonpearson.automobile.video.VideoServer --quality medium
 * ```
 *
 * ## Quality presets
 * - `low`: 540p @ 2 Mbps @ 30fps
 * - `medium`: 720p @ 4 Mbps @ 30fps (default)
 * - `high`: 1080p @ 8 Mbps @ 30fps
 *
 * The preset frame rate is only a default; `--fps <n>` overrides it.
 */
object VideoServer {
  @Volatile private var running = true

  @Volatile private var encoder: VideoEncoder? = null
  // Volatile: the encode loop reads it for forceFrame() while the shutdown hook nulls it (#4383).
  @Volatile private var capture: ScreenCapture? = null
  @Volatile private var audioCapture: AudioCapture? = null
  @Volatile private var streamWriter: VideoStreamWriter? = null
  @Volatile private var sessionLease: VideoSessionLease? = null

  @JvmStatic
  fun main(args: Array<String>) {
    // Running inside `app_process` there is no Application, so the main thread
    // has no Looper. Framework internals reached during VirtualDisplay setup
    // (ActivityThread.systemMain -> Handler) require one, so prepare it first.
    if (android.os.Looper.myLooper() == null) {
      android.os.Looper.prepareMainLooper()
    }

    running = true
    val quality = parseQuality(args)
    val bitrateOverride = parseIntFlag(args, "--bit-rate")
    val fps = resolveFps(args, quality)
    val sizeOverride = parseSizeFlag(args)
    val audioEnabled = args.contains("--audio")
    val session = VideoSessionArguments.parse(args)

    println("AutoMobile Video Server")
    println("Quality preset: ${quality.name}")

    // Get display info
    val displayInfo = DisplayControl.getDisplayInfo()
    println("Display: ${displayInfo.width}x${displayInfo.height} @ ${displayInfo.densityDpi}dpi")

    // Output dimensions: an explicit --size wins, otherwise scale by the preset.
    val (outputWidth, outputHeight) =
      sizeOverride ?: calculateOutputDimensions(displayInfo, quality)
    val bitrate = bitrateOverride ?: quality.bitrate
    println("Output: ${outputWidth}x${outputHeight} @ ${bitrate / 1_000_000}Mbps @ ${fps}fps")
    println("Audio: ${if (audioEnabled) "enabled" else "disabled"}")

    // Install shutdown hook for clean termination
    Runtime.getRuntime()
      .addShutdownHook(
        Thread {
          println("\nShutting down...")
          running = false
          shutdown()
        }
      )

    try {
      sessionLease =
        session.token
          ?.let { VideoSessionLease(session, android.os.Process.myPid()) }
          ?.also { it.start() }
      run(
        outputWidth,
        outputHeight,
        displayInfo.densityDpi,
        bitrate,
        fps,
        audioEnabled,
        session,
      )
    } catch (e: Exception) {
      System.err.println("Error: ${e.message}")
      e.printStackTrace()
    } finally {
      shutdown()
    }
  }

  internal fun parseQuality(args: Array<String>): QualityPreset {
    var i = 0
    while (i < args.size) {
      when (args[i]) {
        "--quality",
        "-q" -> {
          if (i + 1 < args.size) {
            return try {
              QualityPreset.fromString(args[i + 1])
            } catch (e: IllegalArgumentException) {
              System.err.println("Invalid quality preset: ${args[i + 1]}")
              System.err.println("Valid values: low, medium, high")
              QualityPreset.MEDIUM
            }
          }
        }
        "--help",
        "-h" -> {
          printUsage()
          System.exit(0)
        }
      }
      i++
    }
    return QualityPreset.MEDIUM
  }

  /**
   * Resolve the effective frame rate: an explicit positive `--fps <n>` wins, otherwise fall back to
   * the preset default. The frame rate is intentionally decoupled from the quality preset so a host
   * can lower it (e.g. to 30fps for UI automation) without also lowering resolution/bitrate.
   */
  internal fun resolveFps(args: Array<String>, quality: QualityPreset): Int =
    parseIntFlag(args, "--fps") ?: quality.fps

  /** Read the integer value following [flag], or null if absent/invalid. */
  internal fun parseIntFlag(args: Array<String>, flag: String): Int? {
    val index = args.indexOf(flag)
    if (index < 0 || index + 1 >= args.size) {
      return null
    }
    return args[index + 1].toIntOrNull()?.takeIf { it > 0 }
  }

  /** Parse `--size WxH` into an even-rounded (width, height) pair, or null. */
  internal fun parseSizeFlag(args: Array<String>): Pair<Int, Int>? {
    val index = args.indexOf("--size")
    if (index < 0 || index + 1 >= args.size) {
      return null
    }
    val parts = args[index + 1].split("x", "X")
    if (parts.size != 2) {
      return null
    }
    val width = parts[0].toIntOrNull()?.takeIf { it > 0 } ?: return null
    val height = parts[1].toIntOrNull()?.takeIf { it > 0 } ?: return null
    // MediaCodec requires even, non-zero dimensions. Silently rounding 1x1 to 0x0
    // defers a bad command-line value into an opaque encoder failure.
    val evenWidth = width and 0xFFFE
    val evenHeight = height and 0xFFFE
    return if (evenWidth > 0 && evenHeight > 0) evenWidth to evenHeight else null
  }

  private fun printUsage() {
    println(
      """
      Usage: VideoServer [options]

      Options:
        --quality, -q <preset>  Quality preset: low, medium, high (default: medium)
        --bit-rate <bps>        Override the preset bitrate (bits per second)
        --fps <n>               Override the preset frame rate (frames per second)
        --size <WxH>            Override the output resolution (e.g. 720x1280)
        --audio                 Capture device playback audio as 8 kHz mono PCM16
        --help, -h              Show this help message

      Quality presets:
        low     540p @ 2 Mbps @ 30fps
        medium  720p @ 4 Mbps @ 30fps
        high    1080p @ 8 Mbps @ 30fps
      """
        .trimIndent()
    )
  }

  private fun calculateOutputDimensions(
    displayInfo: DisplayControl.DisplayInfo,
    quality: QualityPreset,
  ): Pair<Int, Int> {
    val displayWidth = displayInfo.width
    val displayHeight = displayInfo.height

    // Portrait: height is the larger dimension
    // Landscape: width is the larger dimension
    val isPortrait = displayHeight > displayWidth

    if (isPortrait) {
      // Scale based on height
      if (displayHeight <= quality.maxHeight) {
        return evenDimensions(displayWidth, displayHeight)
      }
      val scale = quality.maxHeight.toFloat() / displayHeight.toFloat()
      val scaledWidth = (displayWidth * scale).toInt() and 0xFFFE // Round to even
      return scaledWidth to quality.maxHeight
    } else {
      // Scale based on width (landscape)
      if (displayWidth <= quality.maxHeight) {
        return evenDimensions(displayWidth, displayHeight)
      }
      val scale = quality.maxHeight.toFloat() / displayWidth.toFloat()
      val scaledHeight = (displayHeight * scale).toInt() and 0xFFFE // Round to even
      return quality.maxHeight to scaledHeight
    }
  }

  private fun evenDimensions(width: Int, height: Int): Pair<Int, Int> =
    (width and 0xFFFE) to (height and 0xFFFE)

  private fun run(
    width: Int,
    height: Int,
    densityDpi: Int,
    bitrate: Int,
    fps: Int,
    audioEnabled: Boolean,
    session: VideoSessionOptions,
  ) {
    // Create encoder
    encoder =
      VideoEncoder(
        width = width,
        height = height,
        bitrate = bitrate,
        fps = fps,
      )
    val surface = encoder!!.start()

    // Create screen capture
    capture = ScreenCapture(width, height, densityDpi)
    capture!!.start(surface)

    // Backstop for idle-screen frame starvation (#4383): on a static screen the mirror
    // stops submitting buffers, so KEY_REPEAT_PREVIOUS_FRAME_AFTER alone does not reliably
    // sustain output and a keyframe request cannot yield a fresh IDR. The heartbeat tells us
    // when to nudge the VirtualDisplay into re-submitting a frame.
    val heartbeat =
      FrameHeartbeat(clock = FrameHeartbeat.Clock { android.os.SystemClock.uptimeMillis() })
    heartbeat.start()

    // The writer keeps the encoder alive while its LocalSocket client reconnects, replays cached
    // decoder state, and requests a new IDR at attach.
    streamWriter =
      VideoStreamWriter(
        session.socketName,
        width,
        height,
        audioEnabled,
        expectedToken = session.token,
      )
    streamWriter!!.startCommandReader { command ->
      if (command == VideoStreamProtocol.COMMAND_REQUEST_KEY_FRAME) {
        encoder?.requestKeyFrame()
        heartbeat.onKeyFrameRequested()
      }
    }
    try {
      streamWriter!!.start {
        println("VIDEO_SESSION_CLIENT_ATTACH socket=${session.socketName}")
        encoder?.requestKeyFrame()
        heartbeat.onKeyFrameRequested()
      }
    } catch (error: Exception) {
      VideoSessionLease.collisionDiagnostic(session.socketName, session.token)?.let(::println)
      throw error
    }
    session.token?.let {
      // `proto=` advertises the pre-stream token-handshake version so a handshake-aware host can
      // negotiate before connecting (issue #4729); a pre-handshake host simply ignores the field.
      println(
        "VIDEO_SESSION_READY token=$it pid=${android.os.Process.myPid()} " +
          "socket=${session.socketName} proto=${VideoHandshake.PROTOCOL_VERSION}"
      )
    }

    if (audioEnabled) {
      audioCapture = AudioCapture()
      audioCapture!!.start(
        onData = { data, ptsUs -> streamWriter?.writeAudioPacket(data, ptsUs) == true },
        onError = { message ->
          System.err.println(message)
          running = false
        },
      )
    }

    println("Streaming started")

    // Encoding loop
    val bufferInfo = MediaCodec.BufferInfo()
    while (running) {
      // Snapshot the volatile streamWriter the shutdown hook nulls concurrently; a null
      // means teardown has begun, so exit the loop cleanly instead of throwing (#4748).
      val currentWriter = encodeLoopSnapshot(streamWriter) ?: break
      val index = encoder!!.dequeueOutputBuffer(bufferInfo, 100_000) // 100ms timeout
      if (index >= 0) {
        val buffer = encoder!!.getOutputBuffer(index)
        if (buffer != null) {
          val success = currentWriter.writePacket(buffer, bufferInfo)
          if (!success) {
            println("Client disconnected")
            break
          }
        }
        encoder!!.releaseOutputBuffer(index)
        heartbeat.onFrameEmitted()

        // Check for end of stream
        if ((bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
          println("End of stream")
          break
        }
      }

      // Backstop the encoder's own idle repeats: if the mirror has gone quiet (or a
      // keyframe request produced nothing), nudge it into re-submitting a fresh frame.
      if (heartbeat.poll()) {
        capture?.forceFrame()
      }

      if (currentWriter.reconnectWindowExpired()) {
        println("VIDEO_CLIENT_RECONNECT_EXPIRED socket=${session.socketName}")
        running = false
      }
    }

    running = false
  }

  /**
   * Snapshot a volatile field the shutdown hook may null on another thread. The encode loop calls
   * this instead of a `!!` deref so a concurrent null observed mid-shutdown yields a clean stop
   * signal (null) rather than a [NullPointerException] (#4748). Kept as a seam so the loop's
   * null-tolerance is unit-testable without the Android capture stack.
   */
  internal fun <T : Any> encodeLoopSnapshot(field: T?): T? = field

  private fun shutdown() {
    running = false
    audioCapture?.stop()
    streamWriter?.stop()
    capture?.stop()
    encoder?.stop()

    audioCapture = null
    streamWriter = null
    capture = null
    encoder = null
    sessionLease?.stop()
    sessionLease = null

    println("Shutdown complete")
  }
}

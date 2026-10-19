package dev.jasonpearson.automobile.video

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
  @JvmStatic
  fun main(args: Array<String>) {
    // Running inside `app_process` there is no Application, so the main thread
    // has no Looper. Framework internals reached during VirtualDisplay setup
    // (ActivityThread.systemMain -> Handler) require one, so prepare it first.
    if (android.os.Looper.myLooper() == null) {
      android.os.Looper.prepareMainLooper()
    }

    val server = VideoServerSession()
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
          server.shutdown()
        },
      )

    try {
      server.start(
        VideoRunOptions(
          outputWidth,
          outputHeight,
          displayInfo.densityDpi,
          bitrate,
          fps,
          audioEnabled,
          session,
          quality,
          sizeOverride,
        ),
      )
    } catch (e: Exception) {
      System.err.println("Error: ${e.message}")
      System.err.println(e.stackTraceToString())
    } finally {
      server.shutdown()
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
              System.err.println("Invalid quality preset: ${args[i + 1]}: $e")
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
        .trimIndent(),
    )
  }

  /**
   * Resolve the effective output dimensions for a display reading. An explicit `--size` override
   * pins the exact WxH regardless of orientation (the least-surprising behavior for an explicit
   * request: the operator asked for a specific frame size, so rotation must not silently swap it);
   * with `--size` set, a rotation therefore never changes the resolved size and no encoder swap
   * occurs — the mirror is letterboxed within the pinned surface. Otherwise the dimensions are
   * derived from the current display size scaled by the preset, so re-reading [displayInfo] after a
   * rotation yields the correctly-oriented output size (issue #4785).
   */
  internal fun resolveOutputDimensions(
    displayInfo: DisplayControl.DisplayInfo,
    quality: QualityPreset,
    sizeOverride: Pair<Int, Int>?,
  ): Pair<Int, Int> = sizeOverride ?: calculateOutputDimensions(displayInfo, quality)

  /** True when a re-read produced a different output size, i.e. a swap is warranted (#4785). */
  internal fun dimensionsChanged(current: Pair<Int, Int>, next: Pair<Int, Int>): Boolean =
    current != next

  internal fun calculateOutputDimensions(
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
      val scaledWidth = (displayWidth * scale).toInt()
      return evenDimensions(scaledWidth, quality.maxHeight)
    } else {
      // Scale based on width (landscape)
      if (displayWidth <= quality.maxHeight) {
        return evenDimensions(displayWidth, displayHeight)
      }
      val scale = quality.maxHeight.toFloat() / displayWidth.toFloat()
      val scaledHeight = (displayHeight * scale).toInt()
      return evenDimensions(quality.maxHeight, scaledHeight)
    }
  }

  private fun evenDimensions(width: Int, height: Int): Pair<Int, Int> =
    maxOf(2, width and 0xFFFE) to maxOf(2, height and 0xFFFE)

  internal fun startWriter(
    writer: VideoStreamWriter,
    session: VideoSessionOptions,
    onClientConnected: () -> Unit,
  ) {
    try {
      writer.start(onClientConnected)
    } catch (error: Exception) {
      VideoSessionLease.collisionDiagnostic(session.socketName, session.token)?.let(::println)
      throw error
    }
  }
}

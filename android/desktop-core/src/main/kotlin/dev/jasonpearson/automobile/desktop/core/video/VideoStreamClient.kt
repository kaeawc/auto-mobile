package dev.jasonpearson.automobile.desktop.core.video

import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.toComposeImageBitmap
import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileSocketPaths
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import java.io.BufferedWriter
import java.io.File
import java.io.OutputStreamWriter
import java.net.UnixDomainSocketAddress
import java.nio.channels.Channels
import java.nio.channels.SocketChannel
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.serializer
import org.jetbrains.skia.ColorAlphaType
import org.jetbrains.skia.ColorType
import org.jetbrains.skia.Image
import org.jetbrains.skia.ImageInfo

/** Socket file the daemon binds for the local live-mirroring relay. */
internal const val VIDEO_STREAM_SOCKET_FILE = "video-stream.sock"

private val LOG = LoggerFactory.getLogger("VideoStreamClient")

/** Where a live mirroring session currently stands. */
sealed class VideoStreamState {
  data object Idle : VideoStreamState()

  data object Connecting : VideoStreamState()

  data class Streaming(val width: Int, val height: Int) : VideoStreamState()

  /** A named host permission blocked the current subscribe attempt. */
  data class PermissionRequired(
    val permission: VideoStreamPermission,
    val approvalTarget: String,
  ) : VideoStreamState()

  /** Terminal for this attempt; [reason] is safe to show a user. */
  data class Unavailable(val reason: String) : VideoStreamState()
}

/** Recoverable permission state decoded from the local relay protocol. */
enum class VideoStreamPermission {
  ScreenRecordingNeedsApproval
}

/**
 * Resolution/bitrate preset for a subscription, matching the daemon relay's `quality` hint (and,
 * transitively, the on-device `QualityPreset`): on Android the capture's LONGER dimension is capped
 * at 540/720/1080 with the other side scaled proportionally; iOS honors the preset's bitrate but
 * self-scales resolution to Level 4.2. Lower presets shrink decode cost quadratically, which is
 * what makes dozens of concurrent farm panes affordable. Captures are shared per device on the
 * daemon: the FIRST subscriber's hints fix the encode, and a late joiner's differing preset is
 * ignored.
 */
enum class VideoStreamQuality(internal val wire: String) {
  Low("low"),
  Medium("medium"),
  High("high");

  /** The next preset down (cheaper), clamped at [Low]. */
  fun lower(): VideoStreamQuality = entries[(ordinal - 1).coerceAtLeast(0)]

  /** The next preset up (sharper), clamped at [High]. */
  fun higher(): VideoStreamQuality = entries[(ordinal + 1).coerceAtMost(entries.lastIndex)]

  companion object {
    /** Parses a persisted/wire string case-insensitively, or null when it names no preset. */
    fun fromWire(value: String?): VideoStreamQuality? = entries.firstOrNull {
      it.wire.equals(value, ignoreCase = true)
    }
  }
}

/** A live view of a device's screen. */
interface VideoStreamSource {
  val frames: SharedFlow<LiveVideoFrame>
  val state: StateFlow<VideoStreamState>

  fun connect(deviceId: String?)

  fun disconnect()

  /** Releases any resources owned by this source. It cannot be reused afterwards. */
  fun dispose()

  /** True when the daemon exposes the relay socket; false on daemons that predate it. */
  fun isAvailable(): Boolean
}

/** Converts a decoded frame into something Compose can draw. */
fun DecodedFrame.toImageBitmap(): ImageBitmap =
  Image.makeRaster(
      ImageInfo(width, height, ColorType.BGRA_8888, ColorAlphaType.OPAQUE),
      bgra,
      width * 4,
    )
    .toComposeImageBitmap()

/**
 * Streams a device's screen from `~/.auto-mobile/video-stream.sock` and decodes it to frames.
 *
 * The handshake is one JSON line each way; everything after is the binary framing handled by
 * [VideoStreamParser]. Decoding AND bitmap conversion happen on the reader thread, which is
 * deliberate: it applies backpressure to the socket rather than letting undecoded packets pile up
 * in memory, and it keeps the per-frame work off the UI's dispatchers entirely. The reader is a
 * dedicated per-client thread rather than a `Dispatchers.IO` slot so a farm of dozens of streams
 * cannot exhaust the shared 64-thread IO pool for every other IO consumer in the process.
 *
 * [frames] carries ready-to-draw [LiveVideoFrame]s (immutable Skia rasters — no tearing, no
 * consumer-side conversion) and drops the oldest when a collector falls behind. For live video a
 * stale frame is worthless, and an unbounded buffer would trade latency for memory and lose on
 * both. Steady-state the pipeline allocates no JVM-heap frame buffers: the decoder reuses its BGRA
 * buffer and the only per-frame cost is the native raster copy inside [toImageBitmap].
 */
class VideoStreamClient(
  private val socketPathValue: String = AutoMobileSocketPaths.socketPath(VIDEO_STREAM_SOCKET_FILE),
  private val json: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    // `action` is a default on the request class but required on the wire; without this the
    // daemon receives no action and rejects the subscribe.
    encodeDefaults = true
  },
  private val decoderFactory: () -> H264Decoder = { H264Decoder() },
  /**
   * Supplies the daemon session UUID that authenticates the `subscribe` request against the
   * stream-socket session guard (issue #4751). Resolved at connect time so a session established
   * after construction is still used. Null (the default) omits the `sessionUuid` field via
   * [explicitNulls] = false, so the daemon rejects the subscribe unless it was started with
   * `AUTOMOBILE_DAEMON_STREAM_AUTH=0`. The desktop host supplies a provider from
   * `DesktopDaemonSession` for Unix-daemon connections.
   */
  private val sessionUuidProvider: () -> String? = { null },
  /** Resolution/bitrate preset hint sent on subscribe; null keeps the capture's default. */
  private val quality: VideoStreamQuality? = null,
  /** Capture frame-rate hint sent on subscribe; null keeps the relay's pinned default. */
  private val fps: Int? = null,
  /** Encoder bitrate hint (kbps) sent on subscribe; null keeps the preset's default. */
  private val bitrateKbps: Int? = null,
  /**
   * Monotonic clock stamping [LiveVideoFrame.receivedAtMs]. Must share a time base with the
   * consumer-side freshness checks (`MONOTONIC_NOW_MS`, issue #3348), hence the same
   * `System.nanoTime()` source by default; injectable for deterministic tests.
   */
  private val nowMs: () -> Long = { System.nanoTime() / 1_000_000L },
) : VideoStreamSource {

  // One dedicated reader thread per client (see the class doc for why not Dispatchers.IO).
  private val readerDispatcher =
    java.util.concurrent.Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "video-stream-reader").apply { isDaemon = true }
      }
      .asCoroutineDispatcher()
  private val scope = CoroutineScope(SupervisorJob() + readerDispatcher)

  private val frameSequence = java.util.concurrent.atomic.AtomicLong(0L)

  private val _frames =
    MutableSharedFlow<LiveVideoFrame>(
      replay = 1,
      extraBufferCapacity = 2,
      onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
  override val frames: SharedFlow<LiveVideoFrame> = _frames.asSharedFlow()

  private val _state = MutableStateFlow<VideoStreamState>(VideoStreamState.Idle)
  override val state: StateFlow<VideoStreamState> = _state.asStateFlow()

  private var channel: SocketChannel? = null
  private var readerJob: Job? = null

  // Session identity so a superseded reader's teardown can't clobber a newer session's state. A
  // rapid disconnect()+connect() (the stall / first-frame watchdog) installs the replacement reader
  // before the cancelled one unwinds; a stale reader that checked the mutable readerJob would see
  // the fresh job as active and publish its own Unavailable over the new session's Connecting,
  // wedging the stream. Keyed on this id every state write is dropped unless the reader is current.
  private val sessionIds = java.util.concurrent.atomic.AtomicLong(0L)
  @Volatile private var activeSessionId = 0L

  override fun isAvailable(): Boolean = Files.exists(File(socketPathValue).toPath())

  override fun connect(deviceId: String?) {
    if (readerJob?.isActive == true) return
    if (!isAvailable()) {
      _state.value = VideoStreamState.Unavailable("Live mirroring is unavailable on this daemon")
      return
    }

    val sessionId = sessionIds.incrementAndGet()
    activeSessionId = sessionId
    _state.value = VideoStreamState.Connecting
    readerJob = scope.launch {
      // Name the dedicated thread per target so a farm's dozens of readers are tellable
      // apart in a thread dump.
      Thread.currentThread().name = "video-stream-reader-${deviceId ?: "default"}"
      runSession(deviceId, sessionId)
    }
  }

  override fun disconnect() {
    // Invalidate the current session first so the cancelled reader's terminal state write is
    // dropped rather than racing an Unavailable over a subsequent Idle/Connecting.
    activeSessionId = sessionIds.incrementAndGet()
    readerJob?.cancel()
    readerJob = null
    closeChannel()
    _state.value = VideoStreamState.Idle
  }

  /** Disconnects and cancels the internal scope. The instance must not be reused afterwards. */
  override fun dispose() {
    disconnect()
    scope.coroutineContext[Job]?.cancel()
    readerDispatcher.close()
  }

  private fun runSession(deviceId: String?, sessionId: Long) {
    // Only the current session may touch shared state; a reader superseded by a reconnect (or a
    // disconnect) publishes nothing, so its late teardown can't clobber the live session.
    fun isCurrent() = sessionId == activeSessionId
    fun publish(state: VideoStreamState) {
      if (isCurrent()) _state.value = state
    }

    val decoder =
      try {
        decoderFactory()
      } catch (e: Exception) {
        LOG.warn("Could not create the H.264 decoder: ${e.message}", e)
        publish(VideoStreamState.Unavailable(e.message ?: "No H.264 decoder available"))
        return
      }

    try {
      SocketChannel.open(UnixDomainSocketAddress.of(socketPathValue)).use { socket ->
        if (isCurrent()) channel = socket
        val input = Channels.newInputStream(socket)
        val writer =
          BufferedWriter(
            OutputStreamWriter(Channels.newOutputStream(socket), StandardCharsets.UTF_8)
          )

        writer.write(
          json.encodeToString(
            serializer<VideoStreamRequest>(),
            VideoStreamRequest(
              id = UUID.randomUUID().toString(),
              sessionUuid = sessionUuidProvider(),
              deviceId = deviceId,
              quality = quality?.wire,
              fps = fps,
              bitrateKbps = bitrateKbps,
            ),
          )
        )
        writer.newLine()
        writer.flush()

        val ackLine = readAckLine(input)
        val ack = json.decodeFromString(serializer<VideoStreamResponse>(), ackLine)
        if (!ack.success) {
          publish(
            ack.permission.toPermissionState()
              ?: VideoStreamState.Unavailable(ack.error ?: "Live mirroring was refused")
          )
          return
        }

        pumpFrames(input, decoder, sessionId)
        publish(VideoStreamState.Unavailable("Live mirroring stopped"))
      }
    } catch (e: Exception) {
      // Cancellation (from disconnect / a watchdog reconnect) supersedes this session, so publish()
      // drops the terminal state; a genuine read error on the still-current session surfaces it.
      if (isCurrent()) {
        LOG.warn("Live mirroring stopped: ${e.message}", e)
        publish(VideoStreamState.Unavailable(e.message ?: "Live mirroring stopped"))
      }
    } finally {
      decoder.close()
      if (isCurrent()) channel = null
    }
  }

  /**
   * Reads the acknowledgement one byte at a time.
   *
   * A BufferedReader cannot be used here: it reads ahead to find the newline and would swallow the
   * first several KB of the binary stream that follows on the same connection.
   */
  private fun readAckLine(input: java.io.InputStream): String {
    val line = StringBuilder()
    while (true) {
      val byte = input.read()
      if (byte < 0) throw IllegalStateException("Relay closed during handshake")
      if (byte == '\n'.code) return line.toString()
      line.append(byte.toChar())
    }
  }

  private fun pumpFrames(input: java.io.InputStream, decoder: H264Decoder, sessionId: Long) {
    val parser = VideoStreamParser()
    val buffer = ByteArray(64 * 1024)
    // Latest attested rotation, updated by each config packet that carries it (issue #4786). A
    // config packet precedes the IDR it configures, so a decoded frame is stamped with the rotation
    // the current SPS/PPS attested. Stays null until the first attested config packet, so an
    // unattested stream (screenrecord/iOS relay) leaves the control gate to fail closed.
    var currentRotation: Int? = null
    // The decoder reuses its BGRA buffer, so fingerprint it before converting to the immutable
    // raster. A full-array hash uses no extra frame-sized copy and catches Android's repeated idle
    // output as unchanged; it is intentionally source-neutral for iOS too (#5582).
    var previousContentHash: Int? = null
    var previousWidth = 0
    var previousHeight = 0

    while (true) {
      val read = input.read(buffer)
      if (read <= 0) return

      parser.onBytes(
        buffer,
        read,
        onHeader = { header ->
          LOG.info("Live mirroring started (${header.width}x${header.height} advertised)")
        },
        onPacket = { packet ->
          if (packet.isConfig && packet.rotation != null) {
            currentRotation = packet.rotation
          }
          decoder.decode(packet.payload) { frame ->
            // A reader superseded by a reconnect must not publish frames or Streaming onto the new
            // session's state; drop this frame once we are no longer the current session.
            if (sessionId != activeSessionId) return@decode
            val current = _state.value
            if (
              current !is VideoStreamState.Streaming ||
                current.width != frame.width ||
                current.height != frame.height
            ) {
              // The real size comes from the SPS, not the advertised header, and changes on
              // device rotation.
              _state.value = VideoStreamState.Streaming(frame.width, frame.height)
            }
            val contentHash = frame.bgra.contentHashCode()
            val contentChanged =
              previousContentHash != null &&
                (previousContentHash != contentHash ||
                  previousWidth != frame.width ||
                  previousHeight != frame.height)
            previousContentHash = contentHash
            previousWidth = frame.width
            previousHeight = frame.height
            // Present here, on the reader thread, while the decoder's reused buffer is valid:
            // the immutable raster produced by toImageBitmap is the only per-frame copy, and
            // consumers receive a ready-to-draw frame with no conversion (or allocation) of
            // their own.
            _frames.tryEmit(
              LiveVideoFrame(
                bitmap = frame.toImageBitmap(),
                sequence = frameSequence.incrementAndGet(),
                receivedAtMs = nowMs(),
                contentChanged = contentChanged,
                // The stream's config packets attest the display rotation; carrying it here
                // lets DeviceControlSession re-prove orientation from the live frame alone
                // (issue #4786).
                rotation = currentRotation,
              )
            )
          }
        },
      )
    }
  }

  private fun closeChannel() {
    try {
      channel?.close()
    } catch (e: Exception) {
      LOG.debug("Closing the video stream socket failed: ${e.message}")
    }
    channel = null
  }
}

@Serializable
internal data class VideoStreamRequest(
  val id: String,
  val action: String = "subscribe",
  /**
   * Daemon session UUID authenticating this subscribe against the stream-socket session guard
   * (issue #4751). Omitted when null (see [explicitNulls] = false above), matching the escape-hatch
   * path; a non-null value must resolve to a live daemon session. See issue #4924.
   */
  val sessionUuid: String? = null,
  val deviceId: String? = null,
  /** Resolution/bitrate preset hint (`low`/`medium`/`high`); see [VideoStreamQuality]. */
  val quality: String? = null,
  /** Capture frame-rate hint; the relay pins its own default when omitted. */
  val fps: Int? = null,
  /** Encoder bitrate hint in kbps; the preset's default applies when omitted. */
  val bitrateKbps: Int? = null,
)

@Serializable
internal data class VideoStreamResponse(
  val id: String? = null,
  val type: String? = null,
  val success: Boolean = false,
  val deviceId: String? = null,
  val framing: String? = null,
  val permission: VideoStreamPermissionResponse? = null,
  val error: String? = null,
)

@Serializable
internal data class VideoStreamPermissionResponse(
  val kind: String,
  val status: String,
  val approvalTarget: String? = null,
)

private fun VideoStreamPermissionResponse?.toPermissionState():
  VideoStreamState.PermissionRequired? =
  when {
    this?.kind == "screen_recording" && this.status == "needs_approval" ->
      VideoStreamState.PermissionRequired(
        permission = VideoStreamPermission.ScreenRecordingNeedsApproval,
        approvalTarget = this.approvalTarget?.takeIf(String::isNotBlank) ?: "AutoMobile",
      )
    else -> null
  }

/** In-memory [VideoStreamSource] for previews and tests. */
class FakeVideoStreamSource(
  private val available: Boolean = true,
  private val refuseWith: String? = null,
  private var screenRecordingRequired: Boolean = false,
  private val screenRecordingApprovalTarget: String = "AutoMobile",
  private val nowMs: () -> Long = { 0L },
  /**
   * When true, [connect] stays in [VideoStreamState.Connecting] (never reaches Streaming) — for
   * exercising the first-frame-deadline watchdog.
   */
  private val holdConnecting: Boolean = false,
) : VideoStreamSource {
  private val fakeSequence = java.util.concurrent.atomic.AtomicLong(0L)

  private val _frames =
    MutableSharedFlow<LiveVideoFrame>(
      replay = 1,
      extraBufferCapacity = 2,
      onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
  override val frames: SharedFlow<LiveVideoFrame> = _frames.asSharedFlow()

  private val _state = MutableStateFlow<VideoStreamState>(VideoStreamState.Idle)
  override val state: StateFlow<VideoStreamState> = _state.asStateFlow()

  var connectedDeviceId: String? = null
    private set

  var connectCalls: Int = 0
    private set

  override fun isAvailable(): Boolean = available

  override fun connect(deviceId: String?) {
    connectCalls++
    connectedDeviceId = deviceId
    _state.value =
      when {
        !available -> VideoStreamState.Unavailable("Live mirroring is unavailable on this daemon")
        screenRecordingRequired ->
          VideoStreamState.PermissionRequired(
            VideoStreamPermission.ScreenRecordingNeedsApproval,
            screenRecordingApprovalTarget,
          )
        refuseWith != null -> VideoStreamState.Unavailable(refuseWith)
        holdConnecting -> VideoStreamState.Connecting
        else -> VideoStreamState.Streaming(1080, 2400)
      }
  }

  override fun disconnect() {
    connectedDeviceId = null
    _state.value = VideoStreamState.Idle
  }

  override fun dispose() {
    disconnect()
  }

  /** Simulates an unavailable relay after a stream has started. */
  fun becomeUnavailable(reason: String = "Live mirroring is unavailable on this daemon") {
    _state.value = VideoStreamState.Unavailable(reason)
  }

  /**
   * Forces the Streaming state directly, independent of [connect] (which a `refuseWith` fake keeps
   * routing to Unavailable) — used to stage a retained-frame-then-drop scenario.
   */
  fun becomeStreaming(width: Int = 1080, height: Int = 2400) {
    _state.value = VideoStreamState.Streaming(width, height)
  }

  /** Simulates granting the macOS permission after the Settings flow. */
  fun grantScreenRecording() {
    screenRecordingRequired = false
  }

  /** Publishes a ready-to-draw frame to collectors, as the real client would. */
  fun emitFrame(
    width: Int = 1080,
    height: Int = 2400,
    rotation: Int? = null,
    contentChanged: Boolean = false,
  ) {
    _frames.tryEmit(
      LiveVideoFrame(
        bitmap = ImageBitmap(width, height),
        sequence = fakeSequence.incrementAndGet(),
        receivedAtMs = nowMs(),
        contentChanged = contentChanged,
        rotation = rotation,
      )
    )
  }
}

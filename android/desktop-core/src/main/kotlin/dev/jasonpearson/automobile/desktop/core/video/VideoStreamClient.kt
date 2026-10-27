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
import kotlinx.coroutines.CoroutineDispatcher
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

  enum class UnavailableCause {
    NO_RELAY,
    REFUSED,
    OTHER,
  }

  data class Streaming(val width: Int, val height: Int) : VideoStreamState()

  data class Ended(val reason: VideoStreamEndReason) : VideoStreamState()

  /** A named host permission blocked the current subscribe attempt. */
  data class PermissionRequired(
    val permission: VideoStreamPermission,
    val approvalTarget: String,
  ) : VideoStreamState()

  /** Terminal for this attempt; [reason] is safe to show a user. */
  data class Unavailable(
    val reason: String,
    val cause: UnavailableCause = UnavailableCause.OTHER,
  ) : VideoStreamState()
}

internal fun VideoStreamState.autoReconnects(): Boolean =
  when (this) {
    is VideoStreamState.Unavailable,
    is VideoStreamState.PermissionRequired -> true
    is VideoStreamState.Ended ->
      reason == VideoStreamEndReason.DeviceRemoved ||
        reason == VideoStreamEndReason.IdentityQuarantined
    else -> false
  }

enum class VideoStreamSubscriptionKind(val wire: String) {
  Owner("owner"),
  Viewer("viewer");

  companion object {
    fun fromWire(value: String?): VideoStreamSubscriptionKind? = entries.firstOrNull {
      it.wire == value
    }
  }
}

/** Recoverable permission state decoded from the local relay protocol. */
enum class VideoStreamPermission {
  ScreenRecordingNeedsApproval,
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
  /**
   * Latest decoded frame sequence, retained even if StateFlow conflates a short Streaming state.
   */
  val emittedFrameSequence: StateFlow<Long>
  /** Cumulative source-encoder drops, when the relay provides telemetry. */
  val droppedFrames: SharedFlow<Long>
  val state: StateFlow<VideoStreamState>
  val subscriptionKind: StateFlow<VideoStreamSubscriptionKind?>
  /** Latched only by a downgrade, not by a viewer ack; reset on the next connect. */
  val readOnly: StateFlow<Boolean>

  /**
   * Cadence, in milliseconds, at which the relay sends a zero-payload heartbeat while the capture
   * has data (issue #7549), as advertised in the subscribe ack. Null before the ack arrives and for
   * a daemon that predates this field — callers that gate a stall-reconnect policy on "the relay
   * proves idle liveness" must treat null as "no such proof available", not as "definitely dead".
   */
  val heartbeatMs: StateFlow<Long?>

  /**
   * Wall-clock ms of the most recent relay-attested activity while `Streaming` — a heartbeat or
   * dropped-frame telemetry packet — sharing a time base with [LiveVideoFrame.receivedAtMs]
   * (issue #7549). Only meaningful once [heartbeatMs] is non-null; a source that never advertises a
   * heartbeat leaves this at its initial value forever, which is harmless: nothing reads it as
   * progress unless it changes.
   */
  val lastActivityMs: StateFlow<Long>

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

/** Controllable reader for testing session changes without sockets or wall-clock scheduling. */
interface VideoStreamSessionRunner {
  fun isAvailable(): Boolean

  suspend fun run(deviceId: String?, publish: (VideoStreamState) -> Unit)
}

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
class VideoStreamClient(options: Options = Options()) : VideoStreamSource {
  data class Options(
    val socketPathValue: String = AutoMobileSocketPaths.socketPath(VIDEO_STREAM_SOCKET_FILE),
    val json: Json = Json {
      ignoreUnknownKeys = true
      explicitNulls = false
      // `action` is a default on the request class but required on the wire; without this the
      // daemon receives no action and rejects the subscribe.
      encodeDefaults = true
    },
    val decoderFactory: () -> H264Decoder = { H264Decoder() },
    /**
     * Supplies the daemon session UUID that authenticates the `subscribe` request against the
     * stream-socket session guard (issue #4751). Resolved at connect time so a session established
     * after construction is still used. Null (the default) omits the `sessionUuid` field via
     * [explicitNulls] = false, so the daemon rejects the subscribe unless it was started with
     * `AUTOMOBILE_DAEMON_STREAM_AUTH=0`. The desktop host supplies a provider from
     * `DesktopDaemonSession` for Unix-daemon connections.
     */
    val sessionUuidProvider: () -> String? = { null },
    /** Resolution/bitrate preset hint sent on subscribe; null keeps the capture's default. */
    val quality: VideoStreamQuality? = null,
    /** Capture frame-rate hint sent on subscribe; null keeps the relay's pinned default. */
    val fps: Int? = null,
    /** Encoder bitrate hint (kbps) sent on subscribe; null keeps the preset's default. */
    val bitrateKbps: Int? = null,
    /**
     * Monotonic clock stamping [LiveVideoFrame.receivedAtMs]. Must share a time base with the
     * consumer-side freshness checks (`MONOTONIC_NOW_MS`, issue #3348), hence the same
     * `System.nanoTime()` source by default; injectable for deterministic tests.
     */
    val nowMs: () -> Long = { System.nanoTime() / 1_000_000L },
    val sessionRunner: VideoStreamSessionRunner? = null,
    val readerCoroutineDispatcher: CoroutineDispatcher? = null,
  )

  private val socketPathValue = options.socketPathValue
  private val json = options.json
  private val decoderFactory = options.decoderFactory
  private val sessionUuidProvider = options.sessionUuidProvider
  private val quality = options.quality
  private val fps = options.fps
  private val bitrateKbps = options.bitrateKbps
  private val nowMs = options.nowMs
  private val sessionRunner = options.sessionRunner
  private val readerCoroutineDispatcher = options.readerCoroutineDispatcher

  internal fun subscribeRequest(deviceId: String?) =
    VideoStreamRequest(
      id = UUID.randomUUID().toString(),
      sessionUuid = sessionUuidProvider(),
      deviceId = deviceId,
      quality = quality?.wire,
      fps = fps,
      bitrateKbps = bitrateKbps,
    )

  // One dedicated reader thread per client (see the class doc for why not Dispatchers.IO).
  private val ownedReaderDispatcher =
    if (readerCoroutineDispatcher == null)
      java.util.concurrent.Executors.newSingleThreadExecutor { runnable ->
          Thread(runnable, "video-stream-reader").apply { isDaemon = true }
        }
        .asCoroutineDispatcher()
    else null
  private val readerDispatcher = readerCoroutineDispatcher ?: requireNotNull(ownedReaderDispatcher)
  private val scope = CoroutineScope(SupervisorJob() + readerDispatcher)

  private val frameSequence = java.util.concurrent.atomic.AtomicLong(0L)

  private val _frames =
    MutableSharedFlow<LiveVideoFrame>(
      replay = 1,
      extraBufferCapacity = 2,
      onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
  override val frames: SharedFlow<LiveVideoFrame> = _frames.asSharedFlow()
  private val _emittedFrameSequence = MutableStateFlow(0L)
  override val emittedFrameSequence: StateFlow<Long> = _emittedFrameSequence.asStateFlow()
  private val _droppedFrames = MutableSharedFlow<Long>(replay = 1, extraBufferCapacity = 1)
  override val droppedFrames: SharedFlow<Long> = _droppedFrames.asSharedFlow()

  private val _state = MutableStateFlow<VideoStreamState>(VideoStreamState.Idle)
  override val state: StateFlow<VideoStreamState> = _state.asStateFlow()

  private val _subscriptionKind = MutableStateFlow<VideoStreamSubscriptionKind?>(null)
  override val subscriptionKind: StateFlow<VideoStreamSubscriptionKind?> =
    _subscriptionKind.asStateFlow()
  private val _readOnly = MutableStateFlow(false)
  override val readOnly: StateFlow<Boolean> = _readOnly.asStateFlow()

  private val _heartbeatMs = MutableStateFlow<Long?>(null)
  override val heartbeatMs: StateFlow<Long?> = _heartbeatMs.asStateFlow()
  private val _lastActivityMs = MutableStateFlow(0L)
  override val lastActivityMs: StateFlow<Long> = _lastActivityMs.asStateFlow()

  private var channel: SocketChannel? = null
  private var readerJob: Job? = null
  private val sessionLock = Any()

  // Session identity so a superseded reader's teardown can't clobber a newer session's state. A
  // rapid disconnect()+connect() (the stall / first-frame watchdog) installs the replacement reader
  // before the cancelled one unwinds; a stale reader that checked the mutable readerJob would see
  // the fresh job as active and publish its own Unavailable over the new session's Connecting,
  // wedging the stream. Keyed on this id every state write is dropped unless the reader is current.
  private val sessionIds = java.util.concurrent.atomic.AtomicLong(0L)
  @Volatile private var activeSessionId = 0L

  override fun isAvailable(): Boolean =
    sessionRunner?.isAvailable() ?: Files.exists(File(socketPathValue).toPath())

  override fun connect(deviceId: String?) {
    synchronized(sessionLock) {
      if (readerJob?.isActive == true) return
      if (!isAvailable()) {
        _state.value =
          VideoStreamState.Unavailable(
            "Live mirroring is unavailable on this daemon",
            VideoStreamState.UnavailableCause.NO_RELAY,
          )
        return
      }

      val sessionId = sessionIds.incrementAndGet()
      activeSessionId = sessionId
      _subscriptionKind.value = null
      _readOnly.value = false
      _state.value = VideoStreamState.Connecting
      readerJob = scope.launch {
        // Name the dedicated thread per target so a farm's dozens of readers are tellable
        // apart in a thread dump.
        if (sessionRunner == null) {
          Thread.currentThread().name = "video-stream-reader-${deviceId ?: "default"}"
          Session(deviceId, sessionId).run()
        } else {
          sessionRunner.run(deviceId) { state -> publish(sessionId, state) }
        }
      }
    }
  }

  override fun disconnect() {
    // Invalidate the current session first so the cancelled reader's terminal state write is
    // dropped rather than racing an Unavailable over a subsequent Idle/Connecting.
    synchronized(sessionLock) {
      activeSessionId = sessionIds.incrementAndGet()
      readerJob?.cancel()
      readerJob = null
      closeChannel()
      _state.value = VideoStreamState.Idle
    }
  }

  /** Disconnects and cancels the internal scope. The instance must not be reused afterwards. */
  override fun dispose() {
    disconnect()
    scope.coroutineContext[Job]?.cancel()
    ownedReaderDispatcher?.close()
  }

  private fun publish(sessionId: Long, state: VideoStreamState) {
    synchronized(sessionLock) {
      if (sessionId == activeSessionId) _state.value = state
    }
  }

  private inner class Session(private val deviceId: String?, private val sessionId: Long) {
    private fun isCurrent() = sessionId == activeSessionId

    fun run() {
      // A superseded reader must never overwrite its replacement's state.
      if (isCurrent()) {
        _heartbeatMs.value = null
        _lastActivityMs.value = 0L
      }
      val decoder = createDecoder() ?: return
      if (!isCurrent()) {
        decoder.close()
        return
      }
      try {
        SocketChannel.open(UnixDomainSocketAddress.of(socketPathValue)).use { socket ->
          runConnected(socket, decoder)
        }
      } catch (error: java.io.IOException) {
        publishFailure(error)
      } catch (error: H264DecodeException) {
        publishFailure(error)
      } catch (error: VideoStreamFormatException) {
        publishFailure(error)
      } catch (error: IllegalArgumentException) {
        publishFailure(error)
      } catch (error: IllegalStateException) {
        if (error is kotlinx.coroutines.CancellationException) throw error
        publishFailure(error)
      } finally {
        decoder.close()
        if (isCurrent()) channel = null
      }
    }

    private fun createDecoder(): H264Decoder? =
      try {
        decoderFactory()
      } catch (error: H264DecodeException) {
        LOG.warn("Could not create the H.264 decoder: ${error.message}", error)
        publish(
          sessionId,
          VideoStreamState.Unavailable(error.message ?: "No H.264 decoder available"),
        )
        null
      }

    private fun runConnected(socket: SocketChannel, decoder: H264Decoder) {
      synchronized(sessionLock) {
        if (!isCurrent()) return
        channel = socket
      }
      val input = Channels.newInputStream(socket)
      val ack = subscribe(socket, input) ?: return
      if (!ack.success) {
        publish(
          sessionId,
          ack.permission.toPermissionState()
            ?: VideoStreamState.Unavailable(
              ack.error ?: "Live mirroring was refused",
              subscribeFailureCause(ack.error),
            ),
        )
        return
      }
      synchronized(sessionLock) {
        if (isCurrent()) {
          _heartbeatMs.value = ack.heartbeatMs
          // Only an explicit downgrade revokes desktop control.
          _subscriptionKind.value = VideoStreamSubscriptionKind.fromWire(ack.subscriptionKind)
        }
      }
      val endReason = FramePump(decoder, sessionId).pump(input)
      publish(
        sessionId,
        endReason?.let { VideoStreamState.Ended(it) }
          ?: VideoStreamState.Unavailable("Live mirroring stopped"),
      )
    }

    private fun subscribe(socket: SocketChannel, input: java.io.InputStream): VideoStreamResponse? {
      val writer =
        BufferedWriter(OutputStreamWriter(Channels.newOutputStream(socket), StandardCharsets.UTF_8))
      synchronized(sessionLock) {
        if (!isCurrent()) return null
        writer.write(
          json.encodeToString(serializer<VideoStreamRequest>(), subscribeRequest(deviceId)),
        )
        writer.newLine()
        writer.flush()
      }
      return json.decodeFromString(serializer<VideoStreamResponse>(), readAckLine(input))
    }

    private fun publishFailure(error: Exception) {
      if (isCurrent()) {
        LOG.warn("Live mirroring stopped: ${error.message}", error)
        publish(sessionId, VideoStreamState.Unavailable(error.message ?: "Live mirroring stopped"))
      } else {
        LOG.debug("Superseded video stream reader stopped: ${error.message}")
      }
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

  private inner class FramePump(private val decoder: H264Decoder, private val sessionId: Long) {
    // The most recent config attests rotation for subsequently decoded frames.
    private var currentRotation: Int? = null
    private var endReason: VideoStreamEndReason? = null

    fun pump(input: java.io.InputStream): VideoStreamEndReason? {
      val parser = VideoStreamParser()
      val buffer = ByteArray(64 * 1024)
      while (true) {
        val read = input.read(buffer)
        if (read <= 0) return null
        parser.onBytes(
          buffer,
          read,
          onHeader = { header ->
            LOG.info("Live mirroring started (${header.width}x${header.height} advertised)")
          },
          onNotice = ::onNotice,
          onPacket = ::onPacket,
        )
        if (parser.hasEnded) return readTerminalReason(input, parser.trailingBytes) ?: endReason
      }
    }

    private fun onNotice(notice: VideoStreamNotice) {
      when (notice) {
        VideoStreamNotice.Downgraded ->
          synchronized(sessionLock) {
            if (sessionId == activeSessionId) {
              _subscriptionKind.value = VideoStreamSubscriptionKind.Viewer
              _readOnly.value = true
            }
          }
        is VideoStreamNotice.Ended -> endReason = notice.reason
        is VideoStreamNotice.Unknown ->
          LOG.warn("Ignoring unknown video subscription notice ${notice.code}")
      }
    }

    private fun onPacket(packet: VideoPacket) {
      if (packet.heartbeat) {
        recordActivity()
        return
      }
      packet.droppedFrames?.let {
        recordActivity()
        _droppedFrames.tryEmit(it)
        return
      }
      if (packet.isConfig && packet.rotation != null) currentRotation = packet.rotation
      decoder.decode(packet.payload, ::emitFrame)
    }

    private fun recordActivity() {
      if (sessionId == activeSessionId) _lastActivityMs.value = nowMs()
    }

    private fun emitFrame(frame: DecodedFrame) {
      if (sessionId != activeSessionId) return
      val current = _state.value
      val dimensionsChanged =
        current !is VideoStreamState.Streaming ||
          current.width != frame.width ||
          current.height != frame.height
      if (dimensionsChanged)
        publish(sessionId, VideoStreamState.Streaming(frame.width, frame.height))
      val sequence = frameSequence.incrementAndGet()
      // Convert while the decoder's reused buffer is still valid, on the reader thread.
      _frames.tryEmit(
        LiveVideoFrame(
          bitmap = frame.toImageBitmap(),
          sequence = sequence,
          receivedAtMs = nowMs(),
          rotation = currentRotation,
        ),
      )
      _emittedFrameSequence.value = sequence
    }
  }

  /** The notice already ended the stream; an optional terminal line can refine its reason. */
  private fun readTerminalReason(
    input: java.io.InputStream,
    trailingBytes: ByteArray,
  ): VideoStreamEndReason? {
    val line = java.io.ByteArrayOutputStream()
    val limit = 16 * 1024
    try {
      var offset = 0
      while (line.size() < limit) {
        val byte =
          if (offset < trailingBytes.size) trailingBytes[offset++].toInt() and 0xff
          else input.read()
        if (byte < 0 || byte == '\n'.code) break
        line.write(byte)
      }
      if (line.size() == limit) {
        LOG.debug("Video terminal line exceeded 16 KiB; using the end notice")
        return null
      }
      val text = line.toString(StandardCharsets.UTF_8)
      if (text.isBlank()) return null
      val terminal = json.decodeFromString(serializer<VideoStreamResponse>(), text)
      return VideoStreamEndReason.fromWire(terminal.reason)
    } catch (e: java.io.IOException) {
      // The typed end notice is sufficient even when an old/closing relay omits a valid line.
      LOG.debug("Video terminal line unavailable; using the end notice: ${e.message}")
      return null
    } catch (e: IllegalArgumentException) {
      LOG.debug("Video terminal line invalid; using the end notice: ${e.message}")
      return null
    }
  }

  private fun closeChannel() {
    try {
      channel?.close()
    } catch (e: java.io.IOException) {
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
  val subscriptionKind: String? = null,
  val reason: String? = null,
  val terminal: Boolean = false,
  val permission: VideoStreamPermissionResponse? = null,
  /**
   * Interval, in ms, at which the relay writes a zero-payload heartbeat while the capture has data
   * (issue #7549). Absent on a daemon that predates this field.
   */
  val heartbeatMs: Long? = null,
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

/** The relay currently sends textual errors rather than a structured auth failure code. */
internal fun isStreamAuthFailure(reason: String): Boolean {
  val text = reason.lowercase()
  return text.contains("authenticated daemon session") ||
    text.contains("cannot be authenticated") ||
    text.contains("not an active daemon session") ||
    text.contains("different daemon session") ||
    text.contains("without authorization") ||
    text.contains("unauthorized")
}

internal fun subscribeFailureCause(error: String?): VideoStreamState.UnavailableCause =
  if (error != null && isStreamAuthFailure(error)) VideoStreamState.UnavailableCause.REFUSED
  else VideoStreamState.UnavailableCause.OTHER

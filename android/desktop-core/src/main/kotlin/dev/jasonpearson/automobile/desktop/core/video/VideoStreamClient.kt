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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
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

  /** Terminal for this attempt; [reason] is safe to show a user. */
  data class Unavailable(val reason: String) : VideoStreamState()
}

/** A live view of a device's screen. */
interface VideoStreamSource {
  val frames: SharedFlow<DecodedFrame>
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
 * [VideoStreamParser]. Decoding happens on the reader thread, which is deliberate: it applies
 * backpressure to the socket rather than letting undecoded packets pile up in memory.
 *
 * [frames] drops the oldest frame when a collector falls behind. For live video a stale frame is
 * worthless, and an unbounded buffer would trade latency for memory and lose on both.
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
   * `AUTOMOBILE_DAEMON_STREAM_AUTH=0`. The desktop cannot yet populate it -- see issue #4924.
   */
  private val sessionUuidProvider: () -> String? = { null },
) : VideoStreamSource {

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

  private val _frames =
    MutableSharedFlow<DecodedFrame>(
      replay = 1,
      extraBufferCapacity = 2,
      onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
  override val frames: SharedFlow<DecodedFrame> = _frames.asSharedFlow()

  private val _state = MutableStateFlow<VideoStreamState>(VideoStreamState.Idle)
  override val state: StateFlow<VideoStreamState> = _state.asStateFlow()

  private var channel: SocketChannel? = null
  private var readerJob: Job? = null

  override fun isAvailable(): Boolean = Files.exists(File(socketPathValue).toPath())

  override fun connect(deviceId: String?) {
    if (readerJob?.isActive == true) return
    if (!isAvailable()) {
      _state.value = VideoStreamState.Unavailable("Live mirroring is unavailable on this daemon")
      return
    }

    _state.value = VideoStreamState.Connecting
    readerJob = scope.launch { runSession(deviceId) }
  }

  override fun disconnect() {
    readerJob?.cancel()
    readerJob = null
    closeChannel()
    _state.value = VideoStreamState.Idle
  }

  /** Disconnects and cancels the internal scope. The instance must not be reused afterwards. */
  override fun dispose() {
    disconnect()
    scope.coroutineContext[Job]?.cancel()
  }

  private fun runSession(deviceId: String?) {
    val decoder =
      try {
        decoderFactory()
      } catch (e: Exception) {
        LOG.warn("Could not create the H.264 decoder: ${e.message}", e)
        _state.value = VideoStreamState.Unavailable(e.message ?: "No H.264 decoder available")
        return
      }

    try {
      SocketChannel.open(UnixDomainSocketAddress.of(socketPathValue)).use { socket ->
        channel = socket
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
            ),
          )
        )
        writer.newLine()
        writer.flush()

        val ackLine = readAckLine(input)
        val ack = json.decodeFromString(serializer<VideoStreamResponse>(), ackLine)
        if (!ack.success) {
          _state.value = VideoStreamState.Unavailable(ack.error ?: "Live mirroring was refused")
          return
        }

        pumpFrames(input, decoder)
        if (readerJob?.isActive == true) {
          _state.value = VideoStreamState.Unavailable("Live mirroring stopped")
        }
      }
    } catch (e: Exception) {
      // Cancellation arrives as an exception on the blocking read; that is a normal disconnect.
      if (readerJob?.isActive == true) {
        LOG.warn("Live mirroring stopped: ${e.message}", e)
        _state.value = VideoStreamState.Unavailable(e.message ?: "Live mirroring stopped")
      }
    } finally {
      decoder.close()
      channel = null
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

  private fun pumpFrames(input: java.io.InputStream, decoder: H264Decoder) {
    val parser = VideoStreamParser()
    val buffer = ByteArray(64 * 1024)
    // Latest attested rotation, updated by each config packet that carries it (issue #4786). A
    // config packet precedes the IDR it configures, so a decoded frame is stamped with the rotation
    // the current SPS/PPS attested. Stays null until the first attested config packet, so an
    // unattested stream (screenrecord/iOS relay) leaves the control gate to fail closed.
    var currentRotation: Int? = null

    while (true) {
      val read = input.read(buffer)
      if (read <= 0) return

      parser.onBytes(
        buffer.copyOf(read),
        onHeader = { header ->
          LOG.info("Live mirroring started (${header.width}x${header.height} advertised)")
        },
        onPacket = { packet ->
          if (packet.isConfig && packet.rotation != null) {
            currentRotation = packet.rotation
          }
          decoder.decode(packet.payload) { frame ->
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
            // The decoder reuses its buffer, so the frame must be copied before it leaves here.
            _frames.tryEmit(
              DecodedFrame(frame.width, frame.height, frame.bgra.copyOf(), currentRotation)
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
)

@Serializable
internal data class VideoStreamResponse(
  val id: String? = null,
  val type: String? = null,
  val success: Boolean = false,
  val deviceId: String? = null,
  val framing: String? = null,
  val error: String? = null,
)

/** In-memory [VideoStreamSource] for previews and tests. */
class FakeVideoStreamSource(
  private val available: Boolean = true,
  private val refuseWith: String? = null,
) : VideoStreamSource {
  private val _frames =
    MutableSharedFlow<DecodedFrame>(
      replay = 1,
      extraBufferCapacity = 2,
      onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
  override val frames: SharedFlow<DecodedFrame> = _frames.asSharedFlow()

  private val _state = MutableStateFlow<VideoStreamState>(VideoStreamState.Idle)
  override val state: StateFlow<VideoStreamState> = _state.asStateFlow()

  var connectedDeviceId: String? = null
    private set

  override fun isAvailable(): Boolean = available

  override fun connect(deviceId: String?) {
    connectedDeviceId = deviceId
    _state.value =
      when {
        !available -> VideoStreamState.Unavailable("Live mirroring is unavailable on this daemon")
        refuseWith != null -> VideoStreamState.Unavailable(refuseWith)
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

  /** Publishes a frame to collectors, as the real client would. */
  fun emitFrame(width: Int = 1080, height: Int = 2400, rotation: Int? = null) {
    _frames.tryEmit(DecodedFrame(width, height, ByteArray(width * height * 4), rotation))
  }
}

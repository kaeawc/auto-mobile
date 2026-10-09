package dev.jasonpearson.automobile.desktop.core.video

import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.StandardProtocolFamily
import java.net.UnixDomainSocketAddress
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.channels.Channels
import java.nio.channels.ServerSocketChannel
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Drives [VideoStreamClient] against a real Unix socket serving a real H.264 stream, so the
 * handshake, the binary framing, and the decoder are all exercised together.
 *
 * The socket/decoder integration tests use `runBlocking`: their work happens on a real IO thread.
 * The reconnect state test uses an injected reader and virtual-time dispatcher instead.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class VideoStreamClientTest {

  private val log = LoggerFactory.getLogger("VideoStreamClientTest")
  private val json = Json { ignoreUnknownKeys = true }
  private val servers = mutableListOf<FakeRelay>()

  @AfterTest
  fun tearDown() {
    servers.forEach { it.close() }
    servers.clear()
  }

  private fun sampleH264(): ByteArray =
    checkNotNull(javaClass.classLoader.getResourceAsStream("sample.h264")).use { it.readBytes() }

  private fun relay(
    success: Boolean = true,
    error: String? = null,
    permissionJson: String? = null,
    payload: ByteArray? = null,
    keepOpen: Boolean = false,
    rotation: Int? = null,
    maxConnections: Int = 1,
    heartbeatMs: Long? = null,
    sendHeartbeatAfterPayload: Boolean = false,
    subscriptionKind: String? = null,
    extraBytes: ByteArray = byteArrayOf(),
    extraBytesOnReconnect: ByteArray = extraBytes,
  ): FakeRelay =
    FakeRelay(
        success,
        error,
        permissionJson,
        payload,
        keepOpen,
        rotation,
        maxConnections,
        heartbeatMs,
        sendHeartbeatAfterPayload,
        subscriptionKind,
        extraBytes,
        extraBytesOnReconnect,
      )
      .also { servers.add(it) }

  // int64 BE (bit 61 | code), int32 BE zero length: a 12-byte notice header.
  private fun notice(code: Long): ByteArray =
    ByteBuffer.allocate(12)
      .order(ByteOrder.BIG_ENDIAN)
      .putLong((1L shl 61) or code)
      .putInt(0)
      .array()

  private fun terminal(reason: String): ByteArray =
    ("""{"type":"video_stream_response","success":false,"action":"unsubscribe","terminal":true,"reason":"$reason","subscriptionKind":"owner","error":"ended"}""" +
        "\n")
      .toByteArray()

  private suspend fun assertAckKind(wire: String?, expected: VideoStreamSubscriptionKind?) {
    val server = relay(payload = sampleH264(), keepOpen = true, subscriptionKind = wire)
    val client = VideoStreamClient(socketPathValue = server.socketPath.toString())
    try {
      client.connect("emulator-5554")
      server.awaitFirstFrameFrom(client)
      assertEquals(expected, client.subscriptionKind.value)
      assertTrue(!client.readOnly.value, "Viewer admission alone must preserve input")
    } finally {
      client.dispose()
    }
  }

  @Test
  fun `owner ack exposes owner kind`() = runBlocking {
    assertAckKind("owner", VideoStreamSubscriptionKind.Owner)
  }

  @Test
  fun `viewer ack exposes kind without revoking input`() = runBlocking {
    assertAckKind("viewer", VideoStreamSubscriptionKind.Viewer)
  }

  @Test fun `old daemon ack exposes no kind`() = runBlocking { assertAckKind(null, null) }

  @Test fun `unknown ack kind is tolerated`() = runBlocking { assertAckKind("future", null) }

  @Test
  fun `downgrade keeps streaming and latches read only until reconnect`() = runBlocking {
    val server =
      relay(
        payload = sampleH264(),
        keepOpen = true,
        subscriptionKind = "owner",
        maxConnections = 2,
        extraBytes = notice(1),
        extraBytesOnReconnect = byteArrayOf(),
      )
    val client = VideoStreamClient(socketPathValue = server.socketPath.toString())
    try {
      client.connect("emulator-5554")
      waitUntil { client.readOnly.value }
      assertEquals(VideoStreamSubscriptionKind.Viewer, client.subscriptionKind.value)
      assertEquals(VideoStreamState.Streaming(320, 240), client.state.value)
      client.disconnect()
      client.connect("emulator-5554")
      assertTrue(!client.readOnly.value)
      waitUntil { client.subscriptionKind.value == VideoStreamSubscriptionKind.Owner }
      assertTrue(!client.readOnly.value)
    } finally {
      client.dispose()
    }
  }

  @Test
  fun `unknown notice is ignored while stream remains usable`() = runBlocking {
    val server = relay(payload = sampleH264(), keepOpen = true, extraBytes = notice(99) + notice(1))
    val client = VideoStreamClient(socketPathValue = server.socketPath.toString())
    try {
      client.connect("emulator-5554")
      // The following downgrade proves the reader made it past the unknown notice.
      waitUntil { client.readOnly.value }
      assertEquals(VideoStreamState.Streaming(320, 240), client.state.value)
    } finally {
      client.dispose()
    }
  }

  private suspend fun assertEnd(
    code: Long,
    expected: VideoStreamEndReason,
    line: ByteArray = terminal(expected.wire),
  ) {
    val server = relay(payload = sampleH264(), extraBytes = notice(code) + line)
    val client = VideoStreamClient(socketPathValue = server.socketPath.toString())
    try {
      client.connect("emulator-5554")
      waitUntil { client.state.value is VideoStreamState.Ended }
      assertEquals(VideoStreamState.Ended(expected), client.state.value)
      assertTrue(client.frames.replayCache.isNotEmpty())
    } finally {
      client.dispose()
    }
  }

  @Test
  fun `device removal publishes typed end`() = runBlocking {
    assertEnd(2, VideoStreamEndReason.DeviceRemoved)
  }

  @Test
  fun `identity quarantine publishes typed end`() = runBlocking {
    assertEnd(3, VideoStreamEndReason.IdentityQuarantined)
  }

  @Test
  fun `daemon shutdown publishes typed end`() = runBlocking {
    assertEnd(4, VideoStreamEndReason.DaemonShutdown)
  }

  @Test
  fun `session ending publishes typed end`() = runBlocking {
    assertEnd(5, VideoStreamEndReason.SessionEnded)
  }

  @Test
  fun `end notice alone at EOF is sufficient`() = runBlocking {
    assertEnd(5, VideoStreamEndReason.SessionEnded, byteArrayOf())
  }

  @Test
  fun `known terminal reason overrides end notice`() = runBlocking {
    assertEnd(2, VideoStreamEndReason.SessionEnded)
  }

  @Test
  fun `terminal line without newline at EOF still refines the reason`() = runBlocking {
    assertEnd(
      2,
      VideoStreamEndReason.SessionEnded,
      terminal("session_ended").dropLast(1).toByteArray(),
    )
  }

  @Test
  fun `terminal line without reason retains the notice reason`() = runBlocking {
    assertEnd(2, VideoStreamEndReason.DeviceRemoved, "{\"terminal\":true}\n".toByteArray())
  }

  @Test
  fun `unknown terminal reason retains notice reason`() = runBlocking {
    assertEnd(2, VideoStreamEndReason.DeviceRemoved, terminal("future"))
  }

  @Test
  fun `garbage terminal line retains notice reason`() = runBlocking {
    assertEnd(2, VideoStreamEndReason.DeviceRemoved, "garbage\n".toByteArray())
  }

  @Test
  fun `blank terminal line retains notice reason`() = runBlocking {
    assertEnd(2, VideoStreamEndReason.DeviceRemoved, "\n".toByteArray())
  }

  @Test
  fun `oversized terminal line retains notice reason`() = runBlocking {
    assertEnd(2, VideoStreamEndReason.DeviceRemoved, ByteArray(16 * 1024) { 'x'.code.toByte() })
  }

  @Test
  fun `old daemon EOF still reports live mirroring stopped`() = runBlocking {
    val server = relay(payload = sampleH264())
    val client = VideoStreamClient(socketPathValue = server.socketPath.toString())
    try {
      client.connect("emulator-5554")
      waitUntil { client.state.value is VideoStreamState.Unavailable }
      assertEquals(VideoStreamState.Unavailable("Live mirroring stopped"), client.state.value)
    } finally {
      client.dispose()
    }
  }

  @Test
  fun `subscribes with the device id and decodes frames`() = runBlocking {
    val server = relay(payload = sampleH264())
    val client = VideoStreamClient(socketPathValue = server.socketPath.toString())

    client.connect("emulator-5554")

    val frame = server.awaitFirstFrameFrom(client)
    assertEquals(320, frame.bitmap.width)
    assertEquals(240, frame.bitmap.height)
    // The replay cache holds the NEWEST frame; the sample stream decodes several.
    assertTrue(frame.sequence >= 1L, "expected a stamped sequence, was ${frame.sequence}")

    val request = server.awaitRequest()
    assertEquals("subscribe", request["action"]?.jsonPrimitive?.content)
    assertEquals("emulator-5554", request["deviceId"]?.jsonPrimitive?.content)

    client.dispose()
  }

  @Test
  fun `subscribes with quality, fps and bitrate hints when configured`() = runBlocking {
    val server = relay(payload = sampleH264())
    val client =
      VideoStreamClient(
        socketPathValue = server.socketPath.toString(),
        quality = VideoStreamQuality.Low,
        fps = 15,
        bitrateKbps = 1_500,
      )

    client.connect("emulator-5554")
    server.awaitFirstFrameFrom(client)

    val request = server.awaitRequest()
    assertEquals("low", request["quality"]?.jsonPrimitive?.content)
    assertEquals("15", request["fps"]?.jsonPrimitive?.content)
    assertEquals("1500", request["bitrateKbps"]?.jsonPrimitive?.content)

    client.dispose()
  }

  @Test
  fun `omits the quality hints by default`() = runBlocking {
    val server = relay(payload = sampleH264())
    val client = VideoStreamClient(socketPathValue = server.socketPath.toString())

    client.connect("emulator-5554")
    server.awaitFirstFrameFrom(client)

    val request = server.awaitRequest()
    assertTrue(!request.containsKey("quality"))
    assertTrue(!request.containsKey("fps"))
    assertTrue(!request.containsKey("bitrateKbps"))

    client.dispose()
  }

  @Test
  fun `reports the decoded size, not the advertised header size`() = runBlocking {
    // The daemon advertises 0x0 unless a hint was sent; the truth is in the SPS.
    val server = relay(payload = sampleH264(), keepOpen = true)
    val client = VideoStreamClient(socketPathValue = server.socketPath.toString())

    client.connect(null)
    server.awaitFirstFrameFrom(client)

    val state = client.state.value
    assertTrue(state is VideoStreamState.Streaming, "expected Streaming, was $state")
    assertEquals(320, (state as VideoStreamState.Streaming).width)
    assertEquals(240, state.height)

    client.dispose()
  }

  // --- Relay-originated heartbeat (issue #7549) ---

  @Test
  fun `parses the relay's advertised heartbeat cadence from the ack`() = runBlocking {
    val server = relay(payload = sampleH264(), heartbeatMs = 1_000)
    val client = VideoStreamClient(socketPathValue = server.socketPath.toString())

    client.connect("emulator-5554")
    server.awaitFirstFrameFrom(client)

    assertEquals(1_000L, client.heartbeatMs.value)

    client.dispose()
  }

  @Test
  fun `heartbeatMs stays null for a daemon that predates the field`() = runBlocking {
    val server = relay(payload = sampleH264())
    val client = VideoStreamClient(socketPathValue = server.socketPath.toString())

    client.connect("emulator-5554")
    server.awaitFirstFrameFrom(client)

    assertEquals(null, client.heartbeatMs.value)

    client.dispose()
  }

  @Test
  fun `a relay heartbeat packet bumps lastActivityMs without decoding it as video`() = runBlocking {
    // The whole payload plus the trailing heartbeat can arrive in a single socket read, so the two
    // are processed synchronously back to back. Asserting on lastActivityMs starting at its 0L
    // reset value, rather than racing a before/after snapshot around the first-frame wait, is what
    // makes this deterministic.
    val server =
      relay(payload = sampleH264(), heartbeatMs = 1_000, sendHeartbeatAfterPayload = true)
    val client = VideoStreamClient(socketPathValue = server.socketPath.toString())

    client.connect("emulator-5554")
    val frame = server.awaitFirstFrameFrom(client)
    waitUntil { client.lastActivityMs.value != 0L }

    // The heartbeat must not have been mistaken for a decodable frame: the replay cache still holds
    // the same latest decoded frame.
    assertEquals(frame.sequence, client.frames.replayCache.first().sequence)

    client.dispose()
  }

  @Test
  fun `stamps decoded frames with the rotation attested by a config packet`() = runBlocking {
    // Issue #4786: the config packet attests rotation 3, so the decoded frame carries it
    // end-to-end.
    val server = relay(payload = sampleH264(), rotation = 3)
    val client = VideoStreamClient(socketPathValue = server.socketPath.toString())

    client.connect("emulator-5554")

    val frame = server.awaitFirstFrameFrom(client)
    assertEquals(3, frame.rotation)

    client.dispose()
  }

  @Test
  fun `leaves rotation null when the stream does not attest it`() = runBlocking {
    // An unattested stream (screenrecord/iOS relay) leaves rotation unknown so control fails
    // closed.
    val server = relay(payload = sampleH264())
    val client = VideoStreamClient(socketPathValue = server.socketPath.toString())

    client.connect("emulator-5554")

    assertEquals(null, server.awaitFirstFrameFrom(client).rotation)

    client.dispose()
  }

  @Test
  fun `omits the device id when none is given`() = runBlocking {
    val server = relay(payload = sampleH264())
    val client = VideoStreamClient(socketPathValue = server.socketPath.toString())

    client.connect(null)
    server.awaitFirstFrameFrom(client)

    assertTrue(!server.awaitRequest().containsKey("deviceId"))
    client.dispose()
  }

  @Test
  fun `subscribe carries the session uuid the provider supplies`() = runBlocking {
    // #4751 stream-socket auth: a resolved daemon session UUID authenticates the subscribe.
    val server = relay(payload = sampleH264())
    val client =
      VideoStreamClient(
        socketPathValue = server.socketPath.toString(),
        sessionUuidProvider = { "session-abc" },
      )

    client.connect("emulator-5554")
    server.awaitFirstFrameFrom(client)

    assertEquals("session-abc", server.awaitRequest()["sessionUuid"]?.jsonPrimitive?.content)
    client.dispose()
  }

  @Test
  fun `subscribe omits the session uuid when the provider returns null`() = runBlocking {
    // Default: the desktop holds no daemon session identity yet (issue #4924); the field must be
    // omitted so a pre-#4751 daemon still accepts the subscribe.
    val server = relay(payload = sampleH264())
    val client = VideoStreamClient(socketPathValue = server.socketPath.toString())

    client.connect("emulator-5554")
    server.awaitFirstFrameFrom(client)

    assertTrue(!server.awaitRequest().containsKey("sessionUuid"))
    client.dispose()
  }

  @Test
  fun `a refused subscribe surfaces the daemon's reason`() = runBlocking {
    val server = relay(success = false, error = "No connected device with id ghost.")
    val client = VideoStreamClient(socketPathValue = server.socketPath.toString())

    client.connect("ghost")

    waitUntil { client.state.value is VideoStreamState.Unavailable }
    assertEquals(
      "No connected device with id ghost.",
      (client.state.value as VideoStreamState.Unavailable).reason,
    )
    assertEquals(
      VideoStreamState.UnavailableCause.OTHER,
      (client.state.value as VideoStreamState.Unavailable).cause,
    )
    client.dispose()
  }

  @Test
  fun `a Screen Recording denial becomes structured permission state`() = runBlocking {
    val server =
      relay(
        success = false,
        permissionJson =
          """{"kind":"screen_recording","status":"needs_approval","approvalTarget":"AutoMobile"}""",
      )
    val client = VideoStreamClient(socketPathValue = server.socketPath.toString())

    client.connect("ios-simulator")

    waitUntil { client.state.value is VideoStreamState.PermissionRequired }
    assertEquals(
      VideoStreamPermission.ScreenRecordingNeedsApproval,
      (client.state.value as VideoStreamState.PermissionRequired).permission,
    )
    assertEquals(
      "AutoMobile",
      (client.state.value as VideoStreamState.PermissionRequired).approvalTarget,
    )
    client.dispose()
  }

  @Test
  fun `a missing socket reports unavailable with no relay cause instead of throwing`() =
    runBlocking {
      val client = VideoStreamClient(socketPathValue = "/tmp/no-video-stream-am.sock")

      assertTrue(!client.isAvailable())
      client.connect("emulator-5554")

      assertEquals(
        VideoStreamState.UnavailableCause.NO_RELAY,
        (client.state.value as VideoStreamState.Unavailable).cause,
      )
      client.dispose()
    }

  @Test
  fun `disconnect returns to idle and stops the reader`() = runBlocking {
    val server = relay(payload = sampleH264())
    val client = VideoStreamClient(socketPathValue = server.socketPath.toString())

    client.connect("emulator-5554")
    server.awaitFirstFrameFrom(client)

    client.disconnect()
    assertEquals(VideoStreamState.Idle, client.state.value)
    client.dispose()
  }

  @Test
  fun `a decoder that cannot start is reported, not thrown`() = runBlocking {
    val server = relay(payload = sampleH264())
    val client =
      VideoStreamClient(
        socketPathValue = server.socketPath.toString(),
        decoderFactory = { throw H264DecodeException("no decoder in this build") },
      )

    client.connect("emulator-5554")

    waitUntil { client.state.value is VideoStreamState.Unavailable }
    assertTrue((client.state.value as VideoStreamState.Unavailable).reason.contains("no decoder"))
    client.dispose()
  }

  @Test
  fun `a disconnect during decoder startup does not subscribe`() = runBlocking {
    val server = relay(payload = sampleH264())
    val decoderStarted = CountDownLatch(1)
    val releaseDecoder = CountDownLatch(1)
    val decoderFinished = CountDownLatch(1)
    val client =
      VideoStreamClient(
        socketPathValue = server.socketPath.toString(),
        decoderFactory = {
          decoderStarted.countDown()
          try {
            check(releaseDecoder.await(5, TimeUnit.SECONDS))
            throw H264DecodeException("startup cancelled")
          } finally {
            decoderFinished.countDown()
          }
        },
      )

    client.connect("emulator-5554")
    assertTrue(decoderStarted.await(5, TimeUnit.SECONDS))

    client.disconnect()
    releaseDecoder.countDown()

    assertTrue(decoderFinished.await(5, TimeUnit.SECONDS))
    assertEquals(false, server.receivedRequest())
    client.dispose()
  }

  @Test
  fun `an orderly relay close reports the stream as unavailable`() = runBlocking {
    val server = relay()
    val client = VideoStreamClient(socketPathValue = server.socketPath.toString())

    client.connect("emulator-5554")

    waitUntil { client.state.value is VideoStreamState.Unavailable }
    assertEquals(
      "Live mirroring stopped",
      (client.state.value as VideoStreamState.Unavailable).reason,
    )
    client.dispose()
  }

  @Test
  fun `a rapid reconnect is not wedged by the superseded reader's teardown`() = runTest {
    // Keep each reader's publisher so its terminal event can arrive after a replacement is live.
    // The old socket test checked a replayed frame from the first session on every later attempt,
    // which did not establish that those attempts had even started.
    val reader = FakeSessionRunner()
    val client =
      VideoStreamClient(
        sessionRunner = reader,
        readerCoroutineDispatcher = StandardTestDispatcher(testScheduler),
      )

    try {
      repeat(7) { attempt ->
        client.connect("emulator-5554")
        runCurrent()
        assertEquals(attempt + 1, reader.publishers.size)
        assertEquals(VideoStreamState.Streaming(320, 240), client.state.value)

        // Simulate old readers unwinding after the new reader has reached Streaming.
        reader.publishers.dropLast(1).forEach {
          it(VideoStreamState.Unavailable("superseded reader stopped"))
        }
        assertEquals(VideoStreamState.Streaming(320, 240), client.state.value)
        if (attempt < 6) {
          client.disconnect()
          assertEquals(VideoStreamState.Idle, client.state.value)
        }
      }
    } finally {
      client.dispose()
    }
  }

  private class FakeSessionRunner : VideoStreamSessionRunner {
    val publishers = mutableListOf<(VideoStreamState) -> Unit>()

    override fun isAvailable(): Boolean = true

    override suspend fun run(deviceId: String?, publish: (VideoStreamState) -> Unit) {
      assertEquals("emulator-5554", deviceId)
      publishers += publish
      publish(VideoStreamState.Streaming(320, 240))
      awaitCancellation()
    }
  }

  private suspend fun waitUntil(timeoutMs: Long = 5_000, predicate: () -> Boolean) {
    val deadline = System.currentTimeMillis() + timeoutMs
    while (System.currentTimeMillis() < deadline) {
      if (predicate()) return
      kotlinx.coroutines.delay(10)
    }
    throw AssertionError("Timed out waiting for condition")
  }

  private suspend fun FakeRelay.awaitFirstFrameFrom(client: VideoStreamClient): LiveVideoFrame {
    var frame: LiveVideoFrame? = null
    val deadline = System.currentTimeMillis() + 10_000
    while (System.currentTimeMillis() < deadline && frame == null) {
      frame = client.frames.replayCache.firstOrNull()
      if (frame == null) kotlinx.coroutines.delay(20)
    }
    return frame ?: throw AssertionError("No frame decoded before timeout")
  }

  /** A relay speaking the daemon's handshake then its binary framing over up to N connections. */
  private inner class FakeRelay(
    private val success: Boolean,
    private val error: String?,
    private val permissionJson: String?,
    private val payload: ByteArray?,
    private val keepOpen: Boolean,
    // When set, the framed packet is flagged CONFIG and attests this rotation (issue #4786), as the
    // daemon relay does on a parameter-set packet.
    private val rotation: Int? = null,
    // How many sequential subscribe connections to serve. >1 lets a reconnect (disconnect+connect)
    // be exercised against one relay; each connection is handled on its own daemon thread so a
    // keepOpen session never blocks the accept loop.
    private val maxConnections: Int = 1,
    // Advertised in the ack's `heartbeatMs` field (issue #7549); null omits the field, modeling a
    // daemon that predates it.
    private val heartbeatMs: Long? = null,
    // When true, writes one zero-payload heartbeat packet right after the video payload.
    private val sendHeartbeatAfterPayload: Boolean = false,
    private val subscriptionKind: String? = null,
    private val extraBytes: ByteArray = byteArrayOf(),
    private val extraBytesOnReconnect: ByteArray = extraBytes,
  ) : AutoCloseable {
    private val tempDir: Path = Files.createTempDirectory(Path.of("/tmp"), "amvsc-")
    val socketPath: Path = tempDir.resolve("video-stream.sock")

    private val serverChannel =
      ServerSocketChannel.open(StandardProtocolFamily.UNIX)
        .bind(UnixDomainSocketAddress.of(socketPath))

    @Volatile private var captured: kotlinx.serialization.json.JsonObject? = null
    private val handlers = mutableListOf<Thread>()

    private fun handle(socket: java.nio.channels.SocketChannel, connectionIndex: Int) {
      socket.use {
        val reader =
          BufferedReader(InputStreamReader(Channels.newInputStream(socket), StandardCharsets.UTF_8))
        val out = Channels.newOutputStream(socket)
        captured = json.parseToJsonElement(reader.readLine()).jsonObject

        val ack =
          if (success) {
            buildString {
              append("""{"id":"1","type":"video_stream_response","success":true,"framing":"h264"""")
              if (subscriptionKind != null) append(""", "subscriptionKind":"$subscriptionKind"""")
              if (heartbeatMs != null) append(""","heartbeatMs":$heartbeatMs""")
              append("}")
            }
          } else {
            buildString {
              append("""{"id":"1","type":"video_stream_response","success":false""")
              if (error != null) append(""","error":"$error"""")
              if (permissionJson != null) append(""","permission":$permissionJson""")
              append("}")
            }
          }
        out.write((ack + "\n").toByteArray(StandardCharsets.UTF_8))
        out.flush()

        if (success && payload != null) {
          writeStream(out, payload)
        }
        if (success && sendHeartbeatAfterPayload) {
          writeHeartbeat(out)
        }
        out.write(if (connectionIndex == 0) extraBytes else extraBytesOnReconnect)
        out.flush()
        while (keepOpen && !Thread.currentThread().isInterrupted) {
          Thread.sleep(1000)
        }
      }
    }

    private val thread = Thread {
      try {
        repeat(maxConnections) { connectionIndex ->
          val socket = serverChannel.accept()
          val handler = Thread {
            try {
              handle(socket, connectionIndex)
            } catch (e: Exception) {
              // The client disconnecting mid-stream is the normal end of a handler.
              log.debug("Relay handler stopped after client disconnect: ${e.message}")
            }
          }
            .also {
              it.isDaemon = true
              it.start()
            }
          synchronized(handlers) { handlers.add(handler) }
        }
      } catch (e: Exception) {
        // The server channel closing on teardown ends the accept loop.
        log.debug("Relay accept loop stopped during teardown: ${e.message}")
      }
    }
      .also {
        it.isDaemon = true
        it.start()
      }

    /** Writes the 12-byte stream header, then the payload as a single framed packet. */
    private fun writeStream(out: OutputStream, annexB: ByteArray) {
      out.write(
        ByteBuffer.allocate(12)
          .order(ByteOrder.BIG_ENDIAN)
          .putInt(CODEC_ID_H264)
          .putInt(0)
          .putInt(0)
          .array(),
      )
      var flags = 0L
      rotation?.let {
        // CONFIG (bit 63) + ROTATION_PRESENT (bit 61) + rotation (bits 59-60), matching
        // videoStreamFraming.ts so the client stamps decoded frames with the attested rotation.
        flags = flags or (1L shl 63) or (1L shl 61) or ((it.toLong() and 0b11L) shl 59)
      }
      out.write(
        ByteBuffer.allocate(12)
          .order(ByteOrder.BIG_ENDIAN)
          .putLong(flags)
          .putInt(annexB.size)
          .array(),
      )
      out.write(annexB)
      out.flush()
    }

    /** Writes a zero-payload heartbeat packet (bit 60, non-config), matching the daemon relay. */
    private fun writeHeartbeat(out: OutputStream) {
      out.write(
        ByteBuffer.allocate(12).order(ByteOrder.BIG_ENDIAN).putLong(1L shl 60).putInt(0).array(),
      )
      out.flush()
    }

    suspend fun awaitRequest(): kotlinx.serialization.json.JsonObject {
      val deadline = System.currentTimeMillis() + 5_000
      while (System.currentTimeMillis() < deadline) {
        captured?.let {
          return it
        }
        kotlinx.coroutines.delay(10)
      }
      throw AssertionError("Client did not send a subscribe request")
    }

    fun receivedRequest(): Boolean = captured != null

    override fun close() {
      thread.interrupt()
      synchronized(handlers) { handlers.forEach { it.interrupt() } }
      serverChannel.close()
      Files.deleteIfExists(socketPath)
      Files.deleteIfExists(tempDir)
    }
  }
}

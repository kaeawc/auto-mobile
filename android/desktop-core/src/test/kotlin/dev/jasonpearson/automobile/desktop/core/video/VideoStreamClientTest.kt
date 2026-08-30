package dev.jasonpearson.automobile.desktop.core.video

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
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Drives [VideoStreamClient] against a real Unix socket serving a real H.264 stream, so the
 * handshake, the binary framing, and the decoder are all exercised together.
 *
 * These use `runBlocking` rather than `runTest` deliberately: the work happens on a real IO thread
 * and a real decoder, and `runTest`'s virtual clock would skip the waits without any of it having
 * happened.
 */
class VideoStreamClientTest {

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
  ): FakeRelay =
    FakeRelay(success, error, permissionJson, payload, keepOpen, rotation, maxConnections).also {
      servers.add(it)
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
  fun `a missing socket reports unavailable instead of throwing`() = runBlocking {
    val client = VideoStreamClient(socketPathValue = "/tmp/no-video-stream-am.sock")

    assertTrue(!client.isAvailable())
    client.connect("emulator-5554")

    assertTrue(client.state.value is VideoStreamState.Unavailable)
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
  fun `a rapid reconnect is not wedged by the superseded reader's teardown`() = runBlocking {
    // The stall / first-frame watchdog reconnects with disconnect()+connect() back-to-back. The
    // cancelled reader's channel-close throws on its blocking read AFTER the replacement reader is
    // already installed; keyed only on the mutable readerJob it would publish its terminal
    // Unavailable over the new session's Streaming and wedge the pane. Session identity must drop
    // that stale write. Cycled several times to widen the interleaving window against real IO
    // threads.
    val server = relay(payload = sampleH264(), keepOpen = true, maxConnections = 8)
    val client = VideoStreamClient(socketPathValue = server.socketPath.toString())

    repeat(6) {
      client.connect("emulator-5554")
      server.awaitFirstFrameFrom(client)
      client.disconnect()
    }

    // Final session must settle on live video, never a stale Unavailable from a prior reader.
    client.connect("emulator-5554")
    server.awaitFirstFrameFrom(client)
    waitUntil { client.state.value is VideoStreamState.Streaming }
    assertTrue(
      client.state.value is VideoStreamState.Streaming,
      "expected Streaming, was ${client.state.value}",
    )
    client.dispose()
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
  ) : AutoCloseable {
    private val tempDir: Path = Files.createTempDirectory(Path.of("/tmp"), "amvsc-")
    val socketPath: Path = tempDir.resolve("video-stream.sock")

    private val serverChannel =
      ServerSocketChannel.open(StandardProtocolFamily.UNIX)
        .bind(UnixDomainSocketAddress.of(socketPath))

    @Volatile private var captured: kotlinx.serialization.json.JsonObject? = null
    private val handlers = mutableListOf<Thread>()

    private fun handle(socket: java.nio.channels.SocketChannel) {
      socket.use {
        val reader =
          BufferedReader(InputStreamReader(Channels.newInputStream(socket), StandardCharsets.UTF_8))
        val out = Channels.newOutputStream(socket)
        captured = json.parseToJsonElement(reader.readLine()).jsonObject

        val ack =
          if (success) {
            """{"id":"1","type":"video_stream_response","success":true,"framing":"h264"}"""
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
        while (keepOpen && !Thread.currentThread().isInterrupted) {
          Thread.sleep(1000)
        }
      }
    }

    private val thread = Thread {
      try {
        repeat(maxConnections) {
          val socket = serverChannel.accept()
          val handler = Thread {
            try {
              handle(socket)
            } catch (_: Throwable) {
              // The client disconnecting mid-stream is the normal end of a handler.
            }
          }
            .also {
              it.isDaemon = true
              it.start()
            }
          synchronized(handlers) { handlers.add(handler) }
        }
      } catch (_: Throwable) {
        // The server channel closing on teardown ends the accept loop.
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
          .array()
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
          .array()
      )
      out.write(annexB)
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

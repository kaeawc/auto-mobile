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
    payload: ByteArray? = null,
    keepOpen: Boolean = false,
  ): FakeRelay = FakeRelay(success, error, payload, keepOpen).also { servers.add(it) }

  @Test
  fun `subscribes with the device id and decodes frames`() = runBlocking {
    val server = relay(payload = sampleH264())
    val client = VideoStreamClient(socketPathValue = server.socketPath.toString())

    client.connect("emulator-5554")

    val frame = server.awaitFirstFrameFrom(client)
    assertEquals(320, frame.width)
    assertEquals(240, frame.height)
    assertEquals(320 * 240 * 4, frame.bgra.size)

    val request = server.awaitRequest()
    assertEquals("subscribe", request["action"]?.jsonPrimitive?.content)
    assertEquals("emulator-5554", request["deviceId"]?.jsonPrimitive?.content)

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

  private suspend fun waitUntil(timeoutMs: Long = 5_000, predicate: () -> Boolean) {
    val deadline = System.currentTimeMillis() + timeoutMs
    while (System.currentTimeMillis() < deadline) {
      if (predicate()) return
      kotlinx.coroutines.delay(10)
    }
    throw AssertionError("Timed out waiting for condition")
  }

  private suspend fun FakeRelay.awaitFirstFrameFrom(client: VideoStreamClient): DecodedFrame {
    var frame: DecodedFrame? = null
    val deadline = System.currentTimeMillis() + 10_000
    while (System.currentTimeMillis() < deadline && frame == null) {
      frame = client.frames.replayCache.firstOrNull()
      if (frame == null) kotlinx.coroutines.delay(20)
    }
    return frame ?: throw AssertionError("No frame decoded before timeout")
  }

  /** A one-connection relay speaking the daemon's handshake then its binary framing. */
  private inner class FakeRelay(
    private val success: Boolean,
    private val error: String?,
    private val payload: ByteArray?,
    private val keepOpen: Boolean,
  ) : AutoCloseable {
    private val tempDir: Path = Files.createTempDirectory(Path.of("/tmp"), "amvsc-")
    val socketPath: Path = tempDir.resolve("video-stream.sock")

    private val serverChannel =
      ServerSocketChannel.open(StandardProtocolFamily.UNIX)
        .bind(UnixDomainSocketAddress.of(socketPath))

    @Volatile private var captured: kotlinx.serialization.json.JsonObject? = null

    private val thread = Thread {
      try {
        serverChannel.accept().use { socket ->
          val reader =
            BufferedReader(
              InputStreamReader(Channels.newInputStream(socket), StandardCharsets.UTF_8)
            )
          val out = Channels.newOutputStream(socket)
          captured = json.parseToJsonElement(reader.readLine()).jsonObject

          val ack =
            if (success) {
              """{"id":"1","type":"video_stream_response","success":true,"framing":"h264"}"""
            } else {
              """{"id":"1","type":"video_stream_response","success":false,"error":"$error"}"""
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
      } catch (_: Throwable) {
        // The client disconnecting mid-stream is the normal end of this thread.
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
      out.write(
        ByteBuffer.allocate(12).order(ByteOrder.BIG_ENDIAN).putLong(0L).putInt(annexB.size).array()
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

    override fun close() {
      thread.interrupt()
      serverChannel.close()
      Files.deleteIfExists(socketPath)
      Files.deleteIfExists(tempDir)
    }
  }
}

package dev.jasonpearson.automobile.junit

import java.net.StandardProtocolFamily
import java.net.UnixDomainSocketAddress
import java.nio.channels.Channels
import java.nio.channels.ClosedChannelException
import java.nio.channels.ServerSocketChannel
import java.nio.channels.SocketChannel
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.serializer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class DaemonSocketClientSendFailureTest {
  private val json = Json { ignoreUnknownKeys = true }
  private lateinit var tempDirectory: Path
  private lateinit var server: ServerSocketChannel
  private lateinit var connection: SocketChannel
  private lateinit var client: DaemonSocketClient
  private var responseThread: Thread? = null

  @Before
  fun setUp() {
    tempDirectory = Files.createTempDirectory("ds")
    val socketPath = tempDirectory.resolve("s")
    server = ServerSocketChannel.open(StandardProtocolFamily.UNIX)
    server.bind(UnixDomainSocketAddress.of(socketPath))
    client =
      DaemonSocketClient(
        socketPath.toString(),
        clientVersion = null,
        clientBuildId = null,
        clientEntryScript = null,
      )
    // connect() has already queued this connection; there is no separate handshake to serve.
    connection = server.accept()
  }

  @After
  fun tearDown() {
    if (::client.isInitialized) client.close()
    if (::connection.isInitialized) connection.close()
    if (::server.isInitialized) server.close()
    responseThread?.join(2000)
    if (::tempDirectory.isInitialized) {
      Files.deleteIfExists(tempDirectory.resolve("s"))
      Files.deleteIfExists(tempDirectory)
    }
    assertFalse("Response thread did not stop", responseThread?.isAlive == true)
  }

  @Test(timeout = 2000)
  fun `callTool write failure maps to unavailable and removes pending request`() {
    assertSendFailure { client.callTool("x", JsonObject(emptyMap()), 1000) }
  }

  @Test(timeout = 2000)
  fun `readResource write failure maps to unavailable and removes pending request`() {
    assertSendFailure { client.readResource("test://x", 1000) }
  }

  @Test(timeout = 2000)
  fun `callDaemonMethod write failure maps to unavailable and removes pending request`() {
    assertSendFailure { client.callDaemonMethod("x", 1000) }
  }

  @Test(timeout = 2000)
  fun `normal request returns response and removes pending request`() {
    val sentResponse = CompletableFuture<DaemonResponse>()
    responseThread =
      thread(isDaemon = true, name = "daemon-test-response") {
        try {
          val reader = Channels.newInputStream(connection).bufferedReader(StandardCharsets.UTF_8)
          val writer = Channels.newOutputStream(connection).bufferedWriter(StandardCharsets.UTF_8)
          val request = json.decodeFromString(serializer<DaemonRequest>(), reader.readLine())
          val response =
            DaemonResponse(
              id = request.id,
              type = "mcp_response",
              success = true,
              result = JsonObject(mapOf("ok" to JsonPrimitive(true))),
            )
          writer.write(json.encodeToString(response))
          writer.newLine()
          writer.flush()
          sentResponse.complete(response)
        } catch (e: Exception) {
          sentResponse.completeExceptionally(e)
        }
      }

    val response = client.callTool("x", JsonObject(emptyMap()), 1000)

    assertEquals(sentResponse.get(2, TimeUnit.SECONDS), response)
    assertTrue(response.success)
    assertEquals(JsonObject(mapOf("ok" to JsonPrimitive(true))), response.result)
    assertEquals(0, client.pendingRequestCount())
  }

  private fun assertSendFailure(call: () -> DaemonResponse) {
    client.shutdownOutputForTest()
    assertTrue("Output shutdown should leave the client connected", client.isConnected())

    val failure = assertThrows(DaemonUnavailableException::class.java) { call() }

    assertTrue(failure.cause is ClosedChannelException)
    assertEquals(0, client.pendingRequestCount())
    assertTrue("The server should still hold the connection open", client.isConnected())
  }
}

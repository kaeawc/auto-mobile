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
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
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
    val sentFrame = CompletableFuture<JsonObject>()
    responseThread =
      thread(isDaemon = true, name = "daemon-test-response") {
        try {
          val reader = Channels.newInputStream(connection).bufferedReader(StandardCharsets.UTF_8)
          val writer = Channels.newOutputStream(connection).bufferedWriter(StandardCharsets.UTF_8)
          val frame = json.parseToJsonElement(reader.readLine()).jsonObject
          sentFrame.complete(frame)
          val request = json.decodeFromJsonElement(serializer<DaemonRequest>(), frame)
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
    assertEquals(JsonPrimitive(true), sentFrame.get(2, TimeUnit.SECONDS)["acceptsRequestBudget"])
    assertTrue(response.success)
    assertEquals(JsonObject(mapOf("ok" to JsonPrimitive(true))), response.result)
    assertEquals(0, client.pendingRequestCount())
  }

  @Test(timeout = OWNER_TEST_TIMEOUT_MS)
  fun `tool calls replace caller owner metadata with the injected token and preserve sessions`() {
    client.close()
    connection.close()
    client =
      DaemonSocketClient(
        tempDirectory.resolve("s").toString(),
        clientVersion = null,
        clientBuildId = null,
        clientEntryScript = null,
        livenessOwnerToken = "injected-owner",
      )
    connection = server.accept()
    val request =
      captureRequest(connection) {
        client.callTool(
          "x",
          JsonObject(
            mapOf(
              OWNER_TOKEN_KEY to JsonPrimitive("caller-data"),
              "sessionUuid" to JsonPrimitive("caller-session"),
            ),
          ),
          OWNER_REQUEST_TIMEOUT_MS,
        )
      }
    val arguments = request.params["arguments"]!!.jsonObject
    assertEquals("tools/call", request.method)
    assertEquals("injected-owner", arguments[OWNER_TOKEN_KEY]!!.jsonPrimitive.content)
    assertEquals("caller-session", arguments["sessionUuid"]!!.jsonPrimitive.content)
  }

  @Test(timeout = OWNER_TEST_TIMEOUT_MS)
  fun `default clients in one process send the same owner token`() {
    val first =
      captureRequest(connection) {
        client.callTool("x", JsonObject(emptyMap()), OWNER_REQUEST_TIMEOUT_MS)
      }
    DaemonSocketClient(
        tempDirectory.resolve("s").toString(),
        clientVersion = null,
        clientBuildId = null,
        clientEntryScript = null,
      )
      .use { second ->
        server.accept().use { secondConnection ->
          val next =
            captureRequest(secondConnection) {
              second.callTool("x", JsonObject(emptyMap()), OWNER_REQUEST_TIMEOUT_MS)
            }
          val firstArguments = first.params["arguments"]!!.jsonObject
          val nextArguments = next.params["arguments"]!!.jsonObject
          assertEquals(
            DaemonLivenessOwner.token,
            firstArguments[OWNER_TOKEN_KEY]!!.jsonPrimitive.content,
          )
          assertEquals(firstArguments[OWNER_TOKEN_KEY], nextArguments[OWNER_TOKEN_KEY])
          assertEquals(client.sessionUuid, firstArguments["sessionUuid"]!!.jsonPrimitive.content)
          assertEquals(second.sessionUuid, nextArguments["sessionUuid"]!!.jsonPrimitive.content)
        }
      }
  }

  @Test(timeout = OWNER_TEST_TIMEOUT_MS)
  fun `resource reads and daemon methods add no tool owner metadata`() {
    val resource =
      captureRequest(connection) { client.readResource("test://x", OWNER_REQUEST_TIMEOUT_MS) }
    val daemon =
      captureRequest(connection) {
        client.callDaemonMethod("daemon/status", OWNER_REQUEST_TIMEOUT_MS)
      }
    assertEquals("resources/read", resource.method)
    assertEquals("daemon/status", daemon.method)
    assertFalse(json.encodeToString(resource).contains(OWNER_TOKEN_KEY))
    assertFalse(json.encodeToString(daemon).contains(OWNER_TOKEN_KEY))
  }

  private fun captureRequest(socket: SocketChannel, call: () -> DaemonResponse): DaemonRequest {
    val captured = CompletableFuture<DaemonRequest>()
    responseThread =
      thread(isDaemon = true, name = "daemon-test-owner-frame") {
        try {
          val reader = Channels.newInputStream(socket).bufferedReader(StandardCharsets.UTF_8)
          val writer = Channels.newOutputStream(socket).bufferedWriter(StandardCharsets.UTF_8)
          val request = json.decodeFromString(serializer<DaemonRequest>(), reader.readLine())
          writer.write(
            json.encodeToString(DaemonResponse(request.id, "mcp_response", success = true)),
          )
          writer.newLine()
          writer.flush()
          captured.complete(request)
        } catch (e: Exception) {
          captured.completeExceptionally(e)
        }
      }
    assertTrue(call().success)
    return captured.get(OWNER_TEST_TIMEOUT_MS, TimeUnit.MILLISECONDS)
  }

  private companion object {
    const val OWNER_TOKEN_KEY = "__autoMobileOwnedSessionsOwnerToken"
    const val OWNER_REQUEST_TIMEOUT_MS = 1000L
    const val OWNER_TEST_TIMEOUT_MS = 2000L
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

package dev.jasonpearson.automobile.junit

import java.net.StandardProtocolFamily
import java.net.UnixDomainSocketAddress
import java.nio.channels.Channels
import java.nio.channels.ServerSocketChannel
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import kotlin.concurrent.thread
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.serializer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DaemonSocketClientReaderResilienceTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test(timeout = 5000)
  fun `a response handler throwing RuntimeException does not stop later lines`() {
    val directory = Files.createTempDirectory("ds")
    val socketPath = directory.resolve("s")
    val server = ServerSocketChannel.open(StandardProtocolFamily.UNIX)
    server.bind(UnixDomainSocketAddress.of(socketPath))
    val seen = mutableListOf<String>()
    val client =
      DaemonSocketClient(
        socketPath.toString(),
        clientVersion = null,
        clientBuildId = null,
        clientEntryScript = null,
        responseObserver = { response ->
          seen += response.id
          if (response.id == "boom") throw IllegalStateException("handler failed")
        },
      )
    val connection = server.accept()
    val responder =
      thread(isDaemon = true, name = "daemon-test-resilience") {
        val reader = Channels.newInputStream(connection).bufferedReader(StandardCharsets.UTF_8)
        val writer = Channels.newOutputStream(connection).bufferedWriter(StandardCharsets.UTF_8)
        val request = json.decodeFromString(serializer<DaemonRequest>(), reader.readLine())
        writer.write("""{"type":"daemon_notification","method":"notifications/progress"}""")
        writer.newLine()
        writer.write(
          """{"type":"daemon_notification","method":"notifications/automobile/requestBudget","requestId":"${request.id}","timeoutMs":4000}""",
        )
        writer.newLine()
        writer.write("{malformed")
        writer.newLine()
        listOf("boom", request.id).forEach { id ->
          writer.write(json.encodeToString(DaemonResponse(id, "mcp_response", success = true)))
          writer.newLine()
        }
        writer.flush()
      }

    try {
      val response = client.callTool("x", kotlinx.serialization.json.JsonObject(emptyMap()), 3000)

      assertTrue(response.success)
      assertEquals(listOf("boom", response.id), seen)
    } finally {
      client.close()
      connection.close()
      server.close()
      responder.join(2000)
      Files.deleteIfExists(socketPath)
      Files.deleteIfExists(directory)
    }
  }
}

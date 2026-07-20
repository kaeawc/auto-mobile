package dev.jasonpearson.automobile.desktop.core.daemon

import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.StandardProtocolFamily
import java.net.UnixDomainSocketAddress
import java.nio.channels.Channels
import java.nio.channels.ServerSocketChannel
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * A one-shot Unix domain socket speaking the daemon's request/response envelope, for exercising the
 * auxiliary socket clients without a running daemon.
 *
 * Accepts exactly one connection, captures the request, and replies with either
 * `{"success":true,"result":...}` or `{"success":false,"error":...}` -- matching the daemon, which
 * omits `result` entirely on failure but still stamps the response `type`.
 */
class TestConfigSocketServer(
  private val responseType: String,
  private val resultJson: String? = null,
  private val error: String? = null,
  socketFileName: String = "test.sock",
  /**
   * A JSON object whose fields are merged into the response alongside `id`/`type`/`success`,
   * instead of wrapping [resultJson] in a `result` object. The WebRTC stream socket answers with
   * `stream`/`streams` at the top level rather than under `result`, so it needs this.
   */
  private val rawBodyJson: String? = null,
  private val success: Boolean = true,
) : AutoCloseable {
  private val json = Json { ignoreUnknownKeys = true }
  private val tempDir: Path = Files.createTempDirectory(Path.of("/tmp"), "amsock-")

  val socketPath: Path = tempDir.resolve(socketFileName)

  private val serverChannel =
    ServerSocketChannel.open(StandardProtocolFamily.UNIX)
      .bind(UnixDomainSocketAddress.of(socketPath))

  private var captured: JsonObject? = null
  private var failure: Throwable? = null

  private val thread = Thread {
    try {
      serverChannel.accept().use { channel ->
        val reader =
          BufferedReader(
            InputStreamReader(Channels.newInputStream(channel), StandardCharsets.UTF_8)
          )
        val writer =
          BufferedWriter(
            OutputStreamWriter(Channels.newOutputStream(channel), StandardCharsets.UTF_8)
          )
        val request = json.parseToJsonElement(reader.readLine()).jsonObject
        captured = request
        writer.write(responseLine(request["id"]?.jsonPrimitive?.content ?: "unknown"))
        writer.newLine()
        writer.flush()
      }
    } catch (throwable: Throwable) {
      failure = throwable
    }
  }
    .also { it.start() }

  /** The request the client sent. Fails the test if none arrived before the timeout. */
  fun awaitRequest(): JsonObject {
    thread.join(REQUEST_TIMEOUT_MILLIS)
    if (thread.isAlive) throw AssertionError("Client did not send a request before timeout")
    failure?.let { throw AssertionError("Test socket server failed", it) }
    return captured ?: throw AssertionError("Client did not send a request")
  }

  private fun responseLine(requestId: String): String {
    val body =
      when {
        rawBodyJson != null -> {
          // Merge the caller's object into the envelope: drop its outer braces so the fields sit
          // alongside id/type/success rather than nesting.
          val compact = rawBodyJson.lineSequence().joinToString("") { it.trim() }
          compact.removePrefix("{").removeSuffix("}")
        }
        error != null -> """"error":${JsonPrimitive(error)}"""
        else -> {
          val compact = (resultJson ?: "{}").lineSequence().joinToString("") { it.trim() }
          """"result":$compact"""
        }
      }
    val succeeded = if (rawBodyJson != null) success else error == null
    return """{"id":"$requestId","type":"$responseType","success":$succeeded,$body}"""
  }

  override fun close() {
    serverChannel.close()
    Files.deleteIfExists(socketPath)
    Files.deleteIfExists(tempDir)
  }

  private companion object {
    const val REQUEST_TIMEOUT_MILLIS = 5_000L
  }
}

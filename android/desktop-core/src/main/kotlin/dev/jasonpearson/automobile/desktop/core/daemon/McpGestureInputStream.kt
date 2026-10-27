package dev.jasonpearson.automobile.desktop.core.daemon

import java.io.BufferedReader
import java.io.BufferedWriter
import java.nio.channels.SocketChannel
import java.util.UUID
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.serializer

/** A connected Unix-socket channel plus its line reader/writer, kept open across gesture frames. */
internal class McpPersistentChannel(
  val channel: SocketChannel,
  val reader: BufferedReader,
  val writer: BufferedWriter,
)

/**
 * One streamed gesture over a single held connection. Each frame writes one `input/gesture*` line
 * and reads its ack, under the same per-input hang ceiling as one-shot input calls (a hung frame
 * closes the channel, killing the stream so the caller falls back rather than freezing).
 */
internal class McpGestureInputStream(
  private val client: McpDaemonClient,
  private val platform: String,
  private val deviceId: String?,
  private val connection: McpPersistentChannel,
) : GestureInputStream {
  override fun start(gestureId: String, x: Double, y: Double): InputActionResult =
    sendFrame("input/gestureStart") {
      put("platform", JsonPrimitive(platform))
      putOptionalString("deviceId", deviceId)
      put("gestureId", JsonPrimitive(gestureId))
      put("x", JsonPrimitive(x))
      put("y", JsonPrimitive(y))
    }

  override fun move(gestureId: String, x: Double, y: Double): InputActionResult =
    sendFrame("input/gestureMove") {
      put("platform", JsonPrimitive(platform))
      putOptionalString("deviceId", deviceId)
      put("gestureId", JsonPrimitive(gestureId))
      put("x", JsonPrimitive(x))
      put("y", JsonPrimitive(y))
    }

  override fun end(
    gestureId: String,
    x: Double,
    y: Double,
    cancel: Boolean,
  ): InputActionResult =
    sendFrame("input/gestureEnd") {
      put("platform", JsonPrimitive(platform))
      putOptionalString("deviceId", deviceId)
      put("gestureId", JsonPrimitive(gestureId))
      put("x", JsonPrimitive(x))
      put("y", JsonPrimitive(y))
      put("cancel", JsonPrimitive(cancel))
    }

  override fun close() {
    try {
      connection.channel.close()
    } catch (error: java.io.IOException) {
      DAEMON_PATHS_LOG.debug("Daemon close failed: ${error.message}")

      // Best-effort; the stream is being torn down regardless.
    }
  }

  private fun sendFrame(method: String, params: JsonObjectBuilder.() -> Unit): InputActionResult {
    val request =
      DaemonRequest(
        id = UUID.randomUUID().toString(),
        type = "mcp_request",
        method = method,
        params = withInputSession(buildJsonObject(params)),
        clientVersion = clientVersion,
        timeoutMs = inputRequestTimeoutMs,
      )
    val expired = java.util.concurrent.atomic.AtomicBoolean(false)
    val watchdog =
      McpDaemonClient.requestWatchdog.schedule(
        {
          expired.set(true)
          try {
            connection.channel.close()
          } catch (error: java.io.IOException) {
            DAEMON_PATHS_LOG.debug("Daemon sendFrame failed: ${error.message}")

            // Best-effort; the frame call owns the definitive failure.
          }
        },
        inputRequestTimeoutMs,
        java.util.concurrent.TimeUnit.MILLISECONDS,
      )
    return try {
      connection.writer.write(json.encodeToString(request))
      connection.writer.newLine()
      connection.writer.flush()
      val line =
        connection.reader.readLine()
          ?: return InputActionResult(
            action = method,
            success = false,
            error = "Gesture stream closed",
          )
      val response = json.decodeFromString<DaemonResponse>(line)
      response.toInputActionResult(method)
    } catch (e: java.io.IOException) {
      val message =
        if (expired.get()) "Gesture frame '$method' timed out after ${inputRequestTimeoutMs}ms"
        else e.message ?: "Gesture frame '$method' failed"
      InputActionResult(action = method, success = false, error = message)
    } catch (e: IllegalArgumentException) {
      val message =
        if (expired.get()) "Gesture frame '$method' timed out after ${inputRequestTimeoutMs}ms"
        else e.message ?: "Gesture frame '$method' failed"
      InputActionResult(action = method, success = false, error = message)
    } finally {
      watchdog.cancel(false)
    }
  }

  private val json
    get() = client.json

  private val clientVersion
    get() = client.clientVersion

  private val inputRequestTimeoutMs
    get() = client.inputRequestTimeoutMs

  private fun withInputSession(params: JsonObject): JsonObject = client.withInputSession(params)

  private fun DaemonResponse.toInputActionResult(method: String): InputActionResult {
    if (!success) return toFailedInputResult(method)
    val body =
      result
        ?: return InputActionResult(
          action = method,
          success = false,
          error = "Daemon response missing result",
        )
    return json.decodeFromJsonElement(serializer<InputActionResult>(), body)
  }
}

@file:OptIn(dev.jasonpearson.automobile.ctrlproxy.prototype.InternalAutoMobilePrototypeApi::class)

package dev.jasonpearson.automobile.prototype.appshell

import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeOfflineEventBuffer
import dev.jasonpearson.automobile.protocol.PrototypeEvent
import dev.jasonpearson.automobile.protocol.PrototypeResult
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import java.security.MessageDigest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.*

/**
 * A line excludes its newline; implementations must bound reads before allocating the whole line.
 */
internal interface AttachConnection {
  suspend fun readLine(maxBytes: Int = Int.MAX_VALUE): String?

  suspend fun write(line: String)

  fun close()
}

internal interface AttachTarget {
  suspend fun patch(id: String, baseRevision: Long?, ops: JsonArray): PrototypeResult

  suspend fun status(): JsonObject
}

/** Uses exactly the response encoding used by CtrlProxy's WebSocketServer. */
internal val attachJson = Json {
  prettyPrint = false
  encodeDefaults = true
  classDiscriminator = "type"
}

/** No Android dependencies: the scope supplies scheduling (including virtual hello deadlines). */
internal class AppAttachAgent(
  token: String?,
  private val target: AttachTarget,
  private val scope: CoroutineScope,
  private val buffer: PrototypeOfflineEventBuffer = PrototypeOfflineEventBuffer(),
  private val clock: () -> Long = System::currentTimeMillis,
  private val log: (String) -> Unit,
) {
  private val tokenBytes = token?.trim()?.takeIf { it.isNotEmpty() }?.toByteArray(Charsets.UTF_8)
  val enabled: Boolean
    get() = tokenBytes != null

  private val delivery = Mutex()
  private val requests = Mutex()
  private var active: AttachConnection? = null

  suspend fun serve(connection: AttachConnection) {
    if (!enabled) {
      connection.close()
      return
    }
    // Closing the underlying socket also releases a blocking Android read at the deadline.
    val deadline = scope.launch {
      delay(HELLO_TIMEOUT_MS)
      connection.close()
    }
    try {
      val hello = withTimeoutOrNull(HELLO_TIMEOUT_MS) { connection.readLine(HELLO_MAX_BYTES) }
      deadline.cancel()
      if (!authenticated(hello)) return
      requests.withLock {
        delivery.withLock {
          active?.close()
          active = connection
          connection.write(
            buildJsonObject {
              put("type", "hello_result")
              put("agentVersion", "0.1.0")
              put("protocolVersion", 1)
              put("capabilities", JsonArray(CAPABILITIES.map(::JsonPrimitive)))
            }
              .toString(),
          )
          replay(connection)
        }
      }
      while (true) {
        val line = connection.readLine() ?: break
        requests.withLock {
          // Replacement and execution share this lock, so obsolete peers cannot patch a new
          // session.
          if (delivery.withLock { active === connection }) {
            val request = attachJson.parseToJsonElement(line).jsonObject
            val result = handle(request)
            delivery.withLock {
              if (active === connection) connection.write(frame(result))
            }
          }
        }
      }
    } catch (error: CancellationException) {
      throw error
    } catch (_: Exception) {
      // Do not log payloads or exception messages: the first frame contains a secret.
      log("Attach connection closed after a transport or protocol failure")
    } finally {
      deadline.cancel()
      connection.close()
      withContext(NonCancellable) {
        delivery.withLock { if (active === connection) active = null }
      }
    }
  }

  private fun authenticated(line: String?): Boolean {
    if (line == null || line.toByteArray(Charsets.UTF_8).size > HELLO_MAX_BYTES) return false
    val hello = attachJson.parseToJsonElement(line) as? JsonObject ?: return false
    if (hello["type"] != JsonPrimitive("hello")) return false
    val supplied = hello["token"] as? JsonPrimitive ?: return false
    return supplied.isString &&
      MessageDigest.isEqual(tokenBytes, supplied.content.toByteArray(Charsets.UTF_8))
  }

  private suspend fun handle(request: JsonObject): PrototypeResult {
    val type = request["type"]?.jsonPrimitive?.content.orEmpty()
    val requestId = request["requestId"]?.jsonPrimitive?.content
    val result =
      when (type) {
        "get_prototype_status" -> {
          val status = target.status()
          val dropped = delivery.withLock { buffer.dropped }
          PrototypeResult(
            clock(),
            success = true,
            status = JsonObject(status + ("droppedEvents" to JsonPrimitive(dropped))),
          )
        }
        "patch_prototype" ->
          target.patch(
            request.getValue("id").jsonPrimitive.content,
            request["baseRevision"]?.jsonPrimitive?.longOrNull,
            request.getValue("ops").jsonArray,
          )
        else -> PrototypeResult(clock(), success = false, error = "unsupported request: $type")
      }
    return result.copy(timestamp = clock(), requestId = requestId)
  }

  suspend fun emit(event: PrototypeEvent) = delivery.withLock {
    val connection = active
    buffer.add(event)
    if (connection != null) {
      try {
        replay(connection)
      } catch (error: CancellationException) {
        throw error
      } catch (_: Exception) {
        log("Attach event delivery deferred until reconnect")
      }
    }
  }

  private suspend fun replay(connection: AttachConnection) {
    val pending = buffer.drain()
    var next = 0
    try {
      while (next < pending.size) {
        connection.write(frame(pending[next]))
        next++
      }
    } finally {
      if (next < pending.size) {
        buffer.restore(pending.subList(next, pending.size))
        connection.close()
        if (active === connection) active = null
      }
    }
  }

  private fun frame(response: WebSocketResponse): String =
    attachJson.encodeToString(WebSocketResponse.serializer(), response)

  companion object {
    const val HELLO_MAX_BYTES = 4096
    const val HELLO_TIMEOUT_MS = 5000L
    val CAPABILITIES =
      listOf(
        "get_prototype_status",
        "patch_prototype",
        "prototype_patch_v1",
        "prototype_inspect_v1",
        "prototype_persistence_replay_v1",
      )
  }
}

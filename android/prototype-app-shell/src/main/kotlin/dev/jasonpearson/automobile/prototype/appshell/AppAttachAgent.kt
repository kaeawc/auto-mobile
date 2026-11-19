@file:OptIn(dev.jasonpearson.automobile.ctrlproxy.prototype.InternalAutoMobilePrototypeApi::class)

package dev.jasonpearson.automobile.prototype.appshell

import dev.jasonpearson.automobile.protocol.PrototypeEvent
import dev.jasonpearson.automobile.protocol.PrototypeResult
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import java.security.MessageDigest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.yield
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
  val appInstanceId: String
  val showingId: String?
    get() = null

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
@Suppress("LongParameterList") // Independent test seams plus the restored journal and its writer.
internal class AppAttachAgent(
  token: String?,
  private val target: AttachTarget,
  private val scope: CoroutineScope,
  private val capacity: Int = MAX_PENDING_EVENTS,
  private val clock: () -> Long = System::currentTimeMillis,
  private val log: (String) -> Unit,
  restored: AttachJournalState? = null,
  private val persist: (pending: List<PrototypeEvent>, dropped: Long, lastSequence: Long) -> Unit =
    { _, _, _ ->
    },
) {
  private val tokenBytes = token?.trim()?.takeIf { it.isNotEmpty() }?.toByteArray(Charsets.UTF_8)
  val enabled: Boolean
    get() = tokenBytes != null

  private val delivery = Mutex()
  private val requests = Mutex()

  init {
    require(capacity in 1..MAX_PENDING_EVENTS)
    require((restored?.pending?.size ?: 0) <= capacity)
  }

  // Retained until host acknowledgement, including writes accepted only by adbd.
  private val pending = ArrayDeque(restored?.pending.orEmpty())
  private var dropped = restored?.dropped ?: 0L
  private var lastSequence = restored?.lastSequence ?: 0L
  private var active: Session? = null

  private class Session(val connection: AttachConnection) {
    val outbound = Channel<String>(OUTBOUND_CAPACITY)
    var writer: Job? = null

    fun close() {
      connection.close()
      outbound.cancel()
      writer?.cancel()
    }
  }

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
      val authenticatedHello = authenticated(hello) ?: return
      val session = registerSession(connection, authenticatedHello) ?: return
      // Never perform transport I/O under delivery or requests. One writer preserves wire order.
      session.writer = scope.launch(start = CoroutineStart.UNDISPATCHED) { writeOutbound(session) }
      receiveRequests(session)
    } catch (error: CancellationException) {
      throw error
    } catch (_: Exception) {
      // Do not log payloads or exception messages: the first frame contains a secret.
      log("Attach connection closed after a transport or protocol failure")
    } finally {
      deadline.cancel()
      connection.close()
      withContext(NonCancellable) {
        delivery.withLock {
          active
            ?.takeIf { it.connection === connection }
            ?.let {
              active = null
              it.close()
            }
        }
      }
    }
  }

  private suspend fun registerSession(
    connection: AttachConnection,
    hello: JsonObject,
  ): Session? = delivery.withLock {
    if (active != null) return@withLock null
    if (hello["appInstanceId"] == JsonPrimitive(target.appInstanceId)) {
      acknowledge(hello["lastAcknowledgedSequence"]?.jsonPrimitive?.longOrNull ?: 0)
    }
    Session(connection).also {
      active = it
      enqueue(
        it,
        buildJsonObject {
          put("type", "hello_result")
          put("agentVersion", "0.1.0")
          put("appInstanceId", target.appInstanceId)
          target.showingId?.let { put("showingId", it) }
          put("protocolVersion", 1)
          put("capabilities", JsonArray(CAPABILITIES.map(::JsonPrimitive)))
          put("droppedEvents", dropped)
        }
          .toString(),
      )
      pending.forEach { event -> enqueue(it, frame(event)) }
    }
  }

  private suspend fun receiveRequests(session: Session) {
    while (true) {
      val line = session.connection.readLine() ?: break
      requests.withLock {
        if (delivery.withLock { active === session }) {
          val request = attachJson.parseToJsonElement(line).jsonObject
          if (request["type"] == JsonPrimitive("ack")) {
            delivery.withLock {
              if (request["appInstanceId"] == JsonPrimitive(target.appInstanceId)) {
                acknowledge(request.getValue("sequence").jsonPrimitive.long)
              }
            }
          } else {
            val result = handle(request)
            delivery.withLock {
              if (active === session) enqueue(session, frame(result))
            }
          }
        }
      }
      yield()
    }
  }

  private fun authenticated(line: String?): JsonObject? {
    if (line == null || line.toByteArray(Charsets.UTF_8).size > HELLO_MAX_BYTES) return null
    val hello = attachJson.parseToJsonElement(line) as? JsonObject ?: return null
    if (hello["type"] != JsonPrimitive("hello")) return null
    val supplied = hello["token"] as? JsonPrimitive ?: return null
    return hello.takeIf {
      supplied.isString &&
        MessageDigest.isEqual(tokenBytes, supplied.content.toByteArray(Charsets.UTF_8))
    }
  }

  private suspend fun handle(request: JsonObject): PrototypeResult {
    val type = request["type"]?.jsonPrimitive?.content.orEmpty()
    val requestId = request["requestId"]?.jsonPrimitive?.content
    val result =
      when (type) {
        "get_prototype_status" -> {
          val status = target.status()
          val droppedCount = delivery.withLock { dropped }
          PrototypeResult(
            clock(),
            success = true,
            status = JsonObject(status + ("droppedEvents" to JsonPrimitive(droppedCount))),
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
    lastSequence = maxOf(lastSequence, event.sequence)
    if (pending.size == capacity) {
      pending.removeFirst()
      dropped++
    }
    pending.addLast(event)
    persist(pending.toList(), dropped, lastSequence)
    active?.let { enqueue(it, frame(event)) }
  }

  private fun acknowledge(sequence: Long) {
    require(sequence in 0..lastSequence) { "Invalid attach acknowledgement" }
    val previousSize = pending.size
    while (pending.firstOrNull()?.let { it.sequence <= sequence } == true) pending.removeFirst()
    if (pending.size != previousSize) persist(pending.toList(), dropped, lastSequence)
  }

  // Call only under delivery; a full queue drops the peer, never blocks the producer.
  private fun enqueue(session: Session, frame: String) {
    if (active === session && session.outbound.trySend(frame).isFailure) {
      active = null
      session.close()
    }
  }

  private suspend fun writeOutbound(session: Session) {
    try {
      for (line in session.outbound) {
        // Android stream writes block. Closing the socket from a separate coroutine unblocks I/O.
        val deadline = scope.launch {
          delay(WRITE_TIMEOUT_MS)
          session.connection.close()
        }
        try {
          withTimeoutOrNull(WRITE_TIMEOUT_MS) {
            session.connection.write(line)
            true
          } ?: error("Attach write timed out")
        } finally {
          deadline.cancel()
        }
      }
    } catch (error: CancellationException) {
      throw error
    } catch (_: Exception) {
      log("Attach event delivery deferred until reconnect")
    } finally {
      session.connection.close()
      withContext(NonCancellable) {
        delivery.withLock {
          if (active === session) active = null
          session.outbound.cancel()
        }
      }
    }
  }

  private fun frame(response: WebSocketResponse): String =
    attachJson.encodeToString(WebSocketResponse.serializer(), response)

  companion object {
    const val MAX_PENDING_EVENTS = 200
    const val OUTBOUND_CAPACITY = 256
    const val WRITE_TIMEOUT_MS = 5000L
    const val HELLO_MAX_BYTES = 4096
    const val HELLO_TIMEOUT_MS = 5000L
    val CAPABILITIES =
      listOf(
        "get_prototype_status",
        "patch_prototype",
        "prototype_patch_v1",
        "prototype_inspect_v1",
        "prototype_persistence_replay_v1",
        "prototype_event_ack_v1",
      )
  }
}

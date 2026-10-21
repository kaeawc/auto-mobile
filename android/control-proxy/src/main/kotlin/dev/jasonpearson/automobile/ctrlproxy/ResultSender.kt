package dev.jasonpearson.automobile.ctrlproxy

import android.util.Log
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import kotlinx.serialization.json.JsonElement

/**
 * The one way a controller puts a request's result on the wire (#11877).
 *
 * Every result used to repeat the same steps at its own call site: skip when the server is not
 * running, open a [ResultBroadcaster.guard] so a throw becomes a correlated `ErrorResponse`, flush
 * the request's perf timing into the frame, route it by `requestId`, and log the client count. A
 * call site that forgot one step (most often the guard) reintroduced the silent hang #3045 fixed.
 * Each step now lives here once, and a controller only says what to send.
 *
 * Encoding stays with the caller: [sendFrame] takes the frame builders that pin each result's
 * byte-exact wire form, and [send] takes a typed response that the server encodes.
 */
interface ResultSender {
  /**
   * Sends the frame [encode] returns as the result of [requestId]. [encode] receives the request's
   * flushed perf timing when [attachPerf] is true, else null; a result that never carried perf
   * timing passes false so its flush stays with the next result that does.
   */
  suspend fun sendFrame(
    requestId: String?,
    action: String,
    attachPerf: Boolean = true,
    encode: (perfTiming: JsonElement?) -> String,
  )

  /** Typed counterpart of [sendFrame]; [build] receives the perf timing as compact JSON text. */
  suspend fun send(
    requestId: String?,
    action: String,
    attachPerf: Boolean = true,
    build: (perfTiming: String?) -> WebSocketResponse,
  )
}

/**
 * [ResultSender] over the service's late-bound WebSocket server.
 *
 * @param transport the server behind the running check, perf flush and routing.
 * @param resultBroadcaster turns a throw while building or sending into a correlated error frame.
 * @param logDebug diagnostic sink; `Log.d` in production, overridable so tests stay Android-free.
 */
class GuardedResultSender(
  private val transport: Transport,
  private val resultBroadcaster: ResultBroadcaster,
  private val logDebug: (String) -> Unit = { Log.d(TAG, it) },
) : ResultSender {
  /** The server operations a result needs. */
  interface Transport {
    /** False until the server is constructed and while it is stopped. */
    fun isRunning(): Boolean

    /** Takes the perf timing accumulated for the current request. */
    fun flushPerfTiming(): JsonElement?

    /** Routes an encoded frame to the client that owns its `requestId`, else broadcasts it. */
    suspend fun sendFrame(frame: String)

    /** Encodes and routes a typed response the same way. */
    suspend fun send(response: WebSocketResponse)

    fun connectionCount(): Int
  }

  override suspend fun sendFrame(
    requestId: String?,
    action: String,
    attachPerf: Boolean,
    encode: (perfTiming: JsonElement?) -> String,
  ) {
    guarded(requestId, action) { transport.sendFrame(encode(perfTiming(attachPerf))) }
  }

  override suspend fun send(
    requestId: String?,
    action: String,
    attachPerf: Boolean,
    build: (perfTiming: String?) -> WebSocketResponse,
  ) {
    guarded(requestId, action) { transport.send(build(perfTiming(attachPerf)?.toString())) }
  }

  private fun perfTiming(attachPerf: Boolean): JsonElement? =
    if (attachPerf) transport.flushPerfTiming() else null

  private suspend fun guarded(requestId: String?, action: String, block: suspend () -> Unit) {
    if (!transport.isRunning()) {
      logDebug("WebSocket server not running, skipping $action")
      return
    }
    resultBroadcaster.guard(requestId, action) {
      block()
      logDebug("Sent $action to ${transport.connectionCount()} clients")
    }
  }

  companion object {
    private const val TAG = "ResultSender"
  }
}

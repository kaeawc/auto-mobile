package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.util.Log
import dev.jasonpearson.automobile.protocol.PrototypeNetworkFrames
import dev.jasonpearson.automobile.protocol.PrototypeRequestCancelFrame
import dev.jasonpearson.automobile.protocol.PrototypeRequestError
import dev.jasonpearson.automobile.protocol.PrototypeRequestErrorCode
import dev.jasonpearson.automobile.protocol.PrototypeRequestFrame
import dev.jasonpearson.automobile.protocol.PrototypeRequestResponse
import dev.jasonpearson.automobile.protocol.PrototypeRequests
import dev.jasonpearson.automobile.protocol.PrototypeResponseFrame
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.SerializationException
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** Where a `prototype_request` frame goes: the CtrlProxy socket to the connected host. */
fun interface PrototypeHostLink {
  /**
   * The connection the frame was queued for (compared by identity, so a later [onHostLost] can name
   * it), or null when no host is connected.
   */
  fun send(frame: String): Any?
}

/**
 * The `via: "host"` transport: sends one `prototype_request` frame over the CtrlProxy socket and
 * waits for the `prototype_response` with the same `requestId`. The host runs the HTTP call (and
 * enforces the timeout and the response cap), so this side only guards against a host that never
 * answers: [graceMs] past the request's own timeout it gives up as `timeout`. With no host
 * connected the request fails at once with `network`.
 *
 * There is no cancel frame: a cancelled request just stops waiting, and the answer, if one still
 * comes, is ignored.
 */
class HostPrototypeHttpClient(
  private val link: PrototypeHostLink,
  private val clock: () -> Long = { System.nanoTime() / NANOS_PER_MILLI },
  private val graceMs: Long = DEFAULT_GRACE_MS,
  private val warn: (String) -> Unit = { Log.w(TAG, it) },
  /** Sends a frame to the connection a request went to; a no-op if that connection is gone. */
  private val cancelLink: (target: Any, frame: String) -> Unit = { _, _ -> },
) : PrototypeHttpClient {
  private class Pending(val answer: CompletableDeferred<PrototypeRequestResponse>) {
    /** The connection the request frame went to; set once the link accepts it. */
    @Volatile var target: Any? = null

    /** Connections that closed while the frame was still being handed to the link. */
    val lostWhileSending = HashSet<Any>()
  }

  private val pending = ConcurrentHashMap<String, Pending>()

  override suspend fun execute(request: PrototypeHttpRequest): PrototypeRequestResponse {
    val started = clock()
    fun failed(code: PrototypeRequestErrorCode, message: String) =
      PrototypeRequestResponse.Failed(PrototypeRequestError(code, message), clock() - started)
    val entry = Pending(CompletableDeferred())
    val answer = entry.answer
    pending[request.requestId] = entry
    try {
      val frame =
        PrototypeNetworkFrames.json.encodeToString(
          PrototypeRequestFrame(
            requestId = request.requestId,
            prototypeId = request.prototypeId,
            method = request.method,
            url = request.url,
            headers = request.headers.takeIf { it.isNotEmpty() },
            body = request.body?.let(PrototypeRequests::sortedKeys),
            timeoutMs = request.timeoutMs,
          ),
        )
      val sentTo =
        link.send(frame) ?: return failed(PrototypeRequestErrorCode.NETWORK, NO_HOST_MESSAGE)
      val closedMeanwhile =
        synchronized(entry) {
          entry.target = sentTo
          sentTo in entry.lostWhileSending
        }
      if (closedMeanwhile) return failed(PrototypeRequestErrorCode.NETWORK, HOST_LOST_MESSAGE)
      val response =
        try {
          withTimeoutOrNull(request.timeoutMs + graceMs) { answer.await() }
        } catch (error: CancellationException) {
          // Superseded, dismissed or reset: tell the host it can stop.
          cancelOnHost(request.requestId, entry.target)
          throw error
        }
      if (response != null) return response
      cancelOnHost(request.requestId, entry.target)
      return failed(
        PrototypeRequestErrorCode.TIMEOUT,
        "The host did not answer within ${request.timeoutMs + graceMs}ms.",
      )
    } finally {
      pending.remove(request.requestId)
    }
  }

  private fun cancelOnHost(requestId: String, target: Any?) {
    if (target == null) return
    cancelLink(
      target,
      PrototypeNetworkFrames.json.encodeToString(
        PrototypeRequestCancelFrame(requestId = requestId),
      ),
    )
  }

  /** A `prototype_response` frame from the host; one for a request no longer waiting is dropped. */
  fun onResponse(frame: String) {
    val response =
      try {
        PrototypeNetworkFrames.json.decodeFromString(PrototypeResponseFrame.serializer(), frame)
      } catch (error: SerializationException) {
        failMalformed(frame, error)
        return
      }
    pending[response.requestId]?.answer?.complete(response.toResponse())
  }

  /**
   * The host went away: nothing will answer what is waiting. With a [connection], only the requests
   * sent to it fail, at once; the others still have a live socket to answer on. Without one, every
   * waiting request fails.
   */
  fun onHostLost(connection: Any? = null) {
    pending.values.forEach { entry ->
      val affected =
        synchronized(entry) {
          val target = entry.target
          when {
            connection == null || target === connection -> true
            // Still being handed to the link: remember the close so the send can settle it.
            target == null -> false.also { entry.lostWhileSending += connection }
            else -> false
          }
        }
      if (affected) {
        entry.answer.complete(
          PrototypeRequestResponse.Failed(
            PrototypeRequestError(PrototypeRequestErrorCode.NETWORK, HOST_LOST_MESSAGE),
          ),
        )
      }
    }
  }

  private fun failMalformed(frame: String, error: SerializationException) {
    warn("Malformed prototype_response (${frame.length} chars): ${error.javaClass.simpleName}")
    val requestId =
      try {
        PrototypeNetworkFrames.json
          .parseToJsonElement(frame)
          .jsonObject["requestId"]
          ?.jsonPrimitive
          ?.content
      } catch (_: SerializationException) {
        // Not even an object with a requestId: nothing is waiting on it, so nothing to fail.
        null
      } catch (_: IllegalArgumentException) {
        // A non-primitive requestId is as unusable as a missing one.
        null
      }
    requestId
      ?.let { pending[it] }
      ?.answer
      ?.complete(
        PrototypeRequestResponse.Failed(
          PrototypeRequestError(
            PrototypeRequestErrorCode.NETWORK,
            "The host sent a malformed prototype_response.",
          ),
        ),
      )
  }

  companion object {
    private const val TAG = "HostPrototypeHttp"
    private const val NANOS_PER_MILLI = 1_000_000L
    const val DEFAULT_GRACE_MS = 5_000L

    const val NO_HOST_MESSAGE =
      "No AutoMobile host is connected to run this request (via \"host\"). " +
        "Connect a host, or set via \"device\" to call from the device itself."
    const val HOST_LOST_MESSAGE = "The AutoMobile host disconnected before it answered."
  }
}

package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.util.Log
import dev.jasonpearson.automobile.protocol.PrototypeNetworkFrames
import dev.jasonpearson.automobile.protocol.PrototypeRequestError
import dev.jasonpearson.automobile.protocol.PrototypeRequestErrorCode
import dev.jasonpearson.automobile.protocol.PrototypeRequestFrame
import dev.jasonpearson.automobile.protocol.PrototypeRequestResponse
import dev.jasonpearson.automobile.protocol.PrototypeResponseFrame
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.SerializationException
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** Where a `prototype_request` frame goes: the CtrlProxy socket to the connected host. */
fun interface PrototypeHostLink {
  /** True once the frame is queued for a host; false when none is connected. */
  fun send(frame: String): Boolean
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
) : PrototypeHttpClient {
  private val pending = ConcurrentHashMap<String, CompletableDeferred<PrototypeRequestResponse>>()

  override suspend fun execute(request: PrototypeHttpRequest): PrototypeRequestResponse {
    val started = clock()
    fun failed(code: PrototypeRequestErrorCode, message: String) =
      PrototypeRequestResponse.Failed(PrototypeRequestError(code, message), clock() - started)
    val answer = CompletableDeferred<PrototypeRequestResponse>()
    pending[request.requestId] = answer
    try {
      val frame =
        PrototypeNetworkFrames.json.encodeToString(
          PrototypeRequestFrame(
            requestId = request.requestId,
            prototypeId = request.prototypeId,
            method = request.method,
            url = request.url,
            headers = request.headers.takeIf { it.isNotEmpty() },
            body = request.body,
            timeoutMs = request.timeoutMs,
          ),
        )
      if (!link.send(frame)) {
        return failed(PrototypeRequestErrorCode.NETWORK, NO_HOST_MESSAGE)
      }
      return withTimeoutOrNull(request.timeoutMs + graceMs) { answer.await() }
        ?: failed(
          PrototypeRequestErrorCode.TIMEOUT,
          "The host did not answer within ${request.timeoutMs + graceMs}ms.",
        )
    } finally {
      pending.remove(request.requestId)
    }
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
    pending[response.requestId]?.complete(response.toResponse())
  }

  /** The host went away: nothing will answer what is waiting. */
  fun onHostLost() {
    pending.values.toList().forEach {
      it.complete(
        PrototypeRequestResponse.Failed(
          PrototypeRequestError(PrototypeRequestErrorCode.NETWORK, HOST_LOST_MESSAGE),
        ),
      )
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

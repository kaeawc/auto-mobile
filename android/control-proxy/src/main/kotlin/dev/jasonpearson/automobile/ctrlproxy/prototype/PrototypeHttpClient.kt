package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeRequestError
import dev.jasonpearson.automobile.protocol.PrototypeRequestErrorCode
import dev.jasonpearson.automobile.protocol.PrototypeRequestResponse
import kotlinx.serialization.json.JsonElement

/**
 * One HTTP call of a prototype `request` action, with every binding already resolved and the query
 * merged into [url]. [timeoutMs] is the effective timeout (the authored one, or the default).
 */
data class PrototypeHttpRequest(
  val requestId: String,
  val prototypeId: String,
  val method: String,
  val url: String,
  val headers: Map<String, String>,
  val body: JsonElement?,
  val timeoutMs: Int,
)

/**
 * A transport for [PrototypeHttpRequest]s. The two implementations (the Retrofit device client and
 * the CtrlProxy-socket host client) answer with the same [PrototypeRequestResponse], so the runtime
 * does not care which one ran. Never throws except for cancellation: every failure is a typed
 * [PrototypeRequestResponse.Failed].
 */
fun interface PrototypeHttpClient {
  suspend fun execute(request: PrototypeHttpRequest): PrototypeRequestResponse
}

/** The transport behind each `via` value. */
class PrototypeHttpClients(val host: PrototypeHttpClient, val device: PrototypeHttpClient) {
  fun forVia(via: String): PrototypeHttpClient = if (via == VIA_DEVICE) device else host

  companion object {
    const val VIA_HOST = "host"
    const val VIA_DEVICE = "device"

    /** No transport is wired: every request fails as `network`. */
    val Unavailable: PrototypeHttpClients = PrototypeHttpClient { _ ->
      PrototypeRequestResponse.Failed(
        PrototypeRequestError(
          PrototypeRequestErrorCode.NETWORK,
          "No HTTP client is available on this device.",
        ),
      )
    }
      .let { PrototypeHttpClients(it, it) }
  }
}

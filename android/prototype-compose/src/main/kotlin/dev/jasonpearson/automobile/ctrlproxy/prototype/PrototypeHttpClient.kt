package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeRequestError
import dev.jasonpearson.automobile.protocol.PrototypeRequestErrorCode
import dev.jasonpearson.automobile.protocol.PrototypeRequestResponse
import kotlinx.serialization.json.JsonElement

/**
 * One HTTP call of a prototype `request` action, with every binding already resolved and the query
 * merged into [url]. [timeoutMs] is the effective timeout (the authored one, or the default).
 */
@InternalAutoMobilePrototypeApi
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
@InternalAutoMobilePrototypeApi
fun interface PrototypeHttpClient {
  suspend fun execute(request: PrototypeHttpRequest): PrototypeRequestResponse
}

/** The transport behind each `via` value. */
@InternalAutoMobilePrototypeApi
class PrototypeHttpClients(val host: PrototypeHttpClient, val device: PrototypeHttpClient) {
  fun forVia(via: String): PrototypeHttpClient = if (via == VIA_DEVICE) device else host

  companion object {
    const val VIA_HOST = "host"
    const val VIA_DEVICE = "device"

    /** Embedded apps own network policy; absent a host handler, both routes use the same client. */
    fun forEmbedded(
      device: PrototypeHttpClient,
      hostHandler: PrototypeHttpClient? = null,
    ): PrototypeHttpClients = PrototypeHttpClients(host = hostHandler ?: device, device = device)

    /** Why a saved prototype cannot send `via: "host"`: it runs without a host connection. */
    const val SAVED_HOST_UNAVAILABLE_MESSAGE =
      "Requests via \"host\" are not available in saved prototypes, which run without a host " +
        "connection. Use via \"device\" instead."

    /**
     * The transports of a saved prototype (#12970): `device` sends on the device with no host, as
     * in a shown prototype, while `host` fails with an explicit, actionable error rather than a
     * misleading `network` one.
     */
    fun forSavedPrototype(device: PrototypeHttpClient): PrototypeHttpClients =
      PrototypeHttpClients(
        host = { _ ->
          PrototypeRequestResponse.Failed(
            PrototypeRequestError(
              PrototypeRequestErrorCode.INVALID_REQUEST,
              SAVED_HOST_UNAVAILABLE_MESSAGE,
            ),
          )
        },
        device = device,
      )

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

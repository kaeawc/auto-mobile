package dev.jasonpearson.automobile.prototype

import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeHttpClients
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeHttpRequest as InternalPrototypeHttpRequest
import dev.jasonpearson.automobile.protocol.PrototypeRequestResponse
import kotlinx.serialization.json.JsonElement

/**
 * A resolved HTTP request. Query parameters are already merged into [url].
 *
 * @property requestId Identifier linking this call to its outcome event.
 * @property prototypeId Identifier of the prototype issuing the request.
 * @property method HTTP method.
 * @property url Absolute URL, including resolved query parameters.
 * @property headers Resolved request headers.
 * @property body Optional JSON body.
 * @property timeoutMs Effective timeout in milliseconds.
 */
class PrototypeHttpRequest internal constructor(request: InternalPrototypeHttpRequest) {
  val requestId: String = request.requestId
  val prototypeId: String = request.prototypeId
  val method: String = request.method
  val url: String = request.url
  val headers: Map<String, String> = request.headers
  val body: JsonElement? = request.body
  val timeoutMs: Int = request.timeoutMs
}

/** An app-owned transport; the renderer adds no HTTP stack or network policy. */
fun interface PrototypeHttpClient {
  /**
   * Called on the main thread; implementations must switch dispatchers for blocking work. Return a
   * typed response for every failure; propagate coroutine cancellation.
   */
  suspend fun execute(request: PrototypeHttpRequest): PrototypeRequestResponse
}

/**
 * Embedded routing: [hostHandler] handles `via: "host"`, otherwise [device] handles both routes.
 * Without [device], every request fails with the typed `network` error, even with a host handler.
 * Clients must cooperate with coroutine cancellation and enforce their own egress policy. Instances
 * have identity semantics: replacing this object reloads the runtime. Creating a network with
 * inline client lambdas on each recomposition recreates the runtime each time; callers should
 * remember the network and its clients.
 *
 * @property device The app's device transport, or null to disable all requests.
 * @property hostHandler Optional override for host requests (including omitted `via`).
 */
class PrototypeNetwork(
  val device: PrototypeHttpClient? = null,
  val hostHandler: PrototypeHttpClient? = null,
) {
  internal fun clients(): PrototypeHttpClients {
    val transport = device ?: return PrototypeHttpClients.Unavailable
    return PrototypeHttpClients.forEmbedded(transport.adapt(), hostHandler?.adapt())
  }
}

private fun PrototypeHttpClient.adapt() =
  dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeHttpClient { request ->
    execute(PrototypeHttpRequest(request))
  }

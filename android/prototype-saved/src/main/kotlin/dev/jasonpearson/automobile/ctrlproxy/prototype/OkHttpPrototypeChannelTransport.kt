package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.util.Log
import dev.jasonpearson.automobile.protocol.PrototypeChannelLimits
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator
import java.io.InterruptedIOException
import java.net.ConnectException
import java.net.Proxy
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import okhttp3.ConnectionPool
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import okio.ByteString

/**
 * The `via: "device"` channel transport (#14269): OkHttp's WebSocket and okhttp-sse, from the
 * device itself, under the same egress policy as [RetrofitPrototypeHttpClient] (no proxy, the
 * policy DNS, and the egress interceptor on the upgrade request). Redirects are not followed: a
 * redirect answer is `handshake_failed` with its status. A WebSocket pings every 25 s; binary
 * frames are not delivered. A frame or event larger than [maxFrameBytes] closes the connection with
 * `too_large`, as the host relay does.
 */
class OkHttpPrototypeChannelTransport(
  client: OkHttpClient,
  private val policy: PrototypeDestinationPolicy = PrototypeEgressPolicy(),
  private val maxFrameBytes: Int = PrototypeChannelLimits.maxFrameBytes,
  /** Unexpected failures; a seam so JVM tests need no `android.util.Log`. */
  private val warn: (String, Throwable) -> Unit = { message, error -> Log.w(TAG, message, error) },
  /** The most a connection may take to open; the request default. */
  handshakeTimeoutMs: Long = HANDSHAKE_TIMEOUT_MS,
) : PrototypeChannelTransport {
  private val base: OkHttpClient =
    client
      .newBuilder()
      .followRedirects(false)
      .followSslRedirects(false)
      .retryOnConnectionFailure(false)
      // Direct connections keep the checked DNS address and the destination socket aligned.
      .proxy(Proxy.NO_PROXY)
      .connectionPool(ConnectionPool())
      .addNetworkInterceptor(PrototypeEgressInterceptor(policy))
      .pingInterval(PING_INTERVAL_MS, TimeUnit.MILLISECONDS)
      .connectTimeout(handshakeTimeoutMs, TimeUnit.MILLISECONDS)
      .writeTimeout(handshakeTimeoutMs, TimeUnit.MILLISECONDS)
      // A stream is open-ended; the ping (WebSocket) or the server (SSE) ends a dead one. The call
      // timeout bounds only the handshake: OkHttp exits it once the WebSocket upgrades or the SSE
      // response opens.
      .readTimeout(0, TimeUnit.MILLISECONDS)
      .callTimeout(handshakeTimeoutMs, TimeUnit.MILLISECONDS)
      .build()

  override fun open(
    request: PrototypeChannelOpenRequest,
    listener: PrototypeChannelListener,
  ): PrototypeChannelConnection {
    val once = OnceListener(listener)
    val http =
      try {
        build(request)
      } catch (error: IllegalArgumentException) {
        // A URL or header OkHttp refuses to put on the wire.
        return refused(once, PrototypeChannelError.INVALID_REQUEST, error.message ?: "Invalid")
      }
    val decision = policy.check(http.url.host, http.url.port, emptyList())
    if (decision is PrototypeEgressDecision.Blocked) {
      return refused(once, PrototypeChannelError.BLOCKED_DESTINATION, decision.reason)
    }
    val client = base.newBuilder().dns(PrototypePolicyDns(base.dns, policy, http.url.port)).build()
    return when (request.kind) {
      PrototypeChannelKind.WEBSOCKET -> openWebSocket(client, http, once)
      PrototypeChannelKind.SSE -> openEventSource(client, http, once)
    }
  }

  private fun build(request: PrototypeChannelOpenRequest): Request =
    Request.Builder()
      .url(request.url)
      .apply {
        request.headers.forEach { (name, value) -> header(name, value) }
        if (request.protocols.isNotEmpty()) {
          header("Sec-WebSocket-Protocol", request.protocols.joinToString(", "))
        }
        if (request.kind == PrototypeChannelKind.SSE) {
          header("Accept", "text/event-stream")
          request.lastEventId?.let { header("Last-Event-ID", it) }
        }
      }
      .build()

  private fun refused(
    listener: OnceListener,
    code: String,
    message: String,
  ): PrototypeChannelConnection {
    listener.closed(null, null, PrototypeChannelError(code, message))
    return object : PrototypeChannelConnection {
      override fun send(data: String) = false

      override fun close(code: Int, reason: String) = Unit
    }
  }

  private fun tooBig(data: String) = data.toByteArray(Charsets.UTF_8).size > maxFrameBytes

  private fun tooLarge() =
    PrototypeChannelError(
      PrototypeChannelError.TOO_LARGE,
      "A frame is limited to $maxFrameBytes bytes",
    )

  private fun openWebSocket(
    client: OkHttpClient,
    request: Request,
    listener: OnceListener,
  ): PrototypeChannelConnection {
    val socket =
      client.newWebSocket(
        request,
        object : WebSocketListener() {
          override fun onOpen(webSocket: WebSocket, response: Response) =
            listener.opened(response.header("Sec-WebSocket-Protocol"))

          override fun onMessage(webSocket: WebSocket, text: String) {
            if (!tooBig(text)) return listener.frame(text, null, null)
            webSocket.close(MESSAGE_TOO_BIG, null)
            listener.closed(MESSAGE_TOO_BIG, null, tooLarge())
          }

          override fun onMessage(webSocket: WebSocket, bytes: ByteString) = Unit

          override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(code, null)
            listener.closed(code, reason, null)
          }

          override fun onClosed(webSocket: WebSocket, code: Int, reason: String) =
            listener.closed(code, reason, null)

          override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) =
            listener.closed(null, null, failure(request, t, response, listener.isOpen))
        },
      )
    return object : PrototypeChannelConnection {
      override fun send(data: String): Boolean = !listener.isDone && socket.send(data)

      override fun close(code: Int, reason: String) {
        if (listener.finish() && !socket.close(code, reason.ifEmpty { null })) socket.cancel()
      }
    }
  }

  private fun openEventSource(
    client: OkHttpClient,
    request: Request,
    listener: OnceListener,
  ): PrototypeChannelConnection {
    val source =
      EventSources.createFactory(client)
        .newEventSource(
          request,
          object : EventSourceListener() {
            override fun onOpen(eventSource: EventSource, response: Response) =
              listener.opened(null)

            override fun onEvent(
              eventSource: EventSource,
              id: String?,
              type: String?,
              data: String,
            ) {
              if (!tooBig(data)) return listener.frame(data, type, id)
              eventSource.cancel()
              listener.closed(null, null, tooLarge())
            }

            override fun onClosed(eventSource: EventSource) = listener.closed(null, null, null)

            override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) =
              listener.closed(null, null, failure(request, t, response, listener.isOpen))
          },
        )
    return object : PrototypeChannelConnection {
      override fun send(data: String) = false

      override fun close(code: Int, reason: String) {
        if (listener.finish()) source.cancel()
      }
    }
  }

  private fun failure(
    request: Request,
    error: Throwable?,
    response: Response?,
    opened: Boolean,
  ): PrototypeChannelError {
    if (!opened && response != null) {
      return PrototypeChannelError(
        PrototypeChannelError.HANDSHAKE_FAILED,
        "The server answered ${response.code} instead of opening the channel",
        response.code,
      )
    }
    return when (error) {
      is PrototypeBlockedDestinationException ->
        PrototypeChannelError(PrototypeChannelError.BLOCKED_DESTINATION, error.message)
      is ConnectException ->
        PrototypeChannelError("connection_refused", "Connection refused: ${request.url}")
      is InterruptedIOException ->
        PrototypeChannelError(
          "timeout",
          "The channel timed out." + localNetworkHint(request.url.host),
        )
      else -> {
        error?.let { warn("Prototype channel failed: ${it.message}", it) }
        PrototypeChannelError(
          PrototypeChannelError.NETWORK,
          (error?.message ?: "The channel failed") + localNetworkHint(request.url.host),
        )
      }
    }
  }

  /** On API 37 a local-network address needs `ACCESS_LOCAL_NETWORK` (#13018). */
  private fun localNetworkHint(host: String): String =
    if (RetrofitPrototypeHttpClient.isLocalNetworkHost(host)) {
      " $host is a local-network address: on Android 17+ grant CtrlProxy " +
        "android.permission.ACCESS_LOCAL_NETWORK."
    } else ""

  /** Reports one close at most, and nothing after the controller closed the connection. */
  private class OnceListener(private val delegate: PrototypeChannelListener) {
    private val done = AtomicBoolean(false)
    @Volatile
    var isOpen = false
      private set

    val isDone: Boolean
      get() = done.get()

    fun opened(protocol: String?) {
      if (done.get()) return
      isOpen = true
      delegate.onOpen(protocol)
    }

    fun frame(data: String, event: String?, id: String?) {
      if (!done.get()) delegate.onFrame(data, event, id)
    }

    fun closed(code: Int?, reason: String?, error: PrototypeChannelError?) {
      if (done.compareAndSet(false, true)) delegate.onClosed(code, reason, error)
    }

    /** The controller closed it: true the first time, and no callback follows. */
    fun finish(): Boolean = done.compareAndSet(false, true)
  }

  companion object {
    private const val TAG = "PrototypeChannel"
    const val PING_INTERVAL_MS = 25_000L
    private const val MESSAGE_TOO_BIG = 1009
    val HANDSHAKE_TIMEOUT_MS = PrototypeSpecValidator.DEFAULT_PROTOTYPE_REQUEST_TIMEOUT_MS.toLong()
  }
}

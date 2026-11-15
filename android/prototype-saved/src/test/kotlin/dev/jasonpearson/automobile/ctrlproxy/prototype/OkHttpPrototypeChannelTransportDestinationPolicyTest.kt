package dev.jasonpearson.automobile.ctrlproxy.prototype

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.net.Socket
import java.net.SocketAddress
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import javax.net.SocketFactory
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.Dns
import okhttp3.OkHttpClient
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Destination policy and DNS validation for the `via: "device"` channel transport, mirroring
 * [RetrofitPrototypeHttpClientDestinationPolicyTest] for the WebSocket upgrade and the SSE stream.
 */
class OkHttpPrototypeChannelTransportDestinationPolicyTest {
  private val server = MockWebServer()
  private val loopback = InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1))

  private class Recorder : PrototypeChannelListener {
    val opened = LinkedBlockingQueue<String>()
    val closed = LinkedBlockingQueue<PrototypeChannelError>()

    override fun onOpen(protocol: String?) {
      opened += protocol.orEmpty()
    }

    override fun onFrame(data: String, event: String?, id: String?) = Unit

    override fun onClosed(code: Int?, reason: String?, error: PrototypeChannelError?) {
      closed += error ?: PrototypeChannelError("none", "closed without an error")
    }

    fun error(): PrototypeChannelError =
      checkNotNull(closed.poll(5, TimeUnit.SECONDS)) { "No close callback" }
  }

  @Before
  fun start() {
    server.start()
  }

  @After
  fun stop() {
    server.close()
  }

  private fun transport(client: OkHttpClient, policy: PrototypeDestinationPolicy) =
    OkHttpPrototypeChannelTransport(client, policy, warn = { _, _ -> })

  private fun request(kind: PrototypeChannelKind, url: String) =
    PrototypeChannelOpenRequest("c1", "proto", "chat", kind, url)

  @Test
  fun `production default refuses blocked destinations before any I O`() {
    val noDns = OkHttpClient.Builder().dns(Dns { error("Unexpected DNS lookup") }).build()
    val production = transport(noDns, PrototypeEgressPolicy())
    val hosts =
      listOf(
        "127.0.0.1",
        "2130706433",
        "0x7f.1",
        "0177.0.0.1",
        "localhost",
        "LOCALHOST.",
        "[::1]",
        "[::ffff:a9fe:a9fe]",
      )
    for (host in hosts) {
      for ((kind, scheme) in
        listOf(PrototypeChannelKind.WEBSOCKET to "ws", PrototypeChannelKind.SSE to "http")) {
        val recorder = Recorder()
        production.open(request(kind, "$scheme://$host/chat"), recorder)
        assertEquals(
          "$scheme://$host",
          PrototypeChannelError.BLOCKED_DESTINATION,
          recorder.error().code,
        )
      }
    }
  }

  @Test
  fun `a mixed DNS answer is blocked_destination with no connection`() {
    var lookups = 0
    val dns = Dns {
      lookups++
      listOf(InetAddress.getByAddress(byteArrayOf(8, 8, 8, 8)), loopback)
    }
    val recorder = Recorder()
    transport(OkHttpClient.Builder().dns(dns).build(), PrototypeEgressPolicy())
      .open(request(PrototypeChannelKind.WEBSOCKET, "ws://public.test:${server.port}/"), recorder)
    assertEquals(PrototypeChannelError.BLOCKED_DESTINATION, recorder.error().code)
    assertEquals(1, lookups)
    assertEquals(0, server.requestCount)
  }

  @Test
  fun `a failed upgrade is not retried on another validated address`() {
    var connections = 0
    val sockets =
      object : SocketFactory() {
        override fun createSocket(): Socket =
          object : Socket() {
            override fun connect(endpoint: SocketAddress, timeout: Int) {
              connections++
            }

            override fun getInputStream() = ByteArrayInputStream(byteArrayOf())

            override fun getOutputStream() = ByteArrayOutputStream()
          }

        override fun createSocket(host: String, port: Int): Socket = error("Unused overload")

        override fun createSocket(
          host: String,
          port: Int,
          local: InetAddress,
          localPort: Int,
        ): Socket = error("Unused overload")

        override fun createSocket(host: InetAddress, port: Int): Socket = error("Unused overload")

        override fun createSocket(
          host: InetAddress,
          port: Int,
          local: InetAddress,
          localPort: Int,
        ): Socket = error("Unused overload")
      }
    val client =
      OkHttpClient.Builder()
        .retryOnConnectionFailure(true)
        .socketFactory(sockets)
        .dns(
          Dns {
            listOf(
              InetAddress.getByAddress(byteArrayOf(8, 8, 8, 8)),
              InetAddress.getByAddress(byteArrayOf(8, 8, 4, 4)),
            )
          },
        )
        .build()
    val recorder = Recorder()
    transport(client, PrototypeEgressPolicy())
      .open(request(PrototypeChannelKind.WEBSOCKET, "ws://public.test/"), recorder)
    assertEquals(PrototypeChannelError.NETWORK, recorder.error().code)
    assertEquals(1, connections)
  }

  @Test
  fun `the upgrade uses the validated DNS list without a second lookup`() {
    var lookups = 0
    val dns = Dns { if (lookups++ == 0) listOf(loopback) else error("Unexpected second lookup") }
    val checked = mutableListOf<InetAddress>()
    val policy = PrototypeDestinationPolicy { _, _, addresses ->
      checked += addresses
      PrototypeEgressDecision.Allow
    }
    server.enqueue(
      MockResponse.Builder()
        .webSocketUpgrade(
          object : WebSocketListener() {
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
              webSocket.close(code, null)
            }
          },
        )
        .build(),
    )
    val recorder = Recorder()
    val connection =
      transport(OkHttpClient.Builder().dns(dns).build(), policy)
        .open(request(PrototypeChannelKind.WEBSOCKET, "ws://public.test:${server.port}/"), recorder)
    checkNotNull(recorder.opened.poll(5, TimeUnit.SECONDS)) { "The upgrade did not open" }
    connection.close(NORMAL_CLOSURE, "")
    assertEquals(1, lookups)
    assertTrue(loopback in checked)
    assertEquals(
      "public.test:${server.port}",
      checkNotNull(server.takeRequest(2, TimeUnit.SECONDS)).headers["Host"],
    )
  }

  private companion object {
    const val NORMAL_CLOSURE = 1000
  }
}

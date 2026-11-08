package dev.jasonpearson.automobile.ctrlproxy.baselineprofile

import androidx.benchmark.macro.MacrobenchmarkScope
import androidx.benchmark.macro.junit4.BaselineProfileRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.jasonpearson.automobile.protocol.RequestHierarchy
import dev.jasonpearson.automobile.protocol.RequestSwipe
import dev.jasonpearson.automobile.protocol.RequestTapCoordinates
import dev.jasonpearson.automobile.protocol.WebSocketRequest
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Records CtrlProxy's startup and hot paths: launcher activity startup, accessibility service
 * binding, the WebSocket server, hierarchy extraction, and gesture dispatch.
 *
 * Run `./gradlew :control-proxy:generateBaselineProfile` with one device or emulator connected (API
 * 33+, or rooted API 28+). The test enables CtrlProxy's accessibility service through the shell,
 * then drives the server the way the MCP daemon does over the forwarded port.
 */
@RunWith(AndroidJUnit4::class)
class CtrlProxyBaselineProfileGenerator {
  @get:Rule val rule = BaselineProfileRule()

  @Test
  fun generate() =
    rule.collect(packageName = PACKAGE_NAME, includeInStartupProfile = true) {
      pressHome()
      startActivityAndWait()
      enableAccessibilityService()
      exerciseWebSocketServer()
    }

  private fun MacrobenchmarkScope.enableAccessibilityService() {
    device.executeShellCommand("settings put secure enabled_accessibility_services $SERVICE")
    device.executeShellCommand("settings put secure accessibility_enabled 1")
  }

  private fun MacrobenchmarkScope.exerciseWebSocketServer() {
    val width = device.displayWidth.toDouble()
    val height = device.displayHeight.toDouble()
    val requests =
      listOf(
        RequestHierarchy(requestId = "bp-hierarchy"),
        RequestTapCoordinates(requestId = "bp-tap", x = width / 2, y = height / 2),
        RequestSwipe(
          requestId = "bp-swipe",
          x1 = width / 2,
          y1 = height * SWIPE_START,
          x2 = width / 2,
          y2 = height * SWIPE_END,
        ),
        RequestHierarchy(requestId = "bp-hierarchy-after-gestures"),
      )
    val client = OkHttpClient.Builder().readTimeout(0, TimeUnit.MILLISECONDS).build()
    try {
      val socket = connectWithRetry(client)
      requests.forEach { request ->
        socket.send(json.encodeToString(WebSocketRequest.serializer(), request))
        val reply = socket.awaitReply(request.requestId.orEmpty())
        assertTrue("No reply to ${request.requestId}", reply)
      }
      socket.close(NORMAL_CLOSURE, null)
    } finally {
      client.dispatcher.executorService.shutdown()
      client.connectionPool.evictAll()
    }
  }

  /** The accessibility service starts the server asynchronously after it binds. */
  private fun connectWithRetry(client: OkHttpClient): RecordingSocket {
    val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(CONNECT_TIMEOUT_MS)
    while (System.nanoTime() < deadline) {
      val socket = RecordingSocket()
      socket.webSocket = client.newWebSocket(Request.Builder().url(SERVER_URL).build(), socket)
      if (socket.awaitOpen()) return socket
      Thread.sleep(CONNECT_RETRY_MS)
    }
    throw AssertionError("CtrlProxy WebSocket server did not accept $SERVER_URL")
  }

  private class RecordingSocket : WebSocketListener() {
    lateinit var webSocket: WebSocket
    private val events = LinkedBlockingQueue<String>()

    override fun onOpen(webSocket: WebSocket, response: Response) {
      events.put(OPENED)
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
      events.put(text)
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
      events.put(FAILED)
    }

    fun awaitOpen(): Boolean = events.poll(OPEN_TIMEOUT_MS, TimeUnit.MILLISECONDS) == OPENED

    fun send(text: String) {
      webSocket.send(text)
    }

    fun close(code: Int, reason: String?) {
      webSocket.close(code, reason)
    }

    /** Waits for any message that echoes [requestId]; broadcasts in between are skipped. */
    fun awaitReply(requestId: String): Boolean {
      val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(REPLY_TIMEOUT_MS)
      while (true) {
        val remaining = deadline - System.nanoTime()
        if (remaining <= 0) return false
        val event = events.poll(remaining, TimeUnit.NANOSECONDS) ?: return false
        if (event == FAILED) return false
        if (event.contains("\"$requestId\"")) return true
      }
    }
  }

  private companion object {
    const val PACKAGE_NAME = "dev.jasonpearson.automobile.ctrlproxy"
    const val SERVICE = "$PACKAGE_NAME/$PACKAGE_NAME.CtrlProxy"
    const val SERVER_URL = "ws://127.0.0.1:8765/ws"
    const val OPENED = "\u0000opened"
    const val FAILED = "\u0000failed"
    const val NORMAL_CLOSURE = 1000
    const val CONNECT_TIMEOUT_MS = 30_000L
    const val CONNECT_RETRY_MS = 500L
    const val OPEN_TIMEOUT_MS = 2_000L
    const val REPLY_TIMEOUT_MS = 10_000L
    const val SWIPE_START = 0.7
    const val SWIPE_END = 0.3
    val json = Json { encodeDefaults = false }
  }
}

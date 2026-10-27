package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.HighlightShape
import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.websocket.DefaultClientWebSocketSession
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.client.plugins.websocket.webSocket
import io.ktor.client.request.get
import io.ktor.http.HttpMethod
import io.ktor.websocket.Frame
import io.ktor.websocket.readText
import java.util.concurrent.Executors
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before

/** Shared real-socket setup, bounded waits, and originating-client error exchange. */
internal abstract class WebSocketServerIntegrationTestFixtures {
  private val workerDispatcher = Executors.newSingleThreadExecutor().asCoroutineDispatcher()

  protected lateinit var server: WebSocketServer
  protected lateinit var testScope: CoroutineScope
  protected val json = Json { ignoreUnknownKeys = true }

  @Before
  fun setUp() {
    testScope = CoroutineScope(workerDispatcher + SupervisorJob())
    // Use port 0 to let OS assign an available port, avoiding conflicts when tests run in parallel
    server =
      WebSocketServer(
        port = 0,
        scope = testScope,
        options =
          WebSocketServerOptions(
            sdkInt = { GestureDisplayRouting.DISPLAY_API },
            messageHandler =
              CtrlProxyMessageHandler(
                object : NoOpCtrlProxyActions() {
                  override suspend fun addHighlight(
                    requestId: String?,
                    highlightId: String?,
                    shape: HighlightShape?,
                  ) {
                    val error =
                      when {
                        highlightId.isNullOrBlank() -> "Missing highlight id"
                        shape == null -> "Missing highlight shape"
                        shape.type != "circle" -> "Only hand-drawn circle highlights are supported"
                        else -> null
                      }
                    enqueueHighlightResponse(requestId, error == null, error)
                  }
                },
              ),
          ),
      )
  }

  /** Get the actual port the server is listening on. Must be called after server.start(). */
  protected suspend fun getServerPort(): Int {
    return server.getActualPort() ?: error("Server not running or port not available")
  }

  @After
  fun tearDown() {
    if (server.isRunning()) {
      server.stop()
    }
    testScope.cancel()
    workerDispatcher.close()
  }

  /**
   * Wait for a condition to be true with exponential backoff. Much faster than fixed delays when
   * condition becomes true quickly.
   */
  protected suspend fun waitFor(
    timeoutMs: Long = 1000,
    checkIntervalMs: Long = 10,
    condition: () -> Boolean,
  ) {
    withTimeout(timeoutMs) {
      while (!condition()) {
        delay(checkIntervalMs)
      }
    }
  }

  protected suspend fun startAndWait(target: WebSocketServer) {
    target.start()
    // The first test in this class pays the cold Ktor CIO + connector-resolve cost on a
    // background start job; on a loaded CI runner that alone can exceed 1s. The server's own
    // budget is 2s per connector resolve plus retry backoff, so use a ceiling above it. This
    // returns as soon as the server is running, so it costs nothing on the happy path.
    waitFor(timeoutMs = SERVER_START_TIMEOUT_MS) { target.isRunning() }
  }

  protected suspend fun awaitClientsRegistered(target: WebSocketServer, count: Int) {
    waitFor(timeoutMs = CLIENT_REGISTRATION_TIMEOUT_MS) { target.getConnectionCount() == count }
  }

  private fun enqueueHighlightResponse(
    requestId: String?,
    success: Boolean,
    error: String?,
  ) {
    val errorJson = json.encodeToString<String?>(error)
    val message = buildString {
      append("""{"type":"highlight_response","timestamp":${System.currentTimeMillis()}""")
      if (requestId != null) {
        append(""","requestId":"$requestId"""")
      }
      append(""","success":$success""")
      append(""","error":$errorJson""")
      append("}")
    }

    testScope.launch { server.broadcast(message) }
  }

  protected suspend fun assertErrorTargetsOrigin(
    target: WebSocketServer,
    command: String,
    requestId: String,
  ) = coroutineScope {
    val exchange = OriginErrorExchange(target, command)
    exchange.run()
    assertEquals(
      "originating client should receive one error frame",
      1,
      exchange.ownerMessages.size,
    )
    val ownerJson = json.parseToJsonElement(exchange.ownerMessages.single()).jsonObject
    assertEquals("error", ownerJson["type"]?.jsonPrimitive?.content)
    assertEquals(requestId, ownerJson["requestId"]?.jsonPrimitive?.content)
    assertEquals(
      "unrelated client should receive only the liveness probe, not another connection's error",
      listOf("""{"type":"probe"}"""),
      exchange.bystanderMessages.toList(),
    )
  }

  private inner class OriginErrorExchange(
    private val target: WebSocketServer,
    private val command: String,
  ) {
    val ownerMessages: MutableList<String> =
      java.util.Collections.synchronizedList(mutableListOf<String>())
    val bystanderMessages: MutableList<String> =
      java.util.Collections.synchronizedList(mutableListOf<String>())
    private val ownerReady = CompletableDeferred<Unit>()
    private val bystanderReady = CompletableDeferred<Unit>()
    private val sendOwnerMessage = CompletableDeferred<Unit>()
    private val bystanderCheckedErrorWindow = CompletableDeferred<Unit>()
    private val sendProbeBroadcast = CompletableDeferred<Unit>()

    suspend fun run() = coroutineScope {
      val ownerClient = HttpClient(CIO) { install(WebSockets) }
      val bystanderClient = HttpClient(CIO) { install(WebSockets) }
      ownerClient.use { owner ->
        bystanderClient.use { bystander ->
          val ownerJob = launch {
            owner.webSocket(
              method = HttpMethod.Get,
              host = "localhost",
              port = target.getActualPort() ?: error("Server not running"),
              path = "/ws",
            ) {
              readOwner()
            }
          }
          val bystanderJob = launch {
            bystander.webSocket(
              method = HttpMethod.Get,
              host = "localhost",
              port = target.getActualPort() ?: error("Server not running"),
              path = "/ws",
            ) {
              readBystander()
            }
          }
          ownerReady.await()
          bystanderReady.await()
          awaitClientsRegistered(target, 2)
          sendOwnerMessage.complete(Unit)
          ownerJob.join()
          bystanderCheckedErrorWindow.await()
          target.broadcast("""{"type":"probe"}""")
          sendProbeBroadcast.complete(Unit)
          bystanderJob.join()
        }
      }
    }

    private suspend fun DefaultClientWebSocketSession.readOwner() {
      incoming.receive() // Connection message
      ownerReady.complete(Unit)
      sendOwnerMessage.await()
      send(Frame.Text(command))
      val responseFrame = withTimeout(FRAME_TIMEOUT_MS) { incoming.receive() } as Frame.Text
      ownerMessages.add(responseFrame.readText())
    }

    private suspend fun DefaultClientWebSocketSession.readBystander() {
      incoming.receive() // Connection message
      bystanderReady.complete(Unit)
      sendOwnerMessage.await()
      val responseFrame = withTimeoutOrNull(250) { incoming.receive() }
      if (responseFrame is Frame.Text) {
        bystanderMessages.add(responseFrame.readText())
      }
      bystanderCheckedErrorWindow.complete(Unit)
      sendProbeBroadcast.await()
      val probeFrame = withTimeout(FRAME_TIMEOUT_MS) { incoming.receive() } as Frame.Text
      bystanderMessages.add(probeFrame.readText())
    }
  }

  companion object {
    const val SERVER_START_TIMEOUT_MS = 10_000L

    /** The greeting precedes registration; receiving it alone does not make a broadcast safe. */
    const val CLIENT_REGISTRATION_TIMEOUT_MS = 5_000L

    /** Real socket delivery may take over a second on a loaded runner. */
    const val FRAME_TIMEOUT_MS = 5_000L
  }
}

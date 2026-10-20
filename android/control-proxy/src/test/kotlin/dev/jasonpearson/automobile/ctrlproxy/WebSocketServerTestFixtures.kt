package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.WebSocketMessageHandler
import dev.jasonpearson.automobile.protocol.WebSocketRequest
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import io.ktor.websocket.CloseReason
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.TestScope
import org.junit.After
import org.junit.Before

/** Shared server lifecycle and deterministic client transports. */
internal abstract class WebSocketServerTestFixtures {
  protected lateinit var server: WebSocketServer
  protected lateinit var testScope: TestScope

  @Before
  fun setUp() {
    testScope = TestScope()
    // Use port 0 to let OS assign an available port, avoiding conflicts when tests run in parallel
    server = WebSocketServer(port = 0, scope = testScope)
  }

  @After
  fun tearDown() {
    if (server.isRunning()) {
      server.stop()
    }
    testScope.cancel()
  }

  protected class StalledTransport : WebSocketServer.ClientTransport {
    var closeReason: CloseReason? = null
    val messages = mutableListOf<String>()
    private val released = CompletableDeferred<Unit>()

    override suspend fun send(message: String) {
      released.await()
      messages.add(message)
    }

    fun unblock() {
      released.complete(Unit)
    }

    override suspend fun close(reason: CloseReason) {
      closeReason = reason
    }
  }

  protected class RecordingTransport : WebSocketServer.ClientTransport {
    val messages = mutableListOf<String>()

    override suspend fun send(message: String) {
      messages.add(message)
    }

    override suspend fun close(reason: CloseReason) = Unit
  }

  protected fun serverWithHandler(
    handle: suspend (WebSocketRequest) -> WebSocketResponse?,
  ): WebSocketServer =
    WebSocketServer(
      port = 0,
      scope = testScope,
      options =
        WebSocketServerOptions(
          messageHandler =
            object : WebSocketMessageHandler {
              override suspend fun handleMessage(request: WebSocketRequest): WebSocketResponse? =
                handle(request)
            },
        ),
    )
}

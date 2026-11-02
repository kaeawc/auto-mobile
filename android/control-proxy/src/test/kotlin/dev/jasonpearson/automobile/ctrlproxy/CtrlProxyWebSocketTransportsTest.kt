package dev.jasonpearson.automobile.ctrlproxy

import io.ktor.websocket.CloseReason
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.android.controller.ServiceController
import org.robolectric.annotation.Config

/** The WebSocket transports report the server's state, never just its existence. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class CtrlProxyWebSocketTransportsTest {
  private val controller: ServiceController<CtrlProxy> =
    Robolectric.buildService(CtrlProxy::class.java).create()
  private val service: CtrlProxy = controller.get()
  private val serverScope = TestScope()

  @After
  fun tearDown() {
    service.webSocketServerOrNull?.takeIf { it.isRunning() }?.stop()
    controller.destroy()
    serverScope.cancel()
  }

  private fun runningFlags() =
    listOf(
      service.isWebSocketRunning(),
      service.hierarchyExtractTransport().isRunning(),
      service.guardedResultTransport().isRunning(),
      service.deviceEventTransport().isRunning(),
      service.prototypeResultTransport().isRunning(),
    )

  @Test
  fun `nothing is running before the server is created`() {
    assertEquals(List(5) { false }, runningFlags())
    assertEquals(0, service.webSocketConnectionCount())
    assertEquals(0, service.webSocketObserverGeneration())
  }

  @Test
  fun `a created but unstarted server is not running and has no clients`() {
    service.webSocketServer = WebSocketServer(port = 0, scope = serverScope)

    assertEquals(List(5) { false }, runningFlags())
    assertEquals(0, service.guardedResultTransport().connectionCount())
    assertEquals(0, service.deviceEventTransport().connectionCount())
    assertFalse(service.webSocketServerOrNull!!.isRunning())
    assertEquals(0, service.webSocketConnectionCount())
    assertEquals(
      "the generation is read from the server",
      service.webSocketServer.observerSessionGeneration(),
      service.webSocketObserverGeneration(),
    )
  }

  @Test
  fun `a started server is running for every transport`() =
    runTest(serverScope.testScheduler) {
      service.webSocketServer = WebSocketServer(port = 0, scope = serverScope)
      service.webSocketServer.start()
      runCurrent()

      assertEquals(List(5) { true }, runningFlags())
      assertEquals(0, service.deviceEventTransport().connectionCount())
    }

  @Test
  fun `client count and observer generation are read from the server`() {
    service.webSocketServer = WebSocketServer(port = 0, scope = serverScope)
    service.webSocketServer.registerClient(1, SilentTransport)

    assertEquals(1, service.webSocketConnectionCount())
    assertEquals(1, service.webSocketObserverGeneration())
  }

  private object SilentTransport : WebSocketServer.ClientTransport {
    override suspend fun send(message: String) = Unit

    override suspend fun close(reason: CloseReason) = Unit
  }
}

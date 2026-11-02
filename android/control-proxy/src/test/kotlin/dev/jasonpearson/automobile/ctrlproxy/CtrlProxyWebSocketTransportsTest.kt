package dev.jasonpearson.automobile.ctrlproxy

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.UnconfinedTestDispatcher
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
  private val serverScope = CoroutineScope(SupervisorJob() + UnconfinedTestDispatcher())

  @After
  fun tearDown() {
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
  }

  @Test
  fun `a created but unstarted server is not running and has no clients`() {
    service.webSocketServer = WebSocketServer(scope = serverScope)

    assertEquals(List(5) { false }, runningFlags())
    assertEquals(0, service.guardedResultTransport().connectionCount())
    assertEquals(0, service.deviceEventTransport().connectionCount())
    assertFalse(service.webSocketServerOrNull!!.isRunning())
  }
}

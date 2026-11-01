package dev.jasonpearson.automobile.ctrlproxy

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

class ClientSessionRouterTest {
  /**
   * The service's per-client state, logging each release in order. Launched work is held until
   * [runLaunched], so a test can tell what ran inline from what went to the service scope.
   */
  private class FakeService : ClientSessionRouter.Host<String> {
    val calls = mutableListOf<String>()
    private val launched = mutableListOf<suspend () -> Unit>()

    override fun dropQueuedCommands(client: String) {
      calls += "queue:$client"
    }

    override fun cancelGestureStreams(client: String) {
      calls += "gestures:$client"
    }

    override fun failHostRequests(client: String?) {
      calls += "host-requests:$client"
    }

    override fun launch(block: suspend () -> Unit) {
      calls += "launch"
      launched += block
    }

    override suspend fun prototypeClientCountChanged(count: Int, observerSession: Int) {
      calls += "prototype-count:$count@$observerSession"
    }

    override suspend fun prototypeClientConnected() {
      calls += "prototype-connected"
    }

    suspend fun runLaunched() {
      val pending = launched.toList()
      launched.clear()
      pending.forEach { it() }
    }
  }

  private val service = FakeService()
  private val router = ClientSessionRouter(service)

  @Test
  fun `a disconnect releases only that client's queue, gestures and host requests`() {
    router.onClientDisconnected("c1")

    assertEquals(listOf("queue:c1", "gestures:c1", "host-requests:c1"), service.calls)
  }

  @Test
  fun `the last client leaving fails every host request before the prototype hears`() = runTest {
    router.onClientCountChanged(count = 0, observerSession = 4)
    service.runLaunched()

    assertEquals(
      listOf("host-requests:null", "launch", "prototype-count:0@4"),
      service.calls,
    )
  }

  @Test
  fun `a count change with clients left keeps the host requests`() = runTest {
    router.onClientCountChanged(count = 2, observerSession = 5)
    service.runLaunched()

    assertEquals(listOf("launch", "prototype-count:2@5"), service.calls)
  }

  @Test
  fun `a connect tells the prototype off the socket thread`() = runTest {
    router.onClientConnected()

    assertEquals("nothing runs inline", listOf("launch"), service.calls)
    service.runLaunched()
    assertEquals(listOf("launch", "prototype-connected"), service.calls)
  }
}

package dev.jasonpearson.automobile.ctrlproxy

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

class DisplayTransitionRelayTest {
  /**
   * A service whose prototype controller and WebSocket server can each be absent, logging what a
   * transition reached. Launched work is held until [runLaunched].
   */
  private class FakeService : DisplayTransitionRelay.Host {
    var prototypeReady = true
    var serverRunning = true
    val calls = mutableListOf<String>()
    private val launched = mutableListOf<suspend () -> Unit>()

    override fun launch(block: suspend () -> Unit) {
      calls += "launch"
      launched += block
    }

    override fun isPrototypeReady() = prototypeReady

    override suspend fun prototypeDisplayTransition(displayId: Int, removed: Boolean) {
      calls += "prototype:$displayId:removed=$removed"
    }

    override fun isServerRunning() = serverRunning

    override suspend fun broadcast(frame: String) {
      // The frame's own format is covered by ResultFramesGoldenTest; drop its wall-clock stamp.
      calls += "broadcast:${frame.replace(TIMESTAMP, "")}"
    }

    suspend fun runLaunched() {
      val pending = launched.toList()
      launched.clear()
      pending.forEach { it() }
    }
  }

  private companion object {
    val TIMESTAMP = Regex(""""timestamp":\d+,""")
  }

  private val service = FakeService()
  private val relay = DisplayTransitionRelay(service)

  private fun transition(change: String, displayId: Int = 2) =
    DisplayTransition(change, displayId, "panel", 1080, 2400, 2, rotation = 0)

  @Test
  fun `a transition reaches the prototype before the frame goes out`() = runTest {
    val changed = transition("changed")

    relay.onTransition(changed)
    assertEquals("nothing runs on the display thread", listOf("launch"), service.calls)
    service.runLaunched()

    assertEquals(
      listOf(
        "launch",
        "prototype:2:removed=false",
        "broadcast:${displayTransitionFrame(changed).replace(TIMESTAMP, "")}",
      ),
      service.calls,
    )
  }

  @Test
  fun `only a removed display tells the prototype it is gone`() = runTest {
    relay.onTransition(transition("added", displayId = 3))
    relay.onTransition(transition("removed", displayId = 3))
    service.runLaunched()

    assertEquals(
      listOf("prototype:3:removed=false", "prototype:3:removed=true"),
      service.calls.filter { it.startsWith("prototype") },
    )
  }

  @Test
  fun `a missing prototype or server skips only its own step`() = runTest {
    service.prototypeReady = false
    relay.onTransition(transition("changed"))
    service.runLaunched()
    assertEquals(listOf("launch", "broadcast"), service.calls.map { it.substringBefore(':') })

    service.calls.clear()
    service.prototypeReady = true
    service.serverRunning = false
    relay.onTransition(transition("changed"))
    service.runLaunched()
    assertEquals(listOf("launch", "prototype:2:removed=false"), service.calls)
  }
}

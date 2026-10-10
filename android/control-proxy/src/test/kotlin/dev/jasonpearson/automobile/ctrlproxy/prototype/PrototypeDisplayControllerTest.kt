package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeEvent
import dev.jasonpearson.automobile.protocol.PrototypeEventKind
import dev.jasonpearson.automobile.protocol.PrototypeFullscreenPlacement
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.PrototypeTextNode
import dev.jasonpearson.automobile.protocol.PrototypeWindow
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Display targeting decisions, driven by a fake display provider and the fake host. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class PrototypeDisplayControllerTest {
  private class Results {
    val all = mutableListOf<Pair<Boolean, String?>>()
    val last
      get() = all.last()
  }

  private val host = FakePrototypeHost()
  private val events = mutableListOf<PrototypeEvent>()
  private val results = Results()
  private val connected = mutableSetOf<Int>()
  private val controller =
    PrototypeController(
      host,
      PrototypeResultSink { _, success, error -> results.all += success to error },
      eventSink = PrototypeEventSink { events += it },
      clock = { 42L },
      lifecycle = PrototypeLifecycle(FakePrototypeTimer()),
      displays = PrototypeDisplayProvider { it in connected },
    )

  private fun spec(id: String = "panel") =
    PrototypeSpec(
      id,
      PrototypeWindow(PrototypeFullscreenPlacement()),
      root = PrototypeTextNode(text = "x"),
    )

  private fun assertTeardown() {
    val event = events.last()
    assertEquals(PrototypeEventKind.DISMISSED, event.kind)
    assertEquals(Json.parseToJsonElement("""{"reason":"teardown"}"""), event.payload)
  }

  @Test
  fun `absent display shows on the default display without consulting the provider`() = runTest {
    controller.show("r", spec())
    assertEquals(true to null, results.last)
    assertEquals(0, host.requests.single().displayId)
  }

  @Test
  fun `explicit display is carried to the host`() = runTest {
    connected += 2
    controller.show("r", spec(), displayId = 2)
    assertEquals(true to null, results.last)
    assertEquals(2, host.requests.single().displayId)
  }

  @Test
  fun `explicit default display needs no provider entry`() = runTest {
    controller.show("r", spec(), displayId = 0)
    assertEquals(true to null, results.last)
    assertEquals(0, host.requests.single().displayId)
  }

  @Test
  fun `unknown display is an error reply and no window`() = runTest {
    controller.show("r", spec(), displayId = 9)
    assertFalse(results.last.first)
    assertEquals("Unknown or disconnected display: 9", results.last.second)
    assertTrue(host.calls.isEmpty())
    assertFalse(controller.isShowing)
    assertTrue(events.isEmpty())
  }

  @Test
  fun `unknown display leaves the prototype already shown in place`() = runTest {
    controller.show("a", spec("first"))
    controller.show("b", spec("second"), displayId = 9)
    assertFalse(results.last.first)
    assertEquals(listOf("show"), host.calls)
    assertEquals("first", controller.activeRuntime?.current?.spec?.id)
    assertTrue(controller.isShowing)
  }

  @Test
  fun `a same-id show stays on the display the prototype was shown on`() = runTest {
    connected += 2
    controller.show("a", spec(), displayId = 2)
    controller.show("b", spec())
    controller.show("c", spec(), displayId = 9) // Ignored in place, so never refused.
    assertEquals(true to null, results.last)
    assertEquals(listOf("show", "replace", "replace"), host.calls)
    assertEquals(listOf(2, 2, 2), host.requests.map { it.displayId })
  }

  @Test
  fun `reset moves a same-id show to the requested display`() = runTest {
    connected += 2
    controller.show("a", spec(), displayId = 2)
    controller.show("b", spec(), reset = true)
    assertEquals(true to null, results.last)
    assertEquals(listOf(2, 0), host.requests.map { it.displayId })
  }

  @Test
  fun `showing another id on another display replaces on that display`() = runTest {
    connected += 2
    controller.show("a", spec())
    controller.show("b", spec("other"), displayId = 2)
    assertEquals(listOf("show", "replace"), host.calls)
    assertEquals(listOf(0, 2), host.requests.map { it.displayId })
  }

  @Test
  fun `removal of the prototype's display dismisses it as teardown`() = runTest {
    connected += 2
    controller.show("a", spec(), displayId = 2)
    connected -= 2
    controller.onDisplayTransition(2, removed = true)
    assertFalse(controller.isShowing)
    assertNull(controller.activeRuntime)
    assertEquals(listOf("show", "dismiss"), host.calls)
    assertTeardown()
    assertEquals(1, events.size)
  }

  @Test
  fun `removal reaches the prototype even when the callback reports the display as present`() =
    runTest {
      connected += 2
      controller.show("a", spec(), displayId = 2)
      connected -= 2
      controller.onConfigurationChanged()
      assertNull(controller.activeRuntime)
      assertTeardown()
      // It never revives, and never moves to the default display, when the panel comes back.
      connected += 2
      controller.onConfigurationChanged()
      controller.onDisplayTransition(2, removed = false)
      assertEquals(listOf("show", "dismiss"), host.calls)
      assertFalse(controller.isShowing)
    }

  @Test
  fun `a lost window on a listed display that cannot take one is abandoned not left windowless`() =
    runTest {
      connected += 2
      controller.show("a", spec(), displayId = 2)
      host.isShowing = false // The platform detached it and the host cleared it.
      host.failure = IllegalArgumentException("Unknown or disconnected display: 2")
      controller.onDisplayTransition(2, removed = false)
      assertNull(controller.activeRuntime)
      assertFalse(controller.isShowing)
      assertTeardown()
      assertEquals(1, events.size)
      assertEquals(listOf("show", "show"), host.calls)
    }

  @Test
  fun `another display's transition does not touch the prototype`() = runTest {
    connected += 2
    controller.show("a", spec(), displayId = 2)
    controller.onDisplayTransition(3, removed = true)
    controller.onDisplayTransition(0, removed = true)
    assertTrue(controller.isShowing)
    assertEquals(listOf("show"), host.calls)
    assertTrue(events.isEmpty())
  }

  @Test
  fun `a change on the prototype's own display relayouts`() = runTest {
    connected += 2
    controller.show("a", spec(), displayId = 2)
    controller.onDisplayTransition(2, removed = false)
    assertEquals(listOf("show", "relayout"), host.calls)
    assertTrue(controller.isShowing)
  }

  @Test
  fun `default display removal still tears down a default display prototype`() = runTest {
    controller.show("a", spec())
    controller.onDisplayTransition(0, removed = true)
    assertNull(controller.activeRuntime)
    assertTeardown()
  }
}

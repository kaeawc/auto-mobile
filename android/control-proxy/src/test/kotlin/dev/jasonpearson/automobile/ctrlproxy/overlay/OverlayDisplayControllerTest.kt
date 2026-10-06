package dev.jasonpearson.automobile.ctrlproxy.overlay

import dev.jasonpearson.automobile.protocol.OverlayEvent
import dev.jasonpearson.automobile.protocol.OverlayEventKind
import dev.jasonpearson.automobile.protocol.OverlayFullscreenPlacement
import dev.jasonpearson.automobile.protocol.OverlaySpec
import dev.jasonpearson.automobile.protocol.OverlayTextNode
import dev.jasonpearson.automobile.protocol.OverlayWindow
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
class OverlayDisplayControllerTest {
  private class Results {
    val all = mutableListOf<Pair<Boolean, String?>>()
    val last
      get() = all.last()
  }

  private val host = FakeInteractiveOverlayHost()
  private val events = mutableListOf<OverlayEvent>()
  private val results = Results()
  private val connected = mutableSetOf<Int>()
  private val controller =
    OverlayController(
      host,
      OverlayResultSink { _, success, error -> results.all += success to error },
      eventSink = OverlayEventSink { events += it },
      clock = { 42L },
      lifecycle = OverlayLifecycle(FakeOverlayTimer()),
      displays = OverlayDisplayProvider { it in connected },
    )

  private fun spec(id: String = "panel") =
    OverlaySpec(id, OverlayWindow(OverlayFullscreenPlacement()), root = OverlayTextNode(text = "x"))

  private fun assertTeardown() {
    val event = events.last()
    assertEquals(OverlayEventKind.DISMISSED, event.kind)
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
  fun `unknown display leaves the overlay already shown in place`() = runTest {
    controller.show("a", spec("first"))
    controller.show("b", spec("second"), displayId = 9)
    assertFalse(results.last.first)
    assertEquals(listOf("show"), host.calls)
    assertEquals("first", controller.activeRuntime?.current?.spec?.id)
    assertTrue(controller.isShowing)
  }

  @Test
  fun `replacement spec update stays on the display the overlay was shown on`() = runTest {
    connected += 2
    controller.show("a", spec(), displayId = 2)
    controller.update("b", "panel", spec(), null)
    assertEquals(true to null, results.last)
    assertEquals(listOf("show", "replace"), host.calls)
    assertEquals(listOf(2, 2), host.requests.map { it.displayId })
  }

  @Test
  fun `showing again on another display replaces on that display`() = runTest {
    connected += 2
    controller.show("a", spec())
    controller.show("b", spec(), displayId = 2)
    assertEquals(listOf("show", "replace"), host.calls)
    assertEquals(listOf(0, 2), host.requests.map { it.displayId })
  }

  @Test
  fun `removal of the overlay's display dismisses it as teardown`() = runTest {
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
  fun `removal reaches the overlay even when the callback reports the display as present`() =
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
  fun `another display's transition does not touch the overlay`() = runTest {
    connected += 2
    controller.show("a", spec(), displayId = 2)
    controller.onDisplayTransition(3, removed = true)
    controller.onDisplayTransition(0, removed = true)
    assertTrue(controller.isShowing)
    assertEquals(listOf("show"), host.calls)
    assertTrue(events.isEmpty())
  }

  @Test
  fun `a change on the overlay's own display relayouts`() = runTest {
    connected += 2
    controller.show("a", spec(), displayId = 2)
    controller.onDisplayTransition(2, removed = false)
    assertEquals(listOf("show", "relayout"), host.calls)
    assertTrue(controller.isShowing)
  }

  @Test
  fun `default display removal still tears down a default display overlay`() = runTest {
    controller.show("a", spec())
    controller.onDisplayTransition(0, removed = true)
    assertNull(controller.activeRuntime)
    assertTeardown()
  }
}

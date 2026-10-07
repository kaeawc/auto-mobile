package dev.jasonpearson.automobile.ctrlproxy.overlay

import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** `window.persistence` (#10494) and `window.layer` (#10496) on the overlay controller. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class OverlayWindowOptionsTest {
  private val host = FakeInteractiveOverlayHost()
  private val timer = FakeOverlayTimer()
  private val events = mutableListOf<OverlayEvent>()
  private val results = mutableListOf<Pair<Boolean, String?>>()
  private var clients = 1
  private var assetClears = 0
  private var appLayerPermitted = true
  private val controller =
    OverlayController(
      host,
      OverlayResultSink { _, success, error -> results += success to error },
      eventSink = OverlayEventSink { events += it },
      clock = { timer.now },
      lifecycle = OverlayLifecycle(timer, TTL, clientCount = { clients }),
      clearAssets = { assetClears++ },
      appLayerPermitted = { appLayerPermitted },
      packageName = "test.ctrlproxy",
    )

  private fun spec(
    persistence: String? = null,
    layer: String? = null,
    placement: dev.jasonpearson.automobile.protocol.OverlayPlacement = OverlayFullscreenPlacement(),
  ) =
    OverlaySpec(
      "proto",
      OverlayWindow(placement, layer = layer, persistence = persistence),
      state = mapOf("label" to OverlayScalar.Text("start")),
      root = OverlayPagerNode("pager", children = List(2) { OverlayTextNode(text = "screen") }),
    )

  private suspend fun interact(interaction: OverlayInteraction) =
    controller.interact(checkNotNull(controller.activeRuntime), interaction)

  private fun lastDismissReason(): String? =
    events.lastOrNull { it.kind == OverlayEventKind.DISMISSED }?.payload?.toString()

  @Test
  fun `device persistence survives the last client leaving and idle time and keeps its assets`() =
    runTest {
      controller.show(null, spec(persistence = "device"))
      assertTrue(timer.tasks.none { !it.cancelled })
      clients = 0
      controller.onClientCountChanged(0)
      timer.advance(TTL * 100)
      assertTrue(host.isShowing)
      assertNotNull(controller.activeRuntime)
      assertTrue(events.none { it.kind == OverlayEventKind.DISMISSED })
      assertEquals(0, assetClears)
      assertTrue(host.requests.last().persistent)
    }

  @Test
  fun `offline actions still apply to a device persistent overlay`() = runTest {
    controller.show(null, spec(persistence = "device"))
    clients = 0
    controller.onClientCountChanged(0)
    interact(OverlayInteraction.Tap(listOf(OverlaySetPageAction("pager", OverlayPageTarget.Next))))
    interact(
      OverlayInteraction.Tap(listOf(OverlaySetStateAction("label", OverlayScalar.Text("typed"))))
    )
    val current = checkNotNull(controller.activeRuntime).current
    assertEquals(1, current.pages["pager"])
    assertEquals(OverlayScalar.Text("typed"), current.spec.state?.get("label"))
    assertTrue(timer.tasks.none { !it.cancelled })
  }

  @Test
  fun `a device persistent show queued after the last client left is kept`() = runTest {
    clients = 0
    controller.show(null, spec(persistence = "device"))
    assertTrue(host.isShowing)
    assertTrue(events.isEmpty())
  }

  @Test
  fun `a persisted overlay still goes away through its close control and an explicit dismiss`() =
    runTest {
      controller.show(null, spec(persistence = "device"))
      clients = 0
      controller.onClientCountChanged(0)
      host.requests.last().onHostDismiss()
      assertFalse(host.isShowing)
      // With no host attached the terminal event waits for the next one to connect.
      assertNull(lastDismissReason())
      clients = 1
      controller.onClientConnected()
      assertEquals("""{"reason":"user"}""", lastDismissReason())
      assertEquals(1, assetClears)

      clients = 1
      controller.show(null, spec(persistence = "device"))
      controller.dismiss(null, "proto", null)
      assertFalse(host.isShowing)
      assertEquals("""{"reason":"agent"}""", lastDismissReason())
      assertEquals(2, assetClears)
    }

  @Test
  fun `session persistence keeps the disconnect and idle behaviour`() = runTest {
    for (persistence in listOf(null, "session")) {
      events.clear()
      controller.show(null, spec(persistence = persistence))
      assertFalse(host.requests.last().persistent)
      controller.onClientCountChanged(0)
      assertFalse(host.isShowing)
      assertEquals("""{"reason":"disconnect"}""", lastDismissReason())
    }
    controller.show(null, spec(persistence = "session"))
    timer.advance(TTL)
    assertEquals("""{"reason":"ttl"}""", lastDismissReason())
  }

  @Test
  fun `updating a persisted overlay to session scope restores the disconnect dismissal`() =
    runTest {
      controller.show(null, spec(persistence = "device"))
      controller.update(null, "proto", spec(persistence = "session"), null)
      controller.onClientCountChanged(0)
      assertFalse(host.isShowing)
      assertEquals("""{"reason":"disconnect"}""", lastDismissReason())
    }

  @Test
  fun `app layer needs the overlay permission and a refusal replaces nothing`() = runTest {
    controller.show(null, spec())
    appLayerPermitted = false
    controller.show(null, spec(layer = "app"))
    val (success, error) = results.last()
    assertFalse(success)
    assertEquals(
      "window.layer: app needs Android 8.0+ and SYSTEM_ALERT_WINDOW for test.ctrlproxy, which " +
        "is not granted. Grant it with `adb shell appops set test.ctrlproxy SYSTEM_ALERT_WINDOW " +
        "allow`, or omit window.layer to use the system layer.",
      error,
    )
    assertEquals(1, host.requests.size)
    assertEquals(OverlayWindowLayer.SYSTEM, host.requests.single().layer)

    appLayerPermitted = true
    controller.show(null, spec(layer = "app"))
    assertTrue(results.last().first)
    assertEquals(OverlayWindowLayer.APP, host.requests.last().layer)
  }

  @Test
  fun `system and absent layers never consult the overlay permission`() = runTest {
    appLayerPermitted = false
    controller.show(null, spec(layer = "system"))
    controller.show(null, spec())
    assertTrue(results.all { it.first })
    assertTrue(host.requests.all { it.layer == OverlayWindowLayer.SYSTEM })
  }

  @Test
  fun `persistent non-fullscreen overlays carry an opaque close control`() {
    val floating = OverlayFloatingPlacement("center", OverlayOffset(0.0, 0.0))
    val session = spec(placement = floating).let { it.copy(window = it.window.copy(opacity = 40)) }
    val sessionChrome = overlayHostChrome(mapOverlaySpec(session).request())
    assertFalse(sessionChrome.closeVisible)
    assertEquals(0.4f, sessionChrome.windowAlpha, 0f)

    val persisted = session.copy(window = session.window.copy(persistence = "device"))
    val chrome = overlayHostChrome(mapOverlaySpec(persisted).request())
    assertTrue(chrome.closeVisible)
    assertFalse(chrome.dismissVisible)
    assertEquals(1f, chrome.windowAlpha, 0f)
    assertEquals(0.4f, chrome.contentAlpha, 0f)

    // Fullscreen already has its dismiss row; no second control.
    val fullscreen = overlayHostChrome(mapOverlaySpec(spec(persistence = "device")).request())
    assertTrue(fullscreen.dismissVisible)
    assertFalse(fullscreen.closeVisible)
  }

  @Test
  fun `window options map from the wire with absent values keeping today's behaviour`() {
    assertEquals(OverlayWindowLayer.SYSTEM, OverlayWindowLayer.fromWire(null))
    assertEquals(OverlayWindowLayer.SYSTEM, OverlayWindowLayer.fromWire("system"))
    assertEquals(OverlayWindowLayer.APP, OverlayWindowLayer.fromWire("app"))
    assertFalse(isDevicePersistent(spec()))
    assertFalse(isDevicePersistent(spec(persistence = "session")))
    assertTrue(isDevicePersistent(spec(persistence = "device")))
    val request = mapOverlaySpec(spec(persistence = "device", layer = "app")).request()
    assertEquals(OverlayWindowLayer.APP, request.layer)
    assertTrue(request.persistent)
  }

  companion object {
    private const val TTL = 10L

    @JvmStatic
    @org.junit.BeforeClass
    fun warm() {
      runTest {}
      OverlaySpecValidator.validate("{}")
      mapOverlaySpec(
        OverlaySpec("warm", OverlayWindow(OverlayFullscreenPlacement()), root = OverlaySpacerNode())
      )
    }
  }
}

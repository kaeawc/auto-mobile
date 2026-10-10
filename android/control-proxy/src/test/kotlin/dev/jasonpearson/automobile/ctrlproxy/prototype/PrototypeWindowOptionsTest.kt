package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** `window.persistence` (#10494) and `window.layer` (#10496) on the prototype controller. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class PrototypeWindowOptionsTest {
  private val host = FakePrototypeHost()
  private val timer = FakePrototypeTimer()
  private val events = mutableListOf<PrototypeEvent>()
  private val results = mutableListOf<Pair<Boolean, String?>>()
  private var clients = 1
  private var assetClears = 0
  private var appLayerPermitted = true
  private val controller =
    PrototypeController(
      host,
      PrototypeResultSink { _, success, error -> results += success to error },
      eventSink = PrototypeEventSink { events += it },
      clock = { timer.now },
      lifecycle = PrototypeLifecycle(timer, TTL, clientCount = { clients }),
      clearAssets = { assetClears++ },
      appLayerPermitted = { appLayerPermitted },
      packageName = "test.ctrlproxy",
    )

  private fun spec(
    persistence: String? = null,
    layer: String? = null,
    placement: dev.jasonpearson.automobile.protocol.PrototypePlacement =
      PrototypeFullscreenPlacement(),
  ) =
    PrototypeSpec(
      "proto",
      PrototypeWindow(placement, layer = layer, persistence = persistence),
      state = mapOf("label" to PrototypeScalar.Text("start")),
      root = PrototypePagerNode("pager", children = List(2) { PrototypeTextNode(text = "screen") }),
    )

  private suspend fun interact(interaction: PrototypeInteraction) =
    controller.interact(checkNotNull(controller.activeRuntime), interaction)

  private fun lastDismissReason(): String? =
    events.lastOrNull { it.kind == PrototypeEventKind.DISMISSED }?.payload?.toString()

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
      assertTrue(events.none { it.kind == PrototypeEventKind.DISMISSED })
      assertEquals(0, assetClears)
      assertTrue(host.requests.last().persistent)
    }

  @Test
  fun `the controller reports an app-layer prototype only while one is showing`() = runTest {
    assertFalse(controller.isAppLayerShowing)
    controller.show(null, spec(layer = "app"))
    assertTrue(controller.isAppLayerShowing)
    controller.show(null, spec(layer = "system"))
    assertFalse(controller.isAppLayerShowing)
    controller.show(null, spec(layer = "app"))
    controller.dismiss(null, "proto", null)
    assertFalse(controller.isAppLayerShowing)
  }

  @Test
  fun `offline actions still apply to a device persistent prototype`() = runTest {
    controller.show(null, spec(persistence = "device"))
    clients = 0
    controller.onClientCountChanged(0)
    interact(
      PrototypeInteraction.Tap(listOf(PrototypeSetPageAction("pager", PrototypePageTarget.Next))),
    )
    interact(
      PrototypeInteraction.Tap(
        listOf(PrototypeSetStateAction("label", PrototypeScalar.Text("typed"))),
      ),
    )
    val current = checkNotNull(controller.activeRuntime).current
    assertEquals(1, current.pages["pager"])
    assertEquals(PrototypeScalar.Text("typed"), current.spec.state?.get("label"))
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
  fun `a persisted prototype still goes away through its close control and an explicit dismiss`() =
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
  fun `re-showing a persisted prototype with session scope restores the disconnect dismissal`() =
    runTest {
      controller.show(null, spec(persistence = "device"))
      controller.show(null, spec(persistence = "session"))
      controller.onClientCountChanged(0)
      assertFalse(host.isShowing)
      assertEquals("""{"reason":"disconnect"}""", lastDismissReason())
    }

  @Test
  fun `app layer needs the prototype permission and a refusal replaces nothing`() = runTest {
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
    assertEquals(PrototypeWindowLayer.SYSTEM, host.requests.single().layer)

    appLayerPermitted = true
    controller.show(null, spec(layer = "app"))
    assertTrue(results.last().first)
    assertEquals(PrototypeWindowLayer.APP, host.requests.last().layer)
  }

  @Test
  fun `system and absent layers never consult the prototype permission`() = runTest {
    appLayerPermitted = false
    controller.show(null, spec(layer = "system"))
    controller.show(null, spec())
    assertTrue(results.all { it.first })
    assertTrue(host.requests.all { it.layer == PrototypeWindowLayer.SYSTEM })
  }

  @Test
  fun `persistent non-fullscreen prototypes carry an opaque close control`() {
    val floating = PrototypeFloatingPlacement("center", PrototypeOffset(0.0, 0.0))
    val session = spec(placement = floating).let { it.copy(window = it.window.copy(opacity = 40)) }
    val sessionChrome = prototypeHostChrome(mapPrototypeSpec(session).request())
    assertFalse(sessionChrome.closeVisible)
    assertEquals(0.4f, sessionChrome.windowAlpha, 0f)

    val persisted = session.copy(window = session.window.copy(persistence = "device"))
    val chrome = prototypeHostChrome(mapPrototypeSpec(persisted).request())
    assertTrue(chrome.closeVisible)
    assertFalse(chrome.dismissVisible)
    assertEquals(1f, chrome.windowAlpha, 0f)
    assertEquals(0.4f, chrome.contentAlpha, 0f)

    // Fullscreen already has its dismiss row; no second control.
    val fullscreen = prototypeHostChrome(mapPrototypeSpec(spec(persistence = "device")).request())
    assertTrue(fullscreen.dismissVisible)
    assertFalse(fullscreen.closeVisible)
  }

  @Test
  fun `window options map from the wire with absent values keeping today's behaviour`() {
    assertEquals(PrototypeWindowLayer.SYSTEM, PrototypeWindowLayer.fromWire(null))
    assertEquals(PrototypeWindowLayer.SYSTEM, PrototypeWindowLayer.fromWire("system"))
    assertEquals(PrototypeWindowLayer.APP, PrototypeWindowLayer.fromWire("app"))
    assertFalse(isDevicePersistent(spec()))
    assertFalse(isDevicePersistent(spec(persistence = "session")))
    assertTrue(isDevicePersistent(spec(persistence = "device")))
    val request = mapPrototypeSpec(spec(persistence = "device", layer = "app")).request()
    assertEquals(PrototypeWindowLayer.APP, request.layer)
    assertTrue(request.persistent)
  }

  companion object {
    private const val TTL = 10L

    @JvmStatic
    @org.junit.BeforeClass
    fun warm() {
      runTest {}
      PrototypeSpecValidator.validate("{}")
      mapPrototypeSpec(
        PrototypeSpec(
          "warm",
          PrototypeWindow(PrototypeFullscreenPlacement()),
          root = PrototypeSpacerNode(),
        ),
      )
    }
  }
}

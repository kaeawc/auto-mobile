package dev.jasonpearson.automobile.ctrlproxy.overlay

import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class OverlayLifecycleTest {
  private val host = FakeInteractiveOverlayHost()
  private val timer = FakeOverlayTimer()
  private val events = mutableListOf<OverlayEvent>()
  private var blocked = false
  private var session = 1
  private val lifecycle =
    OverlayLifecycle(timer, TTL, isBlocked = { blocked }, observerSession = { session })
  private val controller =
    OverlayController(
      host,
      OverlayResultSink { _, success, error -> check(success) { error.orEmpty() } },
      eventSink = OverlayEventSink { events += it },
      clock = { timer.now },
      lifecycle = lifecycle,
    )

  private fun spec(id: String = "panel") =
    OverlaySpec(
      id,
      OverlayWindow(OverlayFullscreenPlacement()),
      root = OverlayPagerNode("pager", children = List(4) { OverlayTextNode(text = "page") }),
    )

  private suspend fun show(id: String = "panel") = controller.show(null, spec(id))

  private suspend fun interact(interaction: OverlayInteraction) =
    controller.interact(checkNotNull(controller.activeRuntime), interaction)

  private fun assertDismiss(reason: String, sequence: Long = 1L) {
    val event = events.last()
    assertEquals(OverlayEventKind.DISMISSED, event.kind)
    assertNull(event.name)
    assertEquals(Json.parseToJsonElement("""{"reason":"$reason"}"""), event.payload)
    assertEquals(sequence, event.sequence)
  }

  @Test
  fun `host and spec dismiss are user agent dismiss is agent and each is terminal`() = runTest {
    for (trigger in listOf("host", "spec", "agent")) {
      show()
      val runtime = checkNotNull(controller.activeRuntime)
      val before = events.size
      when (trigger) {
        "host" -> host.requests.last().onHostDismiss()
        "spec" -> interact(OverlayInteraction.Tap(listOf(OverlayDismissAction)))
        else -> controller.dismiss(null, "panel", null)
      }
      assertDismiss(if (trigger == "agent") "agent" else "user", (before + 1).toLong())
      controller.interact(runtime, OverlayInteraction.HostDismiss)
      runtime.dismiss(OverlayDismissReason.DISCONNECT)
      timer.advance(TTL)
      assertEquals(before + 1, events.size)
      assertTrue(timer.tasks.last().cancelled)
    }
  }

  @Test
  fun `last client disconnect dismisses once with next sequence but remaining clients do not`() =
    runTest {
      show()
      interact(OverlayInteraction.SettledPage("pager", 2))
      controller.onClientCountChanged(2)
      controller.onClientCountChanged(1)
      assertTrue(host.isShowing)
      assertEquals(1, events.size)
      controller.onClientCountChanged(0)
      controller.onClientCountChanged(0)
      controller.destroy()
      assertEquals(2, events.size)
      assertDismiss("disconnect", 2L)
      assertFalse(host.isShowing)
    }

  @Test
  fun `delayed last-client event cannot dismiss overlay shown by a new observer session`() =
    runTest {
      show()
      session++
      show()
      controller.onClientCountChanged(0, observerSession = 1)
      assertTrue(host.isShowing)
      assertTrue(events.isEmpty())
      controller.onClientCountChanged(0, observerSession = session)
      assertDismiss("disconnect")
    }

  @Test
  fun `ttl arms on show restarts on interaction and state patch then expires exactly once`() =
    runTest {
      show()
      assertEquals(TTL, timer.tasks.single().deadline)
      timer.advance(TTL - 1)
      interact(
        OverlayInteraction.Tap(listOf(OverlaySetStateAction("label", OverlayScalar.Text("new"))))
      )
      assertTrue(timer.tasks.first().cancelled)
      timer.advance(TTL - 1)
      controller.update(null, "panel", null, mapOf("label" to OverlayScalar.Text("patch")))
      timer.advance(TTL - 1)
      assertTrue(host.isShowing)
      timer.advance(1)
      assertDismiss("ttl")
      assertEquals(OverlayScalar.Text("patch"), events.single().state["label"])
      timer.advance(TTL)
      controller.onClientCountChanged(0)
      assertEquals(1, events.size)
    }

  @Test
  fun `initial and restored settled pager reports neither extend ttl nor emit but swipes are activity`() =
    runTest {
      show()
      val task = timer.tasks.single()
      interact(OverlayInteraction.PagerMotion("pager", 0, false))
      controller.onConfigurationChanged()
      interact(OverlayInteraction.PagerMotion("pager", 0, false))
      assertSame(task, timer.tasks.single())
      assertTrue(events.isEmpty())
      timer.advance(TTL - 1)
      interact(OverlayInteraction.PagerMotion("pager", 0, true))
      assertTrue(task.cancelled)
      timer.advance(1)
      assertTrue(host.isShowing)
      timer.advance(TTL - 1)
      assertDismiss("ttl")
    }

  @Test
  fun `replace cancels old timer emits nothing and stale queued callbacks cannot dismiss new runtime`() =
    runTest {
      show()
      val old = timer.tasks.single()
      val runtime = checkNotNull(controller.activeRuntime)
      timer.advance(TTL - 1)
      show()
      assertTrue(old.cancelled)
      assertFalse(runtime.current.active)
      old.action()
      timer.advance(1)
      assertTrue(events.isEmpty())
      assertTrue(host.isShowing)
      timer.advance(TTL - 1)
      assertDismiss("ttl")
      assertEquals(1, events.size)
    }

  @Test
  fun `same-runtime stale expiry is invalid after activity and ttl override is positive and restartable`() =
    runTest {
      show()
      val old = timer.tasks.single()
      controller.setIdleTtlMillis(TTL * 2)
      old.action()
      timer.advance(TTL)
      assertTrue(events.isEmpty())
      val error = runCatching { controller.setIdleTtlMillis(0) }.exceptionOrNull()
      assertTrue(error is IllegalArgumentException)
      timer.advance(TTL)
      assertDismiss("ttl")
    }

  @Test
  fun `teardown succeeds with next sequence and repeated teardown or late triggers emit nothing`() =
    runTest {
      show()
      val runtime = checkNotNull(controller.activeRuntime)
      interact(OverlayInteraction.SettledPage("pager", 2))
      controller.destroy()
      assertDismiss("teardown", 2L)
      controller.destroy()
      controller.onClientCountChanged(0)
      runtime.dismiss(OverlayDismissReason.USER)
      timer.advance(TTL)
      assertFalse(host.isShowing)
      assertEquals(2, events.size)
    }

  @Test
  fun `rejected update leaves the idle deadline unchanged`() = runTest {
    val rejecting =
      OverlayController(
        host,
        OverlayResultSink { _, _, _ -> },
        eventSink = OverlayEventSink { events += it },
        lifecycle = lifecycle,
      )
    rejecting.show(null, spec())
    val task = timer.tasks.single()
    rejecting.update(null, "panel", null, mapOf("bad-key" to OverlayScalar.Text("invalid")))
    assertSame(task, timer.tasks.single())
    timer.advance(TTL)
    assertDismiss("ttl")
  }

  @Test
  fun `teardown allocates one terminal sequence even when delivery or window removal fails`() =
    runTest {
      val attempted = mutableListOf<OverlayEvent>()
      val failing =
        OverlayController(
          host,
          OverlayResultSink { _, _, _ -> },
          eventSink =
            OverlayEventSink {
              attempted += it
              error("sink gone")
            },
          lifecycle = OverlayLifecycle(timer, TTL),
        )
      failing.show(null, spec())
      val runtime = checkNotNull(failing.activeRuntime)
      host.accept = false
      failing.destroy()
      failing.destroy()
      runtime.dismiss()
      timer.advance(TTL)
      assertEquals(1, attempted.size)
      assertEquals(1L, attempted.single().sequence)
      assertEquals(Json.parseToJsonElement("""{"reason":"teardown"}"""), attempted.single().payload)
      assertFalse(runtime.current.active)
      assertTrue(timer.tasks.single().cancelled)
    }

  @Test
  fun `configuration changes retain page three state timer and sequence without emitting`() =
    runTest {
      show()
      interact(OverlayInteraction.SettledPage("pager", 2))
      interact(
        OverlayInteraction.Tap(
          listOf(OverlaySetStateAction("label", OverlayScalar.Text("changed")))
        )
      )
      val runtime = checkNotNull(controller.activeRuntime)
      val snapshot = runtime.current
      val task = timer.tasks.last()
      repeat(3) { controller.onConfigurationChanged() }
      assertSame(runtime, controller.activeRuntime)
      assertSame(snapshot, runtime.current)
      assertEquals(2, runtime.current.pages["pager"])
      assertEquals(OverlayScalar.Text("changed"), runtime.current.state["label"])
      assertEquals(3, host.calls.count { it == "relayout" })
      assertSame(task, timer.tasks.last())
      assertEquals(1, events.size)
      controller.dismiss(null, "panel", null)
      assertDismiss("agent", 2L)
    }

  @Test
  fun `missing display dismisses as teardown never migrates and does not revive on return`() =
    runTest {
      show()
      controller.onConfigurationChanged(displayAvailable = false)
      assertDismiss("teardown")
      controller.onConfigurationChanged()
      controller.destroy()
      assertFalse(host.isShowing)
      assertEquals(1, events.size)
      assertEquals(1, host.requests.size)
      assertEquals(OverlayWindowDecision.DISMISS, overlayWindowDecision(false, true))
    }

  @Test
  fun `keyguard hides and restores the same runtime with state and no events while ttl keeps running`() =
    runTest {
      show()
      interact(OverlayInteraction.SettledPage("pager", 2))
      val runtime = checkNotNull(controller.activeRuntime)
      blocked = true
      controller.onConfigurationChanged()
      assertFalse(host.isShowing)
      assertSame(runtime, controller.activeRuntime)
      assertTrue(runtime.current.active)
      blocked = false
      controller.onConfigurationChanged()
      assertTrue(host.isShowing)
      assertSame(runtime, controller.activeRuntime)
      assertEquals(2, runtime.current.pages["pager"])
      assertEquals(1, events.size)
      blocked = true
      controller.onConfigurationChanged()
      timer.advance(TTL)
      blocked = false
      controller.onConfigurationChanged()
      assertFalse(host.isShowing)
      assertDismiss("ttl", 2L)
    }

  @Test
  fun `show while keyguard blocked installs no window and can expire without becoming visible`() =
    runTest {
      blocked = true
      show()
      assertTrue(host.requests.isEmpty())
      assertFalse(host.isShowing)
      assertTrue(checkNotNull(controller.activeRuntime).current.active)
      timer.advance(TTL)
      assertDismiss("ttl")
      blocked = false
      controller.onConfigurationChanged()
      assertTrue(host.requests.isEmpty())
      assertEquals(DEFAULT_OVERLAY_IDLE_TTL_MILLIS, OverlayLifecycle(timer).ttlMillis)
    }

  @Test
  fun `fullscreen host chrome is outside hidden zero-opacity authored modal content`() {
    val malicious =
      spec()
        .copy(
          window = OverlayWindow(OverlayFullscreenPlacement(), 0),
          state = mapOf("open" to OverlayScalar.BooleanValue(true)),
          root =
            OverlayBottomSheetNode(
              child = OverlaySpacerNode(style = OverlayStyle(alpha = 0.0)),
              openWhen = OverlaySheetCondition("open", true),
              detents = listOf(OverlayDetent.Full),
              dragHandle = false,
              dismissOnSwipe = false,
            ),
        )
    val request = mapOverlaySpec(malicious).request()
    val chrome = overlayHostChrome(request)
    assertTrue(chrome.dismissVisible)
    assertEquals(1f, chrome.windowAlpha, 0f)
    assertEquals(0f, chrome.contentAlpha, 0f)
    assertTrue(
      overlayHostChrome(mapOverlaySpec(spec().copy(root = OverlaySpacerNode())).request())
        .dismissVisible
    )
    assertFalse(overlayHostChrome(InteractiveOverlayRequest()).dismissVisible)
  }

  @Test
  fun `failed ttl removal re-arms a bounded retry and then dismisses once as ttl`() = runTest {
    show()
    host.accept = false
    timer.advance(TTL)
    assertTrue(events.isEmpty())
    assertTrue(host.isShowing)
    assertEquals(2, timer.tasks.size)
    assertEquals(timer.now + OVERLAY_DISMISS_RETRY_MILLIS, timer.tasks.last().deadline)
    host.accept = true
    timer.advance(OVERLAY_DISMISS_RETRY_MILLIS)
    assertDismiss("ttl")
    assertEquals(1, events.size)
    assertFalse(host.isShowing)
    timer.advance(OVERLAY_DISMISS_RETRY_MILLIS * 2)
    assertEquals(1, events.size)
  }

  @Test
  fun `ttl retries stop after the bound when removal keeps failing`() = runTest {
    show()
    host.accept = false
    timer.advance(TTL)
    repeat(OVERLAY_DISMISS_MAX_RETRIES + 2) { timer.advance(OVERLAY_DISMISS_RETRY_MILLIS) }
    assertEquals(1 + OVERLAY_DISMISS_MAX_RETRIES, timer.tasks.size)
    assertTrue(events.isEmpty())
    assertTrue(host.isShowing)
  }

  @Test
  fun `failed disconnect removal is retried by the next lifecycle signal exactly once`() = runTest {
    show()
    host.accept = false
    controller.onClientCountChanged(0)
    assertTrue(events.isEmpty())
    assertTrue(host.isShowing)
    host.accept = true
    controller.onConfigurationChanged()
    assertDismiss("disconnect")
    assertEquals(1, events.size)
    assertFalse(host.isShowing)
    controller.onConfigurationChanged()
    controller.onClientCountChanged(0)
    assertEquals(1, events.size)
  }

  @Test
  fun `a show after its disconnect edge dismisses as disconnect instead of waiting for ttl`() =
    runTest {
      var clients = 0
      val gone =
        OverlayController(
          host,
          OverlayResultSink { _, success, error -> check(success) { error.orEmpty() } },
          eventSink = OverlayEventSink { events += it },
          clock = { timer.now },
          lifecycle =
            OverlayLifecycle(timer, TTL, observerSession = { session }, clientCount = { clients }),
        )
      gone.show(null, spec())
      assertDismiss("disconnect")
      assertEquals(1, events.size)
      assertFalse(host.isShowing)
      assertNull(gone.activeRuntime)
      timer.advance(TTL)
      assertEquals(1, events.size)
      clients = 1
      gone.show(null, spec())
      assertTrue(host.isShowing)
      assertEquals(1, events.size)
    }

  companion object {
    private const val TTL = 10L

    @JvmStatic
    @org.junit.BeforeClass
    fun warmLifecycle() {
      runTest {}
      OverlaySpecValidator.validate("{}")
      mapOverlaySpec(
        OverlaySpec("warm", OverlayWindow(OverlayFullscreenPlacement()), root = OverlaySpacerNode())
      )
    }
  }
}

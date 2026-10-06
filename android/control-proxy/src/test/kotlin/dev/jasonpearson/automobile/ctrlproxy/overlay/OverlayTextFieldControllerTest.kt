package dev.jasonpearson.automobile.ctrlproxy.overlay

import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Controller behaviour around a text-field overlay with the fake host: window focusability tracks
 * the visible tree (issue #9874 point 1), authoritative text updates beat stale in-flight edits
 * (point 2), and a state-only update never reports success with no window on screen (point 3).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class OverlayTextFieldControllerTest {
  private val host = FakeInteractiveOverlayHost()
  private val events = mutableListOf<OverlayEvent>()
  private val results = mutableListOf<Pair<Boolean, String?>>()
  private var blocked = false
  private var dismissedCount = 0
  private val controller =
    OverlayController(
      host,
      OverlayResultSink { _, success, error -> results += success to error },
      onDismissed = { dismissedCount++ },
      eventSink = OverlayEventSink { events += it },
      clock = { 42L },
      lifecycle = OverlayLifecycle(FakeOverlayTimer(), isBlocked = { blocked }),
    )

  private val field = OverlayTextFieldNode(stateKey = "query")
  private val pagerWithFieldOnSecondPage =
    OverlayPagerNode("pager", children = listOf(OverlayTextNode(text = "one"), field))
  private val open = mapOf("open" to OverlayScalar.BooleanValue(true))
  private val closed = mapOf("open" to OverlayScalar.BooleanValue(false))

  private fun spec(
    root: OverlayNode,
    state: Map<String, OverlayScalar> = mapOf("query" to OverlayScalar.Text("")),
  ) = OverlaySpec("panel", OverlayWindow(OverlayFullscreenPlacement()), state, root)

  private fun sheetSpec() =
    spec(
      OverlayBoxNode(
        children =
          listOf(
            OverlayTextNode(text = "page"),
            OverlayBottomSheetNode(
              child = field,
              openWhen = OverlaySheetCondition("open", true),
              detents = listOf(OverlayDetent.Full),
            ),
          )
      ),
      closed + ("query" to OverlayScalar.Text("")),
    )

  private fun focusable() = host.requests.last().hasTextField

  private fun flips() = host.calls.filter { it.startsWith("textField:") }

  @Test
  fun `an overlay whose only text field is not visible is not focusable`() = runTest {
    controller.show("show", spec(pagerWithFieldOnSecondPage))
    assertFalse(focusable())
    controller.show(
      "hidden",
      spec(pagerWithFieldOnSecondPage.copy(children = listOf(OverlaySpacerNode()))),
    )
    assertFalse(focusable())
    assertTrue(flips().isEmpty())
  }

  @Test
  fun `swiping to the field's page makes the window focusable and swiping away releases it`() =
    runTest {
      controller.show("show", spec(pagerWithFieldOnSecondPage))
      val runtime = checkNotNull(controller.activeRuntime)
      controller.interact(runtime, OverlayInteraction.SettledPage("pager", 1))
      assertTrue(focusable())
      controller.interact(runtime, OverlayInteraction.SettledPage("pager", 0))
      assertFalse(focusable())
      assertEquals(listOf("textField:true", "textField:false"), flips())
    }

  @Test
  fun `opening a bottom sheet with a field takes focus and closing it gives focus back`() =
    runTest {
      controller.show("show", sheetSpec())
      assertFalse(focusable())
      controller.update("open", "panel", null, open)
      assertTrue(focusable())
      assertEquals(listOf(true to null, true to null), results)
      controller.update("close", "panel", null, closed)
      assertFalse(focusable())
      assertEquals(listOf("textField:true", "textField:false"), flips())
    }

  @Test
  fun `a replacing spec update keeps the page and therefore the focusability`() = runTest {
    controller.show("show", spec(pagerWithFieldOnSecondPage))
    val runtime = checkNotNull(controller.activeRuntime)
    controller.interact(runtime, OverlayInteraction.SettledPage("pager", 1))
    controller.update("replace", "panel", spec(pagerWithFieldOnSecondPage), null)
    assertTrue(focusable())
    assertEquals(listOf(true to null, true to null), results)
  }

  @Test
  fun `a rejected focus flip keeps the old setting and is retried on the next change`() = runTest {
    controller.show("show", sheetSpec())
    host.acceptTextField = false
    controller.update("open", "panel", null, open)
    assertEquals(true to null, results.last()) // Focus is best-effort; the patch itself applied.
    assertFalse(focusable())
    host.acceptTextField = true
    controller.update("again", "panel", null, mapOf("note" to OverlayScalar.Text("x")))
    assertTrue(focusable())
  }

  @Test
  fun `the dismiss path through the host row emits exactly one user event`() = runTest {
    controller.show("show", spec(field))
    val runtime = checkNotNull(controller.activeRuntime)
    // Back on a focusable overlay is delivered as the host's dismiss request (see the host test).
    controller.interact(runtime, OverlayInteraction.HostDismiss)
    controller.interact(runtime, OverlayInteraction.HostDismiss)
    val dismissals = events.filter { it.kind == OverlayEventKind.DISMISSED }
    assertEquals(1, dismissals.size)
    assertEquals(Json.parseToJsonElement("""{"reason":"user"}"""), dismissals.single().payload)
  }

  // --- Point 3: a state-only update must not succeed with nothing on screen ---------------------

  @Test
  fun `a state-only update after the host cleared a detached window restores it before success`() =
    runTest {
      controller.show(
        "show",
        spec(OverlayTextNode(text = "{note}"), mapOf("note" to OverlayScalar.Text("a"))),
      )
      val runtime = checkNotNull(controller.activeRuntime)
      host.isShowing = false // The host cleared the window; recovery has not run yet.
      controller.update("patch", "panel", null, mapOf("note" to OverlayScalar.Text("b")))
      assertEquals(listOf(true to null, true to null), results)
      assertTrue(host.isShowing)
      assertEquals(listOf("show", "show"), host.calls)
      assertSame(runtime, controller.activeRuntime)
      assertEquals(OverlayScalar.Text("b"), runtime.current.state["note"])
      assertTrue(events.isEmpty())
    }

  @Test
  fun `a state-only update that cannot restore the window fails and ends the runtime once`() =
    runTest {
      controller.show(
        "show",
        spec(OverlayTextNode(text = "{note}"), mapOf("note" to OverlayScalar.Text("a"))),
      )
      val runtime = checkNotNull(controller.activeRuntime)
      host.isShowing = false
      host.accept = false
      controller.update("patch", "panel", null, mapOf("note" to OverlayScalar.Text("b")))
      assertFalse(results.last().first)
      assertTrue(results.last().second.orEmpty().contains("could not be restored"))
      assertNull(controller.activeRuntime)
      assertFalse(runtime.current.active)
      val dismissals = events.filter { it.kind == OverlayEventKind.DISMISSED }
      assertEquals(1, dismissals.size)
      assertEquals(
        Json.parseToJsonElement("""{"reason":"teardown"}"""),
        dismissals.single().payload,
      )
      // Later updates fail as an unknown id instead of succeeding against nothing.
      controller.update("late", "panel", null, mapOf("note" to OverlayScalar.Text("c")))
      assertFalse(results.last().first)
    }

  @Test
  fun `a state-only update while the keyguard hides the window succeeds and keeps the state`() =
    runTest {
      controller.show(
        "show",
        spec(OverlayTextNode(text = "{note}"), mapOf("note" to OverlayScalar.Text("a"))),
      )
      val runtime = checkNotNull(controller.activeRuntime)
      host.isShowing = false
      blocked = true
      controller.update("patch", "panel", null, mapOf("note" to OverlayScalar.Text("b")))
      assertEquals(true to null, results.last())
      assertFalse(host.isShowing)
      assertEquals(listOf("show"), host.calls)
      assertSame(runtime, controller.activeRuntime)
      assertEquals(OverlayScalar.Text("b"), runtime.current.state["note"])
      assertTrue(events.isEmpty())
    }

  @Test
  fun `a state-only update on a showing window never touches the host`() = runTest {
    controller.show(
      "show",
      spec(OverlayTextNode(text = "{note}"), mapOf("note" to OverlayScalar.Text("a"))),
    )
    controller.update("patch", "panel", null, mapOf("note" to OverlayScalar.Text("b")))
    assertEquals(listOf("show"), host.calls)
  }

  // --- Point 2: an authoritative external text update beats stale in-flight edits ----------------

  @Test
  fun `an edit rendered before an authoritative update is stale and cannot overwrite it`() =
    runTest {
      controller.show("show", spec(field))
      val runtime = checkNotNull(controller.activeRuntime)
      controller.interact(runtime, OverlayInteraction.TextChange("query", "ab", epoch = 0))
      controller.update("agent", "panel", null, mapOf("query" to OverlayScalar.Text("from agent")))
      // A report typed against the pre-update text (epoch 0) arrives after the update.
      controller.interact(runtime, OverlayInteraction.TextChange("query", "abc", epoch = 0))
      assertEquals(OverlayScalar.Text("from agent"), runtime.current.state["query"])
      // The field re-rendered after the update stamps the new epoch and is accepted.
      val epoch = checkNotNull(runtime.current.textEpochs["query"])
      controller.interact(
        runtime,
        OverlayInteraction.TextChange("query", "from agent!", epoch = epoch),
      )
      assertEquals(OverlayScalar.Text("from agent!"), runtime.current.state["query"])
    }

  @Test
  fun `a rejected edit leaves the accepted text and moves the epoch so the field reverts`() =
    runTest {
      controller.show("show", spec(field))
      val runtime = checkNotNull(controller.activeRuntime)
      controller.interact(runtime, OverlayInteraction.TextChange("query", "ok"))
      val before = runtime.current.textEpochs["query"] ?: 0
      val tooBig = "x".repeat(OverlaySpecValidator.MAX_OVERLAY_SPEC_BYTES + 1)
      controller.interact(runtime, OverlayInteraction.TextChange("query", tooBig, epoch = before))
      // State, events and activity are untouched; only the epoch moved.
      assertEquals(OverlayScalar.Text("ok"), runtime.current.state["query"])
      assertEquals(1, events.size)
      assertTrue(runtime.current.active)
      val after = checkNotNull(runtime.current.textEpochs["query"])
      assertEquals(before + 1, after)
      // Edits typed against the rejected text (still in flight) are stale; the reverted field's
      // next edit carries the new epoch and is accepted.
      controller.interact(runtime, OverlayInteraction.TextChange("query", "stale", epoch = before))
      assertEquals(OverlayScalar.Text("ok"), runtime.current.state["query"])
      controller.interact(runtime, OverlayInteraction.TextChange("query", "ok!", epoch = after))
      assertEquals(OverlayScalar.Text("ok!"), runtime.current.state["query"])
    }

  @Test
  fun `edits arriving in order keep their per-overlay sequence`() = runTest {
    controller.show("show", spec(field))
    val runtime = checkNotNull(controller.activeRuntime)
    listOf("a", "ab", "abc").forEach {
      controller.interact(runtime, OverlayInteraction.TextChange("query", it))
    }
    assertEquals(listOf(1L, 2L, 3L), events.map { it.sequence })
    assertEquals(
      listOf("a", "ab", "abc"),
      events.map {
        (it.payload as kotlinx.serialization.json.JsonObject)["value"].toString().trim('"')
      },
    )
  }
}

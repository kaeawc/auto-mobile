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
 * the visible tree (issue #9874 point 1) and authoritative text beats stale in-flight edits (point
 * 2). Point 3 (a state-only update with no window) went away with the update action (#10490).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class OverlayTextFieldControllerTest {
  private val host = FakeInteractiveOverlayHost()
  private val events = mutableListOf<OverlayEvent>()
  private val results = mutableListOf<Pair<Boolean, String?>>()
  private val controller =
    OverlayController(
      host,
      OverlayResultSink { _, success, error -> results += success to error },
      eventSink = OverlayEventSink { events += it },
      clock = { 42L },
      lifecycle = OverlayLifecycle(FakeOverlayTimer()),
    )

  private val field = OverlayTextFieldNode(stateKey = "query")
  private val pagerWithFieldOnSecondPage =
    OverlayPagerNode("pager", children = listOf(OverlayTextNode(text = "one"), field))

  private fun spec(
    root: OverlayNode,
    state: Map<String, OverlayScalar> = mapOf("query" to OverlayScalar.Text("")),
  ) = OverlaySpec("panel", OverlayWindow(OverlayFullscreenPlacement()), state, root)

  private fun sheetSpec(open: Boolean = false) =
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
      mapOf(
        "open" to OverlayScalar.BooleanValue(open),
        "query" to OverlayScalar.Text(""),
      ),
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
      val runtime = checkNotNull(controller.activeRuntime)
      controller.interact(
        runtime,
        OverlayInteraction.Tap(
          listOf(OverlaySetStateAction("open", OverlayScalar.BooleanValue(true)))
        ),
      )
      assertTrue(focusable())
      controller.interact(
        runtime,
        OverlayInteraction.SheetDismiss(OverlaySheetCondition("open", true)),
      )
      assertFalse(focusable())
      assertEquals(listOf("textField:true", "textField:false"), flips())
    }

  @Test
  fun `a same-id show renders the window focusability of its own tree`() = runTest {
    controller.show("show", sheetSpec())
    assertFalse(focusable())
    controller.show("open", sheetSpec(open = true))
    assertTrue(focusable())
    controller.show("close", sheetSpec())
    assertFalse(focusable())
    assertEquals(listOf(true to null, true to null, true to null), results)
    assertTrue(flips().isEmpty()) // Each show carries its own window request.
  }

  @Test
  fun `a same-id show keeps the page and therefore the focusability`() = runTest {
    controller.show("show", spec(pagerWithFieldOnSecondPage))
    val runtime = checkNotNull(controller.activeRuntime)
    controller.interact(runtime, OverlayInteraction.SettledPage("pager", 1))
    controller.show("replace", spec(pagerWithFieldOnSecondPage))
    assertTrue(focusable())
    assertEquals(listOf(true to null, true to null), results)
  }

  @Test
  fun `a rejected focus flip keeps the old setting and is retried on the next change`() = runTest {
    controller.show("show", spec(pagerWithFieldOnSecondPage))
    val runtime = checkNotNull(controller.activeRuntime)
    host.acceptTextField = false
    controller.interact(runtime, OverlayInteraction.SettledPage("pager", 1))
    assertFalse(focusable())
    host.acceptTextField = true
    controller.interact(runtime, OverlayInteraction.Tap(emptyList()))
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

  // --- Point 2: an authoritative external text update beats stale in-flight edits ----------------

  @Test
  fun `an edit made before a same-id re-show is stale and cannot overwrite its text`() = runTest {
    controller.show("show", spec(field))
    val runtime = checkNotNull(controller.activeRuntime)
    controller.interact(runtime, OverlayInteraction.TextChange("query", "ab", epoch = 0))
    controller.show("agent", spec(field, mapOf("query" to OverlayScalar.Text("from agent"))))
    val shown = checkNotNull(controller.activeRuntime)
    // A report typed into the previous showing arrives after the re-show.
    controller.interact(runtime, OverlayInteraction.TextChange("query", "abc", epoch = 0))
    assertEquals(OverlayScalar.Text("from agent"), shown.current.state["query"])
    // The field rendered by the re-show is new and its edits are accepted.
    controller.interact(shown, OverlayInteraction.TextChange("query", "from agent!", epoch = 0))
    assertEquals(OverlayScalar.Text("from agent!"), shown.current.state["query"])
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

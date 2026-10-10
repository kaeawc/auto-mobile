package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Controller behaviour around a text-field prototype with the fake host: window focusability tracks
 * the visible tree (issue #9874 point 1) and authoritative text beats stale in-flight edits (point
 * 2). Point 3 (a state-only update with no window) went away with the update action (#10490).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class PrototypeTextFieldControllerTest {
  private val host = FakePrototypeHost()
  private val events = mutableListOf<PrototypeEvent>()
  private val results = mutableListOf<Pair<Boolean, String?>>()
  private val controller =
    PrototypeController(
      host,
      PrototypeResultSink { _, success, error -> results += success to error },
      eventSink = PrototypeEventSink { events += it },
      clock = { 42L },
      lifecycle = PrototypeLifecycle(FakePrototypeTimer()),
    )

  private val field = PrototypeTextFieldNode(stateKey = "query")
  private val pagerWithFieldOnSecondPage =
    PrototypePagerNode("pager", children = listOf(PrototypeTextNode(text = "one"), field))

  private fun spec(
    root: PrototypeNode,
    state: Map<String, PrototypeScalar> = mapOf("query" to PrototypeScalar.Text("")),
  ) = PrototypeSpec("panel", PrototypeWindow(PrototypeFullscreenPlacement()), state, root)

  private fun sheetSpec(open: Boolean = false) =
    spec(
      PrototypeBoxNode(
        children =
          listOf(
            PrototypeTextNode(text = "page"),
            PrototypeBottomSheetNode(
              child = field,
              openWhen = PrototypeSheetCondition("open", true),
              detents = listOf(PrototypeDetent.Full),
            ),
          ),
      ),
      mapOf(
        "open" to PrototypeScalar.BooleanValue(open),
        "query" to PrototypeScalar.Text(""),
      ),
    )

  private fun focusable() = host.requests.last().hasTextField

  private fun flips() = host.calls.filter { it.startsWith("textField:") }

  @Test
  fun `a prototype whose only text field is not visible is not focusable`() = runTest {
    controller.show("show", spec(pagerWithFieldOnSecondPage))
    assertFalse(focusable())
    controller.show(
      "hidden",
      spec(pagerWithFieldOnSecondPage.copy(children = listOf(PrototypeSpacerNode()))),
    )
    assertFalse(focusable())
    assertTrue(flips().isEmpty())
  }

  @Test
  fun `swiping to the field's page makes the window focusable and swiping away releases it`() =
    runTest {
      controller.show("show", spec(pagerWithFieldOnSecondPage))
      val runtime = checkNotNull(controller.activeRuntime)
      controller.interact(runtime, PrototypeInteraction.SettledPage("pager", 1))
      assertTrue(focusable())
      controller.interact(runtime, PrototypeInteraction.SettledPage("pager", 0))
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
        PrototypeInteraction.Tap(
          listOf(PrototypeSetStateAction("open", PrototypeScalar.BooleanValue(true))),
        ),
      )
      assertTrue(focusable())
      controller.interact(
        runtime,
        PrototypeInteraction.SheetDismiss(PrototypeSheetCondition("open", true)),
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
    controller.interact(runtime, PrototypeInteraction.SettledPage("pager", 1))
    controller.show("replace", spec(pagerWithFieldOnSecondPage))
    assertTrue(focusable())
    assertEquals(listOf(true to null, true to null), results)
  }

  @Test
  fun `a rejected focus flip keeps the old setting and is retried on the next change`() = runTest {
    controller.show("show", spec(pagerWithFieldOnSecondPage))
    val runtime = checkNotNull(controller.activeRuntime)
    host.acceptTextField = false
    controller.interact(runtime, PrototypeInteraction.SettledPage("pager", 1))
    assertFalse(focusable())
    host.acceptTextField = true
    controller.interact(runtime, PrototypeInteraction.Tap(emptyList()))
    assertTrue(focusable())
  }

  @Test
  fun `the dismiss path through the host row emits exactly one user event`() = runTest {
    controller.show("show", spec(field))
    val runtime = checkNotNull(controller.activeRuntime)
    // Back on a focusable prototype is delivered as the host's dismiss request (see the host test).
    controller.interact(runtime, PrototypeInteraction.HostDismiss)
    controller.interact(runtime, PrototypeInteraction.HostDismiss)
    val dismissals = events.filter { it.kind == PrototypeEventKind.DISMISSED }
    assertEquals(1, dismissals.size)
    assertEquals(Json.parseToJsonElement("""{"reason":"user"}"""), dismissals.single().payload)
  }

  // --- Point 2: an authoritative external text update beats stale in-flight edits ----------------

  @Test
  fun `an edit made before a same-id re-show is stale and cannot overwrite its text`() = runTest {
    controller.show("show", spec(field))
    val runtime = checkNotNull(controller.activeRuntime)
    controller.interact(runtime, PrototypeInteraction.TextChange("query", "ab", epoch = 0))
    controller.show("agent", spec(field, mapOf("query" to PrototypeScalar.Text("from agent"))))
    val shown = checkNotNull(controller.activeRuntime)
    // A report typed into the previous showing arrives after the re-show.
    controller.interact(runtime, PrototypeInteraction.TextChange("query", "abc", epoch = 0))
    assertEquals(PrototypeScalar.Text("from agent"), shown.current.state["query"])
    // The field rendered by the re-show is new and its edits are accepted.
    controller.interact(shown, PrototypeInteraction.TextChange("query", "from agent!", epoch = 0))
    assertEquals(PrototypeScalar.Text("from agent!"), shown.current.state["query"])
  }

  @Test
  fun `a rejected edit leaves the accepted text and moves the epoch so the field reverts`() =
    runTest {
      controller.show("show", spec(field))
      val runtime = checkNotNull(controller.activeRuntime)
      controller.interact(runtime, PrototypeInteraction.TextChange("query", "ok"))
      val before = runtime.current.textEpochs["query"] ?: 0
      val tooBig = "x".repeat(PrototypeSpecValidator.MAX_PROTOTYPE_SPEC_BYTES + 1)
      controller.interact(runtime, PrototypeInteraction.TextChange("query", tooBig, epoch = before))
      // State, events and activity are untouched; only the epoch moved.
      assertEquals(PrototypeScalar.Text("ok"), runtime.current.state["query"])
      assertEquals(1, events.size)
      assertTrue(runtime.current.active)
      val after = checkNotNull(runtime.current.textEpochs["query"])
      assertEquals(before + 1, after)
      // Edits typed against the rejected text (still in flight) are stale; the reverted field's
      // next edit carries the new epoch and is accepted.
      controller.interact(
        runtime,
        PrototypeInteraction.TextChange("query", "stale", epoch = before),
      )
      assertEquals(PrototypeScalar.Text("ok"), runtime.current.state["query"])
      controller.interact(runtime, PrototypeInteraction.TextChange("query", "ok!", epoch = after))
      assertEquals(PrototypeScalar.Text("ok!"), runtime.current.state["query"])
    }

  @Test
  fun `edits arriving in order keep their per-prototype sequence`() = runTest {
    controller.show("show", spec(field))
    val runtime = checkNotNull(controller.activeRuntime)
    listOf("a", "ab", "abc").forEach {
      controller.interact(runtime, PrototypeInteraction.TextChange("query", it))
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

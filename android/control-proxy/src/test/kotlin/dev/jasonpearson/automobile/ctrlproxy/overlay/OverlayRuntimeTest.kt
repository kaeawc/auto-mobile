package dev.jasonpearson.automobile.ctrlproxy.overlay

import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

class OverlayRuntimeTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warmValidator() {
      OverlaySpecValidator.validate("{}")
    }
  }

  private val events = mutableListOf<OverlayEvent>()
  private var sequence = 0L
  private var delivered = true
  private val sink = OverlayEventSink { if (delivered) events += it }

  private fun spec(
    root: OverlayNode =
      OverlayPagerNode("pager", children = List(4) { OverlayTextNode(text = "page") }),
    state: Map<String, OverlayScalar> = emptyMap(),
  ) = OverlaySpec("panel", OverlayWindow(OverlayFullscreenPlacement()), state, root)

  private fun runtime(spec: OverlaySpec = spec(), dismiss: suspend () -> Boolean = { true }) =
    OverlayRuntime(spec, sink, { 42L }, { ++sequence }, dismiss)

  private fun tap(vararg actions: OverlayAction) = OverlayInteraction.Tap(actions.toList())

  @Test
  fun `every action runs in order and dismissal is terminal even within an action list`() =
    runTest {
      val runtime = runtime()
      val payload = Json.parseToJsonElement("""{"nested":[true,null]}""")
      runtime.handle(
        tap(
          OverlayEmitAction("before", payload),
          OverlaySetStateAction("label", OverlayScalar.Text("Next")),
          OverlaySetPageAction("pager", OverlayPageTarget.Next),
          OverlayEmitAction("after"),
          OverlayDismissAction,
          OverlayEmitAction("too-late"),
          OverlaySetStateAction("label", OverlayScalar.Text("too-late")),
        )
      )
      assertEquals(listOf(1L, 2L, 3L, 4L), events.map { it.sequence })
      assertEquals(
        listOf(
          OverlayEventKind.EMIT,
          OverlayEventKind.PAGE_CHANGED,
          OverlayEventKind.EMIT,
          OverlayEventKind.DISMISSED,
        ),
        events.map { it.kind },
      )
      assertEquals(emptyMap<String, OverlayScalar>(), events.first().state)
      assertEquals(payload, events.first().payload)
      assertEquals(mapOf("label" to OverlayScalar.Text("Next")), events[1].state)
      assertEquals(mapOf("pager" to 1), events[1].pages)
      assertEquals("after", events[2].name)
      assertTrue(events.all { it.timestamp == 42L })
      runtime.handle(OverlayInteraction.TextChange("label", "late"))
      runtime.handle(OverlayInteraction.SettledPage("pager", 3))
      runtime.replace(spec())
      runtime.dismiss()
      assertEquals(4, events.size)
      assertFalse(runtime.current.active)
    }

  @Test
  fun `setPage next prev index clamp and unchanged page never duplicates an event`() = runTest {
    val runtime = runtime()
    for (target in
      listOf(
        OverlayPageTarget.Prev,
        OverlayPageTarget.Next,
        OverlayPageTarget.Index(Int.MAX_VALUE),
        OverlayPageTarget.Next,
        OverlayPageTarget.Prev,
        OverlayPageTarget.Index(0),
      )) runtime.handle(tap(OverlaySetPageAction("pager", target)))
    assertEquals(listOf(1, 3, 2, 0), events.map { it.pages.getValue("pager") })
    assertTrue(events.all { it.name == null && it.payload == null })
  }

  @Test
  fun `fling intermediate pages are ignored and only the settled page emits`() = runTest {
    val runtime = runtime()
    runtime.handle(OverlayInteraction.PagerMotion("pager", 1, true))
    runtime.handle(OverlayInteraction.PagerMotion("pager", 2, true))
    assertTrue(events.isEmpty())
    assertEquals(0, runtime.current.pages["pager"])
    runtime.handle(OverlayInteraction.PagerMotion("pager", 3, false))
    runtime.handle(OverlayInteraction.PagerMotion("pager", 3, false))
    assertEquals(1, events.size)
    assertEquals(3, events.single().pages["pager"])
  }

  @Test
  fun `state and spec replacement preserve pages clamp remaining ids and initialize new ids`() =
    runTest {
      val runtime = runtime()
      runtime.handle(OverlayInteraction.SettledPage("pager", 3))
      runtime.replace(
        runtime.current.spec.copy(state = mapOf("label" to OverlayScalar.Text("patch")))
      )
      assertEquals(3, runtime.current.pages["pager"])
      runtime.replace(
        spec(
          OverlayRowNode(
            children =
              listOf(
                OverlayPagerNode("pager", children = List(2) { OverlaySpacerNode() }),
                OverlayPagerNode("new", children = listOf(OverlaySpacerNode())),
              )
          )
        )
      )
      assertEquals(mapOf("pager" to 1, "new" to 0), runtime.current.pages)
      runtime.replace(spec(OverlaySpacerNode()))
      assertTrue(runtime.current.pages.isEmpty())
      runtime.replace(spec())
      assertEquals(0, runtime.current.pages["pager"])
      assertEquals(1, events.size)
    }

  @Test
  fun `tabBar and bottomNav selections bind to pager and numeric state with clamped rendering`() =
    runTest {
      val items = listOf(OverlayItem("First", "home"), OverlayItem("Second", image = "future"))
      val nodes =
        listOf(
          OverlayPagerNode("pager", children = List(4) { OverlaySpacerNode() }),
          OverlayTabBarNode(items = items, pager = "pager"),
          OverlayBottomNavNode(items = items, pager = "pager"),
          OverlayTabBarNode(items = items, stateKey = "tab"),
          OverlayBottomNavNode(items = items, stateKey = "tab"),
        )
      val runtime =
        runtime(
          spec(OverlayColumnNode(children = nodes), mapOf("tab" to OverlayScalar.Numeric(0.0)))
        )
      runtime.handle(OverlayInteraction.Select("pager", null, 1))
      runtime.handle(OverlayInteraction.Select(null, "tab", 1))
      var model = mapOverlaySpec(runtime.current.spec, runtime.current.pages)
      assertEquals(listOf(1, 1, 1, 1), model.root.children.drop(1).map { it.selection })
      runtime.handle(OverlayInteraction.Select(null, "tab", 1))
      assertEquals(2, events.size)
      assertEquals(Json.parseToJsonElement("""{"key":"tab","value":1.0}"""), events.last().payload)
      runtime.handle(OverlayInteraction.SettledPage("pager", 3))
      runtime.handle(tap(OverlaySetStateAction("tab", OverlayScalar.Numeric(99.0))))
      model = mapOverlaySpec(runtime.current.spec, runtime.current.pages)
      assertTrue(model.root.children.drop(1).all { it.selection == 1 })
    }

  @Test
  fun `text changes from keyboard or setText share one change event and duplicate values are silent`() =
    runTest {
      val runtime =
        runtime(
          spec(
            OverlayTextFieldNode(stateKey = "query", placeholder = "Feedback"),
            mapOf("query" to OverlayScalar.Text("")),
          )
        )
      runtime.handle(OverlayInteraction.TextChange("query", "typed"))
      runtime.handle(OverlayInteraction.TextChange("query", "typed"))
      assertEquals(1, events.size)
      assertEquals("change", events.single().name)
      assertEquals(
        Json.parseToJsonElement("""{"key":"query","value":"typed"}"""),
        events.single().payload,
      )
      assertEquals("typed", mapOverlaySpec(runtime.current.spec).root.text)
    }

  @Test
  fun `bound types reject invalid setState without mutation and actions may create flat scalars`() =
    runTest {
      val root =
        OverlayColumnNode(
          children =
            listOf(
              OverlayTextFieldNode(stateKey = "query"),
              OverlayTabBarNode(items = listOf(OverlayItem("Tab")), stateKey = "selected"),
              OverlayBottomSheetNode(
                child = OverlaySpacerNode(),
                openWhen = OverlaySheetCondition("open", true),
                detents = listOf(OverlayDetent.Half),
              ),
            )
        )
      val runtime =
        runtime(
          spec(
            root,
            mapOf("query" to OverlayScalar.Text(""), "selected" to OverlayScalar.Numeric(0.0)),
          )
        )
      for ((key, value) in
        listOf(
          "query" to OverlayScalar.Numeric(1.0),
          "selected" to OverlayScalar.Numeric(-1.0),
          "selected" to OverlayScalar.Numeric(0.5),
          "open" to OverlayScalar.Text("true"),
        )) {
        try {
          runtime.handle(tap(OverlaySetStateAction(key, value)))
          fail("Invalid binding must fail")
        } catch (expected: IllegalArgumentException) {
          assertNotNull(expected.message)
        }
      }
      assertEquals(2, runtime.current.state.size)
      runtime.handle(tap(OverlaySetStateAction("flag", OverlayScalar.BooleanValue(true))))
      assertEquals(OverlayScalar.BooleanValue(true), runtime.current.state["flag"])
      assertTrue(events.isEmpty())
    }

  @Test
  fun `sheet open swipe and scrim dismissal invert condition and emit only one change`() = runTest {
    for (equals in listOf(true, false)) {
      val condition = OverlaySheetCondition("open", equals)
      val sheet =
        OverlayBottomSheetNode(
          child = OverlaySpacerNode(),
          openWhen = condition,
          detents = listOf(OverlayDetent.Half, OverlayDetent.Full),
        )
      val runtime = runtime(spec(sheet))
      assertFalse(mapOverlaySpec(runtime.current.spec).root.sheetOpen)
      runtime.handle(tap(OverlaySetStateAction("open", OverlayScalar.BooleanValue(equals))))
      assertTrue(mapOverlaySpec(runtime.current.spec).root.sheetOpen)
      runtime.handle(OverlayInteraction.SheetDismiss(condition))
      runtime.handle(OverlayInteraction.SheetDismiss(condition))
      assertEquals(OverlayScalar.BooleanValue(!equals), runtime.current.state["open"])
      assertFalse(mapOverlaySpec(runtime.current.spec).root.sheetOpen)
    }
    assertEquals(2, events.size)
    assertTrue(events.all { it.kind == OverlayEventKind.EMIT && it.name == "change" })
  }

  @Test
  fun `sheet detents use window height author order clamping and snapping with optional swipe dismissal`() {
    val heights =
      overlaySheetHeights(
        listOf(
          OverlayDetent.Full,
          OverlayDetent.Half,
          OverlayDetent.Dp(100.0),
          OverlayDetent.Dp(900.0),
        ),
        600.0,
      )
    assertEquals(listOf(600.0, 300.0, 100.0, 600.0), heights)
    assertEquals(300.0, settleOverlaySheet(heights, 600.0, 220.0, true))
    assertEquals(600.0, settleOverlaySheet(heights, 300.0, -220.0, true))
    assertNull(settleOverlaySheet(heights, 100.0, 60.0, true))
    assertEquals(100.0, settleOverlaySheet(heights, 100.0, 60.0, false))
  }

  @Test
  fun `nearest pager interpolation and visibility recompose after page and scalar changes`() =
    runTest {
      val pageText =
        OverlayTextNode(
          text = "{page}/{pageCount} {label}",
          visibleWhen = OverlayCondition("page", OverlayScalar.Numeric(2.0)),
        )
      val inner =
        OverlayPagerNode("inner", children = listOf(OverlayTextNode(text = "{page}/{pageCount}")))
      val runtime =
        runtime(
          spec(
            OverlayPagerNode("pager", children = listOf(pageText, inner)),
            mapOf("label" to OverlayScalar.Text("old")),
          )
        )
      var model = mapOverlaySpec(runtime.current.spec, runtime.current.pages)
      assertEquals("1/2 old", model.root.children.first().text)
      assertFalse(model.root.children.first().visible)
      runtime.handle(OverlayInteraction.SettledPage("pager", 1))
      runtime.handle(tap(OverlaySetStateAction("label", OverlayScalar.Text("new"))))
      model = mapOverlaySpec(runtime.current.spec, runtime.current.pages)
      assertEquals("2/2 new", model.root.children.first().text)
      assertTrue(model.root.children.first().visible)
      assertEquals("1/1", model.root.children[1].children.single().text)
      runtime.replace(
        runtime.current.spec.copy(
          state = runtime.current.state + ("label" to OverlayScalar.Text("patched"))
        )
      )
      assertEquals(
        "2/2 patched",
        mapOverlaySpec(runtime.current.spec, runtime.current.pages).root.children.first().text,
      )
    }

  @Test
  fun `disconnected delivery and state patch never rewind sequence`() = runTest {
    val runtime = runtime()
    runtime.handle(tap(OverlayEmitAction("one")))
    delivered = false
    runtime.handle(tap(OverlayEmitAction("dropped")))
    runtime.replace(
      runtime.current.spec.copy(state = mapOf("patch" to OverlayScalar.BooleanValue(true)))
    )
    delivered = true
    runtime.handle(tap(OverlayEmitAction("three")))
    assertEquals(listOf(1L, 3L), events.map { it.sequence })
  }

  @Test
  fun `failed dismissal stays active but close suppresses every late interaction`() = runTest {
    val runtime = runtime(dismiss = { false })
    try {
      runtime.dismiss()
      fail("Host rejected dismissal")
    } catch (expected: IllegalStateException) {
      assertTrue(expected.message.orEmpty().contains("dismiss"))
    }
    assertTrue(runtime.current.active)
    runtime.close()
    runtime.handle(tap(OverlayEmitAction("late")))
    runtime.handle(OverlayInteraction.Select("pager", null, 2))
    runtime.dismiss()
    assertTrue(events.isEmpty())
  }
}

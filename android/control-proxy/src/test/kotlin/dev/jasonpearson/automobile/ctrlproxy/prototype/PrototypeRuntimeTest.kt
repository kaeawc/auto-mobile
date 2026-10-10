package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

class PrototypeRuntimeTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warmValidator() {
      PrototypeSpecValidator.validate("{}")
    }
  }

  private val events = mutableListOf<PrototypeEvent>()
  private var sequence = 0L
  private var delivered = true
  private val sink = PrototypeEventSink { if (delivered) events += it }

  private fun spec(
    root: PrototypeNode =
      PrototypePagerNode("pager", children = List(4) { PrototypeTextNode(text = "page") }),
    state: Map<String, PrototypeScalar> = emptyMap(),
  ) = PrototypeSpec("panel", PrototypeWindow(PrototypeFullscreenPlacement()), state, root)

  private fun runtime(spec: PrototypeSpec = spec(), dismiss: suspend () -> Boolean = { true }) =
    PrototypeRuntime(spec, sink, { 42L }, { ++sequence }, dismiss)

  private fun tap(vararg actions: PrototypeAction) = PrototypeInteraction.Tap(actions.toList())

  @Test
  fun `every action runs in order and dismissal is terminal even within an action list`() =
    runTest {
      val runtime = runtime()
      val payload = Json.parseToJsonElement("""{"nested":[true,null]}""")
      runtime.handle(
        tap(
          PrototypeEmitAction("before", payload),
          PrototypeSetStateAction("label", PrototypeScalar.Text("Next")),
          PrototypeSetPageAction("pager", PrototypePageTarget.Next),
          PrototypeEmitAction("after"),
          PrototypeDismissAction,
          PrototypeEmitAction("too-late"),
          PrototypeSetStateAction("label", PrototypeScalar.Text("too-late")),
        ),
      )
      assertEquals(listOf(1L, 2L, 3L, 4L), events.map { it.sequence })
      assertEquals(
        listOf(
          PrototypeEventKind.EMIT,
          PrototypeEventKind.PAGE_CHANGED,
          PrototypeEventKind.EMIT,
          PrototypeEventKind.DISMISSED,
        ),
        events.map { it.kind },
      )
      assertEquals(emptyMap<String, PrototypeScalar>(), events.first().state)
      assertEquals(payload, events.first().payload)
      assertEquals(mapOf("label" to PrototypeScalar.Text("Next")), events[1].state)
      assertEquals(mapOf("pager" to 1), events[1].pages)
      assertEquals("after", events[2].name)
      assertTrue(events.all { it.timestamp == 42L })
      runtime.handle(PrototypeInteraction.TextChange("label", "late"))
      runtime.handle(PrototypeInteraction.SettledPage("pager", 3))
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
        PrototypePageTarget.Prev,
        PrototypePageTarget.Next,
        PrototypePageTarget.Index(Int.MAX_VALUE),
        PrototypePageTarget.Next,
        PrototypePageTarget.Prev,
        PrototypePageTarget.Index(0),
      )) runtime.handle(tap(PrototypeSetPageAction("pager", target)))
    assertEquals(listOf(1, 3, 2, 0), events.map { it.pages.getValue("pager") })
    assertTrue(events.all { it.name == null && it.payload == null })
  }

  @Test
  fun `fling intermediate pages are ignored and only the settled page emits`() = runTest {
    val runtime = runtime()
    runtime.handle(PrototypeInteraction.PagerMotion("pager", 1, true))
    runtime.handle(PrototypeInteraction.PagerMotion("pager", 2, true))
    assertTrue(events.isEmpty())
    assertEquals(0, runtime.current.pages["pager"])
    runtime.handle(PrototypeInteraction.PagerMotion("pager", 3, false))
    runtime.handle(PrototypeInteraction.PagerMotion("pager", 3, false))
    assertEquals(1, events.size)
    assertEquals(3, events.single().pages["pager"])
  }

  @Test
  fun `state and spec replacement preserve pages clamp remaining ids and initialize new ids`() =
    runTest {
      val runtime = runtime()
      runtime.handle(PrototypeInteraction.SettledPage("pager", 3))
      runtime.replace(
        runtime.current.spec.copy(state = mapOf("label" to PrototypeScalar.Text("patch"))),
      )
      assertEquals(3, runtime.current.pages["pager"])
      runtime.replace(
        spec(
          PrototypeRowNode(
            children =
              listOf(
                PrototypePagerNode("pager", children = List(2) { PrototypeSpacerNode() }),
                PrototypePagerNode("new", children = listOf(PrototypeSpacerNode())),
              ),
          ),
        ),
      )
      assertEquals(mapOf("pager" to 1, "new" to 0), runtime.current.pages)
      runtime.replace(spec(PrototypeSpacerNode()))
      assertTrue(runtime.current.pages.isEmpty())
      runtime.replace(spec())
      assertEquals(0, runtime.current.pages["pager"])
      assertEquals(1, events.size)
    }

  @Test
  fun `tabBar and bottomNav selections bind to pager and numeric state with clamped rendering`() =
    runTest {
      val items = listOf(PrototypeItem("First", "home"), PrototypeItem("Second", image = "future"))
      val nodes =
        listOf(
          PrototypePagerNode("pager", children = List(4) { PrototypeSpacerNode() }),
          PrototypeTabBarNode(items = items, pager = "pager"),
          PrototypeBottomNavNode(items = items, pager = "pager"),
          PrototypeTabBarNode(items = items, stateKey = "tab"),
          PrototypeBottomNavNode(items = items, stateKey = "tab"),
        )
      val runtime =
        runtime(
          spec(PrototypeColumnNode(children = nodes), mapOf("tab" to PrototypeScalar.Numeric(0.0))),
        )
      runtime.handle(PrototypeInteraction.Select("pager", null, 1))
      runtime.handle(PrototypeInteraction.Select(null, "tab", 1))
      var model = mapPrototypeSpec(runtime.current.spec, runtime.current.pages)
      assertEquals(listOf(1, 1, 1, 1), model.root.children.drop(1).map { it.selection })
      runtime.handle(PrototypeInteraction.Select(null, "tab", 1))
      assertEquals(2, events.size)
      assertEquals(Json.parseToJsonElement("""{"key":"tab","value":1.0}"""), events.last().payload)
      runtime.handle(PrototypeInteraction.SettledPage("pager", 3))
      runtime.handle(tap(PrototypeSetStateAction("tab", PrototypeScalar.Numeric(99.0))))
      model = mapPrototypeSpec(runtime.current.spec, runtime.current.pages)
      assertTrue(model.root.children.drop(1).all { it.selection == 1 })
    }

  @Test
  fun `text changes from keyboard or setText share one change event and duplicate values are silent`() =
    runTest {
      val runtime =
        runtime(
          spec(
            PrototypeTextFieldNode(stateKey = "query", placeholder = "Feedback"),
            mapOf("query" to PrototypeScalar.Text("")),
          ),
        )
      runtime.handle(PrototypeInteraction.TextChange("query", "typed"))
      runtime.handle(PrototypeInteraction.TextChange("query", "typed"))
      assertEquals(1, events.size)
      assertEquals("change", events.single().name)
      assertEquals(
        Json.parseToJsonElement("""{"key":"query","value":"typed"}"""),
        events.single().payload,
      )
      assertEquals("typed", mapPrototypeSpec(runtime.current.spec).root.text)
    }

  @Test
  fun `bound types reject invalid setState without mutation and actions may create flat scalars`() =
    runTest {
      val root =
        PrototypeColumnNode(
          children =
            listOf(
              PrototypeTextFieldNode(stateKey = "query"),
              PrototypeTabBarNode(items = listOf(PrototypeItem("Tab")), stateKey = "selected"),
              PrototypeBottomSheetNode(
                child = PrototypeSpacerNode(),
                openWhen = PrototypeSheetCondition("open", true),
                detents = listOf(PrototypeDetent.Half),
              ),
            ),
        )
      val runtime =
        runtime(
          spec(
            root,
            mapOf("query" to PrototypeScalar.Text(""), "selected" to PrototypeScalar.Numeric(0.0)),
          ),
        )
      for ((key, value) in
        listOf(
          "query" to PrototypeScalar.Numeric(1.0),
          "selected" to PrototypeScalar.Numeric(-1.0),
          "selected" to PrototypeScalar.Numeric(0.5),
          "open" to PrototypeScalar.Text("true"),
        )) {
        try {
          runtime.handle(tap(PrototypeSetStateAction(key, value)))
          fail("Invalid binding must fail")
        } catch (expected: IllegalArgumentException) {
          assertNotNull(expected.message)
        }
      }
      assertEquals(2, runtime.current.state.size)
      runtime.handle(tap(PrototypeSetStateAction("flag", PrototypeScalar.BooleanValue(true))))
      assertEquals(PrototypeScalar.BooleanValue(true), runtime.current.state["flag"])
      // Only the accepted setState reports; rejected ones never mutated or emitted.
      assertEquals(listOf("change"), events.map { it.name })
    }

  @Test
  fun `sheet open swipe and scrim dismissal invert condition and emit only one change`() = runTest {
    for (equals in listOf(true, false)) {
      val condition = PrototypeSheetCondition("open", equals)
      val sheet =
        PrototypeBottomSheetNode(
          child = PrototypeSpacerNode(),
          openWhen = condition,
          detents = listOf(PrototypeDetent.Half, PrototypeDetent.Full),
        )
      val runtime = runtime(spec(sheet))
      assertFalse(mapPrototypeSpec(runtime.current.spec).root.sheetOpen)
      runtime.handle(tap(PrototypeSetStateAction("open", PrototypeScalar.BooleanValue(equals))))
      assertTrue(mapPrototypeSpec(runtime.current.spec).root.sheetOpen)
      runtime.handle(PrototypeInteraction.SheetDismiss(condition))
      runtime.handle(PrototypeInteraction.SheetDismiss(condition))
      assertEquals(PrototypeScalar.BooleanValue(!equals), runtime.current.state["open"])
      assertFalse(mapPrototypeSpec(runtime.current.spec).root.sheetOpen)
    }
    // Per iteration: the opening setState tap and the single dismissal change.
    assertEquals(4, events.size)
    assertTrue(events.all { it.kind == PrototypeEventKind.EMIT && it.name == "change" })
  }

  @Test
  fun `a tap that sets state emits one change with the final state`() = runTest {
    val runtime = runtime(spec(state = mapOf("a" to PrototypeScalar.Numeric(0.0))))
    runtime.handle(tap(PrototypeSetStateAction("a", PrototypeScalar.Numeric(5.0))))
    val event = events.single()
    assertEquals("change", event.name)
    assertEquals(Json.parseToJsonElement("""{"key":"a","value":5.0}"""), event.payload)
    assertEquals(mapOf("a" to PrototypeScalar.Numeric(5.0)), event.state)
  }

  @Test
  fun `toggle only and increment only taps each emit one change`() = runTest {
    val runtime =
      runtime(
        spec(
          state =
            mapOf("on" to PrototypeScalar.BooleanValue(false), "n" to PrototypeScalar.Numeric(1.0)),
        ),
      )
    runtime.handle(tap(PrototypeToggleAction("on")))
    runtime.handle(tap(PrototypeIncrementAction("n", 2.0)))
    assertEquals(
      listOf(
        Json.parseToJsonElement("""{"key":"on","value":true}"""),
        Json.parseToJsonElement("""{"key":"n","value":3.0}"""),
      ),
      events.map { it.payload },
    )
  }

  @Test
  fun `mixed emit then setState emits in order with a trailing change carrying the final state`() =
    runTest {
      val runtime = runtime(spec(state = mapOf("a" to PrototypeScalar.Numeric(0.0))))
      runtime.handle(
        tap(
          PrototypeEmitAction("tapped"),
          PrototypeSetStateAction("a", PrototypeScalar.Numeric(1.0)),
          PrototypeIncrementAction("a"),
        ),
      )
      assertEquals(listOf("tapped", "change"), events.map { it.name })
      assertEquals(mapOf("a" to PrototypeScalar.Numeric(0.0)), events[0].state)
      assertEquals(mapOf("a" to PrototypeScalar.Numeric(2.0)), events[1].state)
      assertEquals(Json.parseToJsonElement("""{"key":"a","value":2.0}"""), events[1].payload)
    }

  @Test
  fun `several mutated keys share one change event listing each key`() = runTest {
    val runtime = runtime()
    runtime.handle(
      tap(
        PrototypeSetStateAction("x", PrototypeScalar.Numeric(1.0)),
        PrototypeSetStateAction("y", PrototypeScalar.Text("hi")),
      ),
    )
    assertEquals(
      Json.parseToJsonElement("""{"keys":["x","y"],"values":{"x":1.0,"y":"hi"}}"""),
      events.single().payload,
    )
  }

  @Test
  fun `no-op action lists emit nothing`() = runTest {
    val runtime =
      runtime(
        spec(
          state =
            mapOf("a" to PrototypeScalar.Numeric(1.0), "on" to PrototypeScalar.BooleanValue(false)),
        ),
      )
    runtime.handle(tap())
    runtime.handle(tap(PrototypeSetStateAction("a", PrototypeScalar.Numeric(1.0))))
    // Toggled back to the starting value: no net mutation.
    runtime.handle(tap(PrototypeToggleAction("on"), PrototypeToggleAction("on")))
    assertTrue(events.isEmpty())
  }

  @Test
  fun `switch tap emits exactly one change`() = runTest {
    val runtime =
      runtime(
        spec(
          PrototypeSwitchNode(label = "Wi-Fi", stateKey = "on"),
          mapOf("on" to PrototypeScalar.BooleanValue(false)),
        ),
      )
    runtime.handle(PrototypeInteraction.Toggle("on"))
    assertEquals(listOf("change"), events.map { it.name })
  }

  @Test
  fun `sheet detents use window height author order clamping and snapping with optional swipe dismissal`() {
    val heights =
      prototypeSheetHeights(
        listOf(
          PrototypeDetent.Full,
          PrototypeDetent.Half,
          PrototypeDetent.Dp(100.0),
          PrototypeDetent.Dp(900.0),
        ),
        600.0,
      )
    assertEquals(listOf(600.0, 300.0, 100.0, 600.0), heights)
    assertEquals(300.0, settlePrototypeSheet(heights, 600.0, 220.0, true))
    assertEquals(600.0, settlePrototypeSheet(heights, 300.0, -220.0, true))
    assertNull(settlePrototypeSheet(heights, 100.0, 60.0, true))
    assertEquals(100.0, settlePrototypeSheet(heights, 100.0, 60.0, false))
  }

  @Test
  fun `nearest pager interpolation and visibility recompose after page and scalar changes`() =
    runTest {
      val pageText =
        PrototypeTextNode(
          text = "{page}/{pageCount} {label}",
          visibleWhen = PrototypeCondition("page", PrototypeScalar.Numeric(2.0)),
        )
      val inner =
        PrototypePagerNode(
          "inner",
          children = listOf(PrototypeTextNode(text = "{page}/{pageCount}")),
        )
      val runtime =
        runtime(
          spec(
            PrototypePagerNode("pager", children = listOf(pageText, inner)),
            mapOf("label" to PrototypeScalar.Text("old")),
          ),
        )
      var model = mapPrototypeSpec(runtime.current.spec, runtime.current.pages)
      assertEquals("1/2 old", model.root.children.first().text)
      assertFalse(model.root.children.first().visible)
      runtime.handle(PrototypeInteraction.SettledPage("pager", 1))
      runtime.handle(tap(PrototypeSetStateAction("label", PrototypeScalar.Text("new"))))
      model = mapPrototypeSpec(runtime.current.spec, runtime.current.pages)
      assertEquals("2/2 new", model.root.children.first().text)
      assertTrue(model.root.children.first().visible)
      assertEquals("1/1", model.root.children[1].children.single().text)
      runtime.replace(
        runtime.current.spec.copy(
          state = runtime.current.state + ("label" to PrototypeScalar.Text("patched")),
        ),
      )
      assertEquals(
        "2/2 patched",
        mapPrototypeSpec(runtime.current.spec, runtime.current.pages).root.children.first().text,
      )
    }

  @Test
  fun `disconnected delivery and state patch never rewind sequence`() = runTest {
    val runtime = runtime()
    runtime.handle(tap(PrototypeEmitAction("one")))
    delivered = false
    runtime.handle(tap(PrototypeEmitAction("dropped")))
    runtime.replace(
      runtime.current.spec.copy(state = mapOf("patch" to PrototypeScalar.BooleanValue(true))),
    )
    delivered = true
    runtime.handle(tap(PrototypeEmitAction("three")))
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
    runtime.handle(tap(PrototypeEmitAction("late")))
    runtime.handle(PrototypeInteraction.Select("pager", null, 2))
    runtime.dismiss()
    assertTrue(events.isEmpty())
  }

  @Test
  fun `toggle and increment step state, report one net change, and ignore keys of the wrong type`() =
    runTest {
      val runtime =
        runtime(
          spec(
            state =
              mapOf(
                "flag" to PrototypeScalar.BooleanValue(false),
                "count" to PrototypeScalar.Numeric(1.0),
                "label" to PrototypeScalar.Text("x"),
              ),
          ),
        )
      runtime.handle(
        tap(
          PrototypeToggleAction("flag"),
          PrototypeIncrementAction("count"),
          PrototypeIncrementAction("count", by = -3.5),
          PrototypeToggleAction("count"),
          PrototypeIncrementAction("label"),
          PrototypeIncrementAction("count", by = Double.MAX_VALUE),
          PrototypeIncrementAction("count", by = Double.MAX_VALUE),
        ),
      )
      assertEquals(PrototypeScalar.BooleanValue(true), runtime.current.state["flag"])
      assertEquals(PrototypeScalar.Numeric(Double.MAX_VALUE - 1.5), runtime.current.state["count"])
      assertEquals(PrototypeScalar.Text("x"), runtime.current.state["label"])
      val event = events.single()
      assertEquals(
        listOf("flag", "count"),
        (event.payload as JsonObject).getValue("keys").jsonArray.map { it.jsonPrimitive.content },
      )
      assertEquals(runtime.current.state, event.state)
    }

  @Test
  fun `decrement steps a numeric key down and reports one net change`() = runTest {
    val runtime = runtime(spec(state = mapOf("count" to PrototypeScalar.Numeric(5.0))))
    runtime.handle(
      tap(PrototypeDecrementAction("count"), PrototypeDecrementAction("count", by = 2.5)),
    )
    assertEquals(PrototypeScalar.Numeric(1.5), runtime.current.state["count"])
    assertEquals(1, events.size)
  }

  private fun fieldSpec() =
    spec(
      PrototypeColumnNode(
        children =
          listOf(
            PrototypePagerNode("pager", children = List(2) { PrototypeTextNode(text = "page") }),
            PrototypeTextFieldNode(stateKey = "query"),
          ),
      ),
      mapOf("flag" to PrototypeScalar.BooleanValue(false), "query" to PrototypeScalar.Text("")),
    )

  // The spec validator accepts a numeric setState on a textField's key; only the runtime's
  // re-validation of the resulting state rejects it (#11408).
  private val breaksBinding = PrototypeSetStateAction("query", PrototypeScalar.Numeric(1.0))

  private suspend fun assertRejected(runtime: PrototypeRuntime, interaction: PrototypeInteraction) {
    try {
      runtime.handle(interaction)
      fail("The action list must be rejected")
    } catch (expected: IllegalArgumentException) {
      assertNotNull(expected.message)
    }
  }

  @Test
  fun `a tap holding a rejected write applies nothing and emits nothing`() = runTest {
    val runtime = runtime(fieldSpec())
    val before = runtime.current
    assertRejected(
      runtime,
      tap(
        PrototypeEmitAction("before"),
        PrototypeSetStateAction("flag", PrototypeScalar.BooleanValue(true)),
        PrototypeSetPageAction("pager", PrototypePageTarget.Next),
        breaksBinding,
        PrototypeEmitAction("after"),
      ),
    )
    // Device state and the host's event-fed mirror stay equal: no write, no page, no sequence used.
    assertSame(before, runtime.current)
    assertTrue(events.isEmpty())
    assertEquals(0L, sequence)
    runtime.handle(tap(PrototypeSetStateAction("flag", PrototypeScalar.BooleanValue(true))))
    assertEquals(listOf(1L), events.map { it.sequence })
    assertEquals(PrototypeScalar.BooleanValue(true), events.single().state["flag"])
  }

  @Test
  fun `a write that never runs because the list dismissed first is not validated`() = runTest {
    val runtime = runtime(fieldSpec())
    runtime.handle(
      tap(
        PrototypeSetStateAction("flag", PrototypeScalar.BooleanValue(true)),
        PrototypeDismissAction,
        breaksBinding,
      ),
    )
    assertEquals(listOf(PrototypeEventKind.DISMISSED), events.map { it.kind })
    assertEquals(PrototypeScalar.BooleanValue(true), events.single().state["flag"])
    assertEquals(PrototypeScalar.Text(""), runtime.current.state["query"])
  }

  @Test
  fun `a control keeps its own reported change when its action list is rejected`() = runTest {
    val runtime = runtime(fieldSpec())
    assertRejected(runtime, PrototypeInteraction.Toggle("flag", listOf(breaksBinding)))
    assertEquals(PrototypeScalar.BooleanValue(true), runtime.current.state["flag"])
    assertEquals(runtime.current.state, events.single().state)
  }
}

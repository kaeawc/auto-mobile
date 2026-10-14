package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class PrototypePatchRuntimeTest {
  private val results = mutableListOf<PrototypeResult>()
  private val events = mutableListOf<PrototypeEvent>()
  private val host = FakePrototypeHost()
  private val resultSink =
    object : PrototypeResultSink {
      override suspend fun send(requestId: String?, success: Boolean, error: String?) {
        results += PrototypeResult(42L, requestId, success, error)
      }

      override suspend fun sendPatched(
        requestId: String?,
        success: Boolean,
        error: String?,
        revision: Long?,
        conflict: PrototypePatchConflict?,
      ) {
        results +=
          PrototypeResult(42L, requestId, success, error, revision = revision, conflict = conflict)
      }
    }
  private val controller =
    PrototypeController(
      host,
      resultSink,
      eventSink = PrototypeEventSink { events += it },
      clock = { 42L },
      lifecycle = PrototypeLifecycle(FakePrototypeTimer()),
    )

  private val spec =
    PrototypeSpec(
      "panel",
      PrototypeWindow(PrototypeFullscreenPlacement()),
      state =
        mapOf(
          "enabled" to PrototypeScalar.BooleanValue(false),
          "query" to PrototypeScalar.Text("kept"),
          "hour" to PrototypeScalar.Numeric(1.0),
          "minute" to PrototypeScalar.Numeric(2.0),
        ),
      root =
        PrototypeColumnNode(
          id = "root",
          children =
            listOf(
              PrototypeTextNode(id = "label", text = "{data:/title}"),
              PrototypeSwitchNode(stateKey = "enabled"),
              PrototypeTextFieldNode(stateKey = "query"),
              PrototypePagerNode(
                id = "pager",
                children = listOf(PrototypeTextNode(text = "one"), PrototypeTextNode(text = "two")),
              ),
            ),
        ),
      data = buildJsonObject { put("title", "old") },
    )

  private fun ops(text: String) = Json.parseToJsonElement(text).jsonArray

  private suspend fun show(): PrototypeRuntime {
    controller.show("show", spec)
    assertTrue(results.last().error, results.last().success)
    return checkNotNull(controller.activeRuntime)
  }

  private suspend fun patch(text: String, base: Long? = null, id: String = "panel") {
    controller.patch("patch", id, base, ops(text))
  }

  @Test
  fun `data patches are ordered increment revision and emit no change`() = runTest {
    val runtime = show()
    val revision = runtime.current.revision
    assertTrue(revision >= 0L)
    assertEquals(spec.state!!.keys.associateWith { revision }, runtime.current.stateRevisions)
    patch("""[{"op":"replace","path":"/data/title","value":"new"}]""")
    assertSame(runtime, controller.activeRuntime)
    assertEquals(revision + 1, results.last().revision)
    assertTrue(results.last().success)
    assertNull(results.last().conflict)
    assertEquals("new", runtime.renderModel().root.children[0].text)
    patch("""[{"op":"replace","path":"/data/title","value":"last"}]""")
    assertEquals(revision + 2, results.last().revision)
    assertEquals("last", runtime.renderModel().root.children[0].text)
    assertTrue(events.isEmpty())
  }

  @Test
  fun `queued patches serialize and an unchanged successful patch still advances revision`() =
    runTest {
      val runtime = show()
      val revision = runtime.current.revision
      val first = launch {
        controller.patch(
          "first",
          "panel",
          null,
          ops("""[{"op":"replace","path":"/data/title","value":"first"}]"""),
        )
      }
      val second = launch {
        controller.patch(
          "second",
          "panel",
          null,
          ops("""[{"op":"replace","path":"/data/title","value":"second"}]"""),
        )
      }
      joinAll(first, second)
      assertEquals(listOf("first", "second"), results.takeLast(2).map { it.requestId })
      assertEquals(listOf(revision + 1, revision + 2), results.takeLast(2).map { it.revision })
      assertEquals("second", runtime.renderModel().root.children[0].text)
      patch("""[{"op":"replace","path":"/data/title","value":"second"}]""")
      assertEquals(revision + 3, results.last().revision)
      assertTrue(events.isEmpty())
    }

  @Test
  fun `state patch uses live state emits one change and advances text epochs`() = runTest {
    val runtime = show()
    controller.interact(runtime, PrototypeInteraction.Toggle("enabled"))
    val revision = runtime.current.revision
    patch(
      """[{"op":"test","path":"/state/enabled","value":true},{"op":"replace","path":"/state/query","value":"patched"},{"op":"replace","path":"/state/enabled","value":false}]""",
      revision,
    )
    assertTrue(results.last().success)
    assertEquals(revision + 1, results.last().revision)
    assertEquals(PrototypeScalar.Text("patched"), runtime.current.state["query"])
    assertEquals(1, runtime.current.textEpochs["query"])
    assertEquals(revision + 1, runtime.current.stateRevisions["query"])
    assertEquals(revision + 1, runtime.current.stateRevisions["enabled"])
    assertEquals(2, events.size)
    assertEquals("change", events.last().name)
    assertEquals(
      listOf(JsonPrimitive("enabled"), JsonPrimitive("query")).toSet(),
      events.last().payload!!.jsonObject["keys"]!!.jsonArray.toSet(),
    )
  }

  @Test
  fun `stale touched keys conflict but unrelated newer state does not`() = runTest {
    val runtime = show()
    val base = runtime.current.revision
    controller.interact(runtime, PrototypeInteraction.Toggle("enabled"))
    val before = runtime.current
    patch(
      """[{"op":"replace","path":"/state/enabled","value":false},{"op":"replace","path":"/state/query","value":"new"}]""",
      base,
    )
    assertFalse(results.last().success)
    assertEquals("conflict: state changed after baseRevision $base", results.last().error)
    assertEquals(before.revision, results.last().revision)
    assertEquals(
      PrototypePatchConflict(
        before.revision,
        mapOf("enabled" to PrototypeScalar.BooleanValue(true)),
      ),
      results.last().conflict,
    )
    assertSame(before, runtime.current)
    patch("""[{"op":"replace","path":"/state/query","value":"new"}]""", base)
    assertTrue(results.last().success)
  }

  @Test
  fun `missing base failing tests and invalid results leave the entire snapshot unchanged`() =
    runTest {
      val runtime = show()
      val before = runtime.current
      patch("""[{"op":"replace","path":"/state/query","value":"new"}]""")
      assertEquals("baseRevision is required when a patch has /state ops", results.last().error)
      assertEquals(before.revision, results.last().revision)
      assertSame(before, runtime.current)
      patch(
        """[{"op":"replace","path":"/data/title","value":"new"},{"op":"replace","path":"/state/enabled","value":true},{"op":"test","path":"/state/query","value":"wrong"}]""",
        before.revision,
      )
      assertEquals("ops[2].value: Test failed", results.last().error)
      assertSame(before, runtime.current)
      patch("""[{"op":"replace","path":"/state/enabled","value":"wrong type"}]""", before.revision)
      assertFalse(results.last().success)
      assertEquals(before.revision, results.last().revision)
      assertSame(before, runtime.current)
      assertTrue(events.isEmpty())
    }

  @Test
  fun `replaceNode preserves pager and live text and rejects root and unknown ids`() = runTest {
    val runtime = show()
    controller.interact(runtime, PrototypeInteraction.SettledPage("pager", 1))
    controller.interact(runtime, PrototypeInteraction.TextChange("query", "typed"))
    patch(
      """[{"op":"replaceNode","id":"label","node":{"type":"text","id":"label","text":"replaced"}}]""",
    )
    assertTrue(results.last().success)
    assertEquals("replaced", runtime.renderModel().root.children[0].text)
    assertEquals(1, runtime.current.pages["pager"])
    assertEquals(PrototypeScalar.Text("typed"), runtime.current.state["query"])
    assertEquals(1, events.count { it.name == "change" })
    val before = runtime.current
    patch("""[{"op":"replaceNode","id":"root","node":{"type":"text","id":"root","text":"x"}}]""")
    assertEquals("ops[0].id: The root cannot be replaced: use show", results.last().error)
    assertSame(before, runtime.current)
    patch(
      """[{"op":"replaceNode","id":"absent","node":{"type":"text","id":"absent","text":"x"}}]""",
    )
    assertEquals("ops[0].id: Unknown node id", results.last().error)
    assertSame(before, runtime.current)
  }

  @Test
  fun `interactions advance once for several keys but noops and pages do not and reshow continues`() =
    runTest {
      val runtime = show()
      val revision = runtime.current.revision
      controller.interact(runtime, PrototypeInteraction.SetTime("hour", "minute", 3, 4))
      assertEquals(revision + 1, runtime.current.revision)
      assertEquals(revision + 1, runtime.current.stateRevisions["hour"])
      assertEquals(revision + 1, runtime.current.stateRevisions["minute"])
      controller.interact(runtime, PrototypeInteraction.SetTime("hour", "minute", 3, 4))
      controller.interact(runtime, PrototypeInteraction.SettledPage("pager", 1))
      assertEquals(revision + 1, runtime.current.revision)
      controller.interact(
        runtime,
        PrototypeInteraction.Toggle(
          "enabled",
          listOf(PrototypeSetStateAction("query", PrototypeScalar.Text("action"))),
        ),
      )
      assertEquals(revision + 2, runtime.current.revision)
      assertEquals(revision + 2, runtime.current.stateRevisions["query"])
      controller.show("reshow", spec)
      val shown = checkNotNull(controller.activeRuntime).current
      assertEquals(revision + 3, shown.revision)
      assertEquals(shown.state.keys.associateWith { shown.revision }, shown.stateRevisions)
      assertNull(results.last().revision)
    }

  @Test
  fun `a key changed then restored by one interaction still receives one revision stamp`() =
    runTest {
      val runtime = show()
      val revision = runtime.current.revision
      controller.interact(
        runtime,
        PrototypeInteraction.Toggle(
          "enabled",
          listOf(PrototypeSetStateAction("enabled", PrototypeScalar.BooleanValue(false))),
        ),
      )
      assertEquals(PrototypeScalar.BooleanValue(false), runtime.current.state["enabled"])
      assertEquals(revision + 1, runtime.current.revision)
      assertEquals(revision + 1, runtime.current.stateRevisions["enabled"])
      patch("""[{"op":"replace","path":"/state/enabled","value":true}]""", revision)
      assertEquals(
        PrototypePatchConflict(
          revision + 1,
          mapOf("enabled" to PrototypeScalar.BooleanValue(false)),
        ),
        results.last().conflict,
      )
    }

  @Test
  fun `removed keys retain conflict stamps and conflicts omit their absent values`() = runTest {
    val runtime = show()
    val base = runtime.current.revision
    patch("""[{"op":"add","path":"/state/extra","value":1}]""", base)
    val added = runtime.current.revision
    patch("""[{"op":"remove","path":"/state/extra"}]""", added)
    val removed = runtime.current.revision
    assertEquals(removed, runtime.current.stateRevisions["extra"])
    val before = runtime.current
    patch("""[{"op":"add","path":"/state/extra","value":2}]""", added)
    assertEquals(PrototypePatchConflict(removed, emptyMap()), results.last().conflict)
    assertSame(before, runtime.current)
    assertEquals(1, events.count { it.name == "change" })
  }

  @Test
  fun `destroyed controller refuses patches before looking up the id`() = runTest {
    show()
    controller.destroy()
    patch("""[{"op":"replace","path":"/data/title","value":"new"}]""", id = "other")
    assertFalse(results.last().success)
    assertEquals("Prototype host destroyed", results.last().error)
    assertNull(results.last().revision)
  }

  @Test
  fun `a committed patch remains successful when change delivery throws`() = runTest {
    val throwing =
      PrototypeController(
        FakePrototypeHost(),
        resultSink,
        eventSink = PrototypeEventSink { error("sink failed") },
        clock = { 42L },
        lifecycle = PrototypeLifecycle(FakePrototypeTimer()),
      )
    throwing.show("show", spec)
    val runtime = checkNotNull(throwing.activeRuntime)
    val revision = runtime.current.revision
    throwing.patch(
      "patch",
      "panel",
      revision,
      ops("""[{"op":"replace","path":"/state/query","value":"committed"}]"""),
    )
    assertTrue(results.last().success)
    assertEquals(revision + 1, results.last().revision)
    assertEquals(PrototypeScalar.Text("committed"), runtime.current.state["query"])
  }

  @Test
  fun `focus sync failure after committing a node patch still reports applied`() = runTest {
    val throwingHost =
      object : PrototypeHost by host {
        override suspend fun setTextFieldVisible(visible: Boolean): Boolean = error("focus failed")
      }
    val throwing =
      PrototypeController(
        throwingHost,
        resultSink,
        clock = { 42L },
        lifecycle = PrototypeLifecycle(FakePrototypeTimer()),
      )
    val fieldSpec =
      spec.copy(
        root =
          PrototypeColumnNode(
            children = listOf(PrototypeTextFieldNode(id = "field", stateKey = "query")),
          ),
      )
    throwing.show("show", fieldSpec)
    val runtime = checkNotNull(throwing.activeRuntime)
    val revision = runtime.current.revision
    throwing.patch(
      "patch",
      "panel",
      null,
      ops(
        """[{"op":"replaceNode","id":"field","node":{"type":"text","id":"field","text":"committed"}}]""",
      ),
    )
    assertTrue(results.last().success)
    assertEquals(revision + 1, results.last().revision)
    assertEquals("committed", runtime.renderModel().root.children.single().text)
    assertTrue(host.calls.none { it == "replace" })
  }

  @Test
  fun `unknown and absent prototypes return no revision`() = runTest {
    patch("""[{"op":"replace","path":"/data/title","value":"new"}]""")
    assertEquals("Unknown prototype id: panel", results.last().error)
    assertNull(results.last().revision)
    show()
    patch("""[{"op":"replace","path":"/data/title","value":"new"}]""", id = "other")
    assertEquals("Unknown prototype id: other", results.last().error)
    assertNull(results.last().revision)
    assertNull(results.last().conflict)
  }
}

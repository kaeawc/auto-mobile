package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.ctrlproxy.CtrlProxyMessageHandler
import dev.jasonpearson.automobile.ctrlproxy.NoOpCtrlProxyActions
import dev.jasonpearson.automobile.ctrlproxy.prototypeResultFrame
import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class PrototypeControllerTest {
  private val host = FakePrototypeHost()
  private val events = mutableListOf<PrototypeEvent>()
  private var connected = true
  private val results = mutableListOf<PrototypeResult>()
  private val json = Json { ignoreUnknownKeys = true }
  private var dismissed = 0
  private val models = mutableListOf<PrototypeRenderModel>()
  private val controller =
    PrototypeController(
      host,
      PrototypeResultSink { id, success, error ->
        results +=
          json.decodeFromString<WebSocketResponse>(prototypeResultFrame(id, success, error))
            as PrototypeResult
      },
      onDismissed = { dismissed++ },
      eventSink = PrototypeEventSink { if (connected) events += it },
      clock = { 42L },
      lifecycle = PrototypeLifecycle(FakePrototypeTimer()),
      render = { spec ->
        mapPrototypeSpec(spec).also { models += it }.request()
      },
    )

  private fun spec(id: String = "panel") =
    PrototypeSpec(
      id,
      PrototypeWindow(PrototypeFullscreenPlacement()),
      root = PrototypeTextNode(text = "{name}"),
    )

  private fun assertResult(id: String, success: Boolean, error: String? = null) {
    assertEquals(id, results.last().requestId)
    assertEquals(success, results.last().success)
    if (error != null)
      assertTrue(results.last().error.orEmpty(), results.last().error.orEmpty().contains(error))
  }

  @Test
  fun `show same-id show and dismiss dispatch through the real message handler`() = runTest {
    val actions =
      object : NoOpCtrlProxyActions() {
        override fun showPrototype(
          requestId: String?,
          spec: PrototypeSpec,
          displayId: Int?,
          reset: Boolean,
          appearance: PrototypeAppearanceOverride?,
        ) {
          launch { controller.show(requestId, spec, displayId, reset, appearance) }
        }

        override fun dismissPrototype(requestId: String?, id: String?, all: Boolean?) {
          launch { controller.dismiss(requestId, id, all) }
        }
      }
    val handler = CtrlProxyMessageHandler(actions)
    suspend fun dispatch(request: WebSocketRequest) {
      assertNull(handler.handleMessage(request))
      runCurrent()
    }
    dispatch(ShowPrototype(requestId = "show", spec = spec()))
    assertResult("show", true)
    assertEquals(listOf("show"), host.calls)
    dispatch(
      ShowPrototype(
        requestId = "spec",
        spec =
          spec()
            .copy(
              window = PrototypeWindow(PrototypeFullscreenPlacement(), 30),
              state = mapOf("name" to PrototypeScalar.Text("Jason")),
            ),
      ),
    )
    assertResult("spec", true)
    assertEquals(30, host.requests.last().opacityPercent)
    assertEquals("Jason", models.last().root.text)
    dispatch(ShowPrototype(requestId = "reset", spec = spec(), reset = true))
    assertResult("reset", true)
    assertEquals(listOf("show", "replace", "replace"), host.calls)
    dispatch(DismissPrototype(requestId = "dismiss", id = "panel"))
    assertResult("dismiss", true)
    assertEquals(1, dismissed)
    dispatch(DismissPrototype(requestId = "all", all = true))
    assertResult("all", true)
    assertEquals(5, results.size)
  }

  @Test
  fun `invalid show preserves prior prototype and names JSON path`() = runTest {
    controller.show("first", spec())
    controller.show(
      "bad",
      spec().copy(root = PrototypeTextNode(text = "text", style = PrototypeStyle(alpha = 2.0))),
    )
    assertResult("bad", false, "root.style.alpha")
    assertEquals(listOf("show"), host.calls)
    controller.dismiss("still-active", "panel", null)
    assertResult("still-active", true)
  }

  @Test
  fun `unknown ids and an invalid same-id replacement never mutate host`() = runTest {
    controller.dismiss("missing", "missing", null)
    assertResult("missing", false, "Unknown prototype id")
    controller.show("show", spec())
    val runtime = controller.activeRuntime
    controller.show(
      "invalid",
      spec().copy(window = PrototypeWindow(PrototypeFullscreenPlacement(), 101)),
    )
    assertResult("invalid", false, "window.opacity")
    assertEquals(listOf("show"), host.calls)
    assertSame(runtime, controller.activeRuntime)
  }

  @Test
  fun `show new id replaces and forgets old id`() = runTest {
    controller.show("one", spec())
    controller.show("two", spec("new"))
    assertResult("two", true)
    assertEquals(listOf("show", "replace"), host.calls)
    controller.dismiss("old", "panel", null)
    assertResult("old", false, "Unknown prototype id")
    controller.dismiss("new", "new", null)
    assertResult("new", true)
  }

  @Test
  fun `a same-id show takes the new spec's state and drops values the user changed`() = runTest {
    val toggle = PrototypeSetStateAction("name", PrototypeScalar.Text("tapped"))
    controller.show(
      "show",
      spec()
        .copy(
          state = mapOf("name" to PrototypeScalar.Text("old")),
          root = PrototypeTextNode(text = "{name} {count}", onTap = listOf(toggle)),
        ),
    )
    controller.interact(
      checkNotNull(controller.activeRuntime),
      PrototypeInteraction.Tap(listOf(toggle)),
    )
    assertEquals(
      PrototypeScalar.Text("tapped"),
      controller.activeRuntime?.current?.state?.get("name"),
    )
    controller.show(
      "again",
      spec()
        .copy(
          state = mapOf("count" to PrototypeScalar.Numeric(2.0)),
          root = PrototypeTextNode(text = "{name} {count}"),
        ),
    )
    assertResult("again", true)
    assertEquals(
      mapOf("count" to PrototypeScalar.Numeric(2.0)),
      controller.activeRuntime?.current?.state,
    )
    controller.show(
      "invalid-key",
      spec().copy(state = mapOf("bad-key" to PrototypeScalar.Text("bad"))),
    )
    assertResult("invalid-key", false, "state[\"bad-key\"]")
    assertEquals(listOf("show", "replace"), host.calls)
  }

  @Test
  fun `host rejection and exceptions are typed failures and do not install an id`() = runTest {
    host.accept = false
    controller.show("rejected", spec())
    assertResult("rejected", false, "failed to render")
    host.accept = true
    host.failure = IllegalStateException("broken window")
    controller.show("thrown", spec())
    assertResult("thrown", false, "broken window")
    host.failure = null
    controller.dismiss("not-installed", "panel", null)
    assertResult("not-installed", false, "Unknown prototype id")
  }

  @Test
  fun `failed replacement and dismissal retain the prior active id`() = runTest {
    controller.show("show", spec())
    host.accept = false
    controller.show("replace", spec("new"))
    assertResult("replace", false)
    controller.dismiss("dismiss-failed", "panel", null)
    assertResult("dismiss-failed", false, "failed to dismiss")
    host.accept = true
    controller.dismiss("old-id", "panel", null)
    assertResult("old-id", true)
  }

  @Test
  fun `cancellation propagates and teardown is terminal`() = runTest {
    host.failure = CancellationException("cancelled")
    try {
      controller.show("cancel", spec())
      fail("Cancellation must propagate")
    } catch (expected: CancellationException) {
      assertEquals("cancelled", expected.message)
    }
    assertTrue(results.isEmpty())
    host.failure = null
    controller.destroy()
    assertEquals(listOf("show", "destroy"), host.calls)
    controller.show("late", spec())
    assertResult("late", false, "destroyed")
  }

  @Test
  fun `render failure returns typed failure before touching the host`() = runTest {
    val failing =
      PrototypeController(
        host,
        PrototypeResultSink { id, success, error ->
          results += PrototypeResult(0, id, success, error)
        },
        lifecycle = PrototypeLifecycle(FakePrototypeTimer()),
        render = { error("render broke") },
      )
    failing.show("render", spec())
    assertResult("render", false, "render broke")
    assertTrue(host.calls.isEmpty())
  }

  @Test
  fun `a same-id show keeps pager pages clamped and continues the sequence`() = runTest {
    val tree =
      PrototypePagerNode(
        "pager",
        children = List(4) { PrototypeTextNode(text = "{page}/{pageCount} {name}") },
      )
    controller.show("show", spec().copy(root = tree))
    val runtime = checkNotNull(controller.activeRuntime)
    controller.interact(runtime, PrototypeInteraction.SettledPage("pager", 2))
    controller.show("again", spec().copy(root = tree))
    val same = checkNotNull(controller.activeRuntime)
    assertEquals(2, same.current.pages["pager"])
    assertNotSame(runtime, same)
    controller.interact(same, PrototypeInteraction.Tap(listOf(PrototypeEmitAction("kept"))))
    controller.show("shrink", spec().copy(root = tree.copy(children = tree.children.take(2))))
    val replaced = checkNotNull(controller.activeRuntime)
    assertEquals(1, replaced.current.pages["pager"])
    assertFalse(runtime.current.active)
    assertFalse(same.current.active)
    controller.interact(same, PrototypeInteraction.Tap(listOf(PrototypeEmitAction("stale"))))
    controller.interact(replaced, PrototypeInteraction.Tap(listOf(PrototypeEmitAction("current"))))
    assertEquals(listOf(1L, 2L, 3L), events.map { it.sequence })
    assertEquals(listOf("show", "replace", "replace"), host.calls)
  }

  @Test
  fun `reset starts a same-id show fresh while another id never keeps pages`() = runTest {
    val tree = PrototypePagerNode("pager", children = List(3) { PrototypeTextNode(text = "page") })
    controller.show("show", spec().copy(root = tree))
    controller.interact(
      checkNotNull(controller.activeRuntime),
      PrototypeInteraction.SettledPage("pager", 2),
    )
    controller.show("reset", spec().copy(root = tree), reset = true)
    assertResult("reset", true)
    assertEquals(0, controller.activeRuntime?.current?.pages?.get("pager"))
    controller.interact(
      checkNotNull(controller.activeRuntime),
      PrototypeInteraction.SettledPage("pager", 1),
    )
    controller.show("other", spec("other").copy(root = tree))
    assertEquals(0, controller.activeRuntime?.current?.pages?.get("pager"))
  }

  @Test
  fun `same id re-show continues sequence new ids start at one and returning ids continue`() =
    runTest {
      suspend fun emit() {
        controller.interact(
          checkNotNull(controller.activeRuntime),
          PrototypeInteraction.Tap(listOf(PrototypeEmitAction("event"))),
        )
      }
      controller.show("show", spec())
      emit()
      connected = false
      emit()
      connected = true
      controller.show("same", spec())
      emit()
      controller.dismiss("dismiss", "panel", null)
      controller.show("other", spec("other"))
      emit()
      controller.show("return", spec())
      emit()
      assertEquals(listOf("panel", "panel", "panel", "other", "panel"), events.map { it.id })
      assertEquals(listOf(1L, 3L, 4L, 1L, 5L), events.map { it.sequence })
    }

  @Test
  fun `action and protocol dismiss use same host path and suppress late interactions`() = runTest {
    controller.show("show", spec())
    val runtime = checkNotNull(controller.activeRuntime)
    controller.interact(
      runtime,
      PrototypeInteraction.Tap(listOf(PrototypeDismissAction, PrototypeEmitAction("late"))),
    )
    assertEquals(listOf("show", "dismiss"), host.calls)
    assertEquals(PrototypeEventKind.DISMISSED, events.single().kind)
    assertNull(controller.activeRuntime)
    controller.interact(runtime, PrototypeInteraction.SettledPage("pager", 1))
    controller.show("again", spec())
    controller.dismiss("dismiss", "panel", null)
    assertEquals(listOf(1L, 2L), events.map { it.sequence })
    controller.destroy()
    controller.interact(runtime, PrototypeInteraction.Tap(listOf(PrototypeEmitAction("late"))))
    assertEquals(2, events.size)
  }

  @Test
  fun `destroy emits teardown and is terminal even when host removal fails and text fields control focusability`() =
    runTest {
      controller.show(
        "show",
        spec()
          .copy(
            root = PrototypeScrollNode(child = PrototypeTextFieldNode(stateKey = "query")),
            state = mapOf("query" to PrototypeScalar.Text("")),
          ),
      )
      assertTrue(host.requests.last().hasTextField)
      val runtime = checkNotNull(controller.activeRuntime)
      controller.interact(runtime, PrototypeInteraction.TextChange("query", "typed"))
      assertEquals(1, events.size)
      host.accept = false
      controller.destroy()
      assertFalse(runtime.current.active)
      controller.interact(runtime, PrototypeInteraction.TextChange("query", "late"))
      assertEquals(2, events.size)
      assertEquals(Json.parseToJsonElement("""{"reason":"teardown"}"""), events.last().payload)
      assertEquals("typed", (runtime.current.state["query"] as PrototypeScalar.Text).value)
    }

  @Test
  fun `typed scalar dimension and integer fields round trip exactly`() {
    val original =
      spec()
        .copy(
          state =
            mapOf(
              "name" to PrototypeScalar.Text("text"),
              "n" to PrototypeScalar.Numeric(2.5),
              "b" to PrototypeScalar.BooleanValue(false),
            ),
          root =
            PrototypeTextNode(
              text = "text",
              style =
                PrototypeStyle(
                  width = PrototypeDimension.Dp(1.25),
                  height = PrototypeDimension.Wrap,
                  fontWeight = 700,
                  maxLines = 2,
                ),
            ),
        )
    val validation =
      PrototypeSpecValidator.validate(json.encodeToString(original))
        as PrototypeSpecValidation.Success
    assertEquals(original, validation.spec)
  }
}

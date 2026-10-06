package dev.jasonpearson.automobile.ctrlproxy.overlay

import dev.jasonpearson.automobile.ctrlproxy.CtrlProxyMessageHandler
import dev.jasonpearson.automobile.ctrlproxy.NoOpCtrlProxyActions
import dev.jasonpearson.automobile.ctrlproxy.overlayResultFrame
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
class OverlayControllerTest {
  private val host = FakeInteractiveOverlayHost()
  private val events = mutableListOf<OverlayEvent>()
  private var connected = true
  private val results = mutableListOf<OverlayResult>()
  private val json = Json { ignoreUnknownKeys = true }
  private var dismissed = 0
  private val models = mutableListOf<OverlayRenderModel>()
  private val controller =
    OverlayController(
      host,
      OverlayResultSink { id, success, error ->
        results +=
          json.decodeFromString<WebSocketResponse>(overlayResultFrame(id, success, error))
            as OverlayResult
      },
      onDismissed = { dismissed++ },
      eventSink = OverlayEventSink { if (connected) events += it },
      clock = { 42L },
      lifecycle = OverlayLifecycle(FakeOverlayTimer()),
      render = { spec ->
        mapOverlaySpec(spec).also { models += it }.request()
      },
    )

  private fun spec(id: String = "panel") =
    OverlaySpec(
      id,
      OverlayWindow(OverlayFullscreenPlacement()),
      root = OverlayTextNode(text = "{name}"),
    )

  private fun assertResult(id: String, success: Boolean, error: String? = null) {
    assertEquals(id, results.last().requestId)
    assertEquals(success, results.last().success)
    if (error != null)
      assertTrue(results.last().error.orEmpty(), results.last().error.orEmpty().contains(error))
  }

  @Test
  fun `show update state and dismiss dispatch through the real message handler`() = runTest {
    val actions =
      object : NoOpCtrlProxyActions() {
        override fun showOverlay(requestId: String?, spec: OverlaySpec, displayId: Int?) {
          launch { controller.show(requestId, spec, displayId) }
        }

        override fun updateOverlay(
          requestId: String?,
          id: String,
          spec: OverlaySpec?,
          state: Map<String, OverlayScalar>?,
        ) {
          launch { controller.update(requestId, id, spec, state) }
        }

        override fun dismissOverlay(requestId: String?, id: String?, all: Boolean?) {
          launch { controller.dismiss(requestId, id, all) }
        }
      }
    val handler = CtrlProxyMessageHandler(actions)
    suspend fun dispatch(request: WebSocketRequest) {
      assertNull(handler.handleMessage(request))
      runCurrent()
    }
    dispatch(ShowOverlay(requestId = "show", spec = spec()))
    assertResult("show", true)
    assertEquals(listOf("show"), host.calls)
    dispatch(
      UpdateOverlay(
        requestId = "spec",
        id = "panel",
        spec = spec().copy(window = OverlayWindow(OverlayFullscreenPlacement(), 30)),
      )
    )
    assertResult("spec", true)
    assertEquals(30, host.requests.last().opacityPercent)
    dispatch(
      UpdateOverlay(
        requestId = "state",
        id = "panel",
        state = mapOf("name" to OverlayScalar.Text("Jason")),
      )
    )
    assertResult("state", true)
    assertEquals("Jason", models.last().root.text)
    assertEquals(listOf("show", "replace"), host.calls)
    dispatch(DismissOverlay(requestId = "dismiss", id = "panel"))
    assertResult("dismiss", true)
    assertEquals(1, dismissed)
    dispatch(DismissOverlay(requestId = "all", all = true))
    assertResult("all", true)
    assertEquals(5, results.size)
  }

  @Test
  fun `invalid show preserves prior overlay and names JSON path`() = runTest {
    controller.show("first", spec())
    controller.show(
      "bad",
      spec().copy(root = OverlayTextNode(text = "text", style = OverlayStyle(alpha = 2.0))),
    )
    assertResult("bad", false, "root.style.alpha")
    assertEquals(listOf("show"), host.calls)
    controller.update("still-active", "panel", null, mapOf("name" to OverlayScalar.Text("updated")))
    assertResult("still-active", true)
  }

  @Test
  fun `unknown ids mismatch and invalid replacement never mutate host`() = runTest {
    controller.update("unknown", "missing", spec(), null)
    assertResult("unknown", false, "Unknown overlay id")
    controller.dismiss("missing", "missing", null)
    assertResult("missing", false, "Unknown overlay id")
    controller.show("show", spec())
    controller.update("mismatch", "panel", spec("other"), null)
    assertResult("mismatch", false, "spec.id")
    controller.update(
      "invalid",
      "panel",
      spec().copy(window = OverlayWindow(OverlayFullscreenPlacement(), 101)),
      null,
    )
    assertResult("invalid", false, "window.opacity")
    assertEquals(listOf("show"), host.calls)
  }

  @Test
  fun `show new id replaces and forgets old id`() = runTest {
    controller.show("one", spec())
    controller.show("two", spec("new"))
    assertResult("two", true)
    assertEquals(listOf("show", "replace"), host.calls)
    controller.dismiss("old", "panel", null)
    assertResult("old", false, "Unknown overlay id")
    controller.dismiss("new", "new", null)
    assertResult("new", true)
  }

  @Test
  fun `patch merges scalars adds valid keys and rejects invalid keys with canonical path`() =
    runTest {
      controller.show(
        "show",
        spec()
          .copy(
            state = mapOf("name" to OverlayScalar.Text("old")),
            root = OverlayTextNode(text = "{name} {count} {enabled}"),
          ),
      )
      controller.update(
        "patch",
        "panel",
        null,
        mapOf("count" to OverlayScalar.Numeric(2.0), "enabled" to OverlayScalar.BooleanValue(true)),
      )
      assertResult("patch", true)
      assertEquals("old 2 true", models.last().root.text)
      controller.update("invalid-key", "panel", null, mapOf("bad-key" to OverlayScalar.Text("bad")))
      assertResult("invalid-key", false, "state[\"bad-key\"]")
      assertEquals(listOf("show"), host.calls)
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
    assertResult("not-installed", false, "Unknown overlay id")
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
    controller.update("old-id", "panel", spec(), null)
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
      OverlayController(
        host,
        OverlayResultSink { id, success, error ->
          results += OverlayResult(0, id, success, error)
        },
        lifecycle = OverlayLifecycle(FakeOverlayTimer()),
        render = { error("render broke") },
      )
    failing.show("render", spec())
    assertResult("render", false, "render broke")
    assertTrue(host.calls.isEmpty())
  }

  @Test
  fun `controller patch keeps runtime pages composition and sequence while full spec clamps pages`() =
    runTest {
      val tree =
        OverlayPagerNode(
          "pager",
          children = List(3) { OverlayTextNode(text = "{page}/{pageCount} {name}") },
        )
      controller.show("show", spec().copy(root = tree))
      val runtime = checkNotNull(controller.activeRuntime)
      controller.interact(runtime, OverlayInteraction.SettledPage("pager", 2))
      val request = host.requests.single()
      controller.update("patch", "panel", null, mapOf("name" to OverlayScalar.Text("patch")))
      assertSame(runtime, controller.activeRuntime)
      assertSame(request, host.requests.single())
      assertEquals(2, runtime.current.pages["pager"])
      assertEquals(
        "3/3 patch",
        mapOverlaySpec(runtime.current.spec, runtime.current.pages).root.children.first().text,
      )
      controller.interact(runtime, OverlayInteraction.Tap(listOf(OverlayEmitAction("patched"))))
      controller.update(
        "replace",
        "panel",
        spec().copy(root = tree.copy(children = tree.children.take(2))),
        null,
      )
      val replaced = checkNotNull(controller.activeRuntime)
      assertEquals(1, replaced.current.pages["pager"])
      assertFalse(runtime.current.active)
      controller.interact(runtime, OverlayInteraction.Tap(listOf(OverlayEmitAction("stale"))))
      controller.interact(replaced, OverlayInteraction.Tap(listOf(OverlayEmitAction("current"))))
      assertEquals(listOf(1L, 2L, 3L), events.map { it.sequence })
    }

  @Test
  fun `same id re-show continues sequence new ids start at one and returning ids continue`() =
    runTest {
      suspend fun emit() {
        controller.interact(
          checkNotNull(controller.activeRuntime),
          OverlayInteraction.Tap(listOf(OverlayEmitAction("event"))),
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
      OverlayInteraction.Tap(listOf(OverlayDismissAction, OverlayEmitAction("late"))),
    )
    assertEquals(listOf("show", "dismiss"), host.calls)
    assertEquals(OverlayEventKind.DISMISSED, events.single().kind)
    assertNull(controller.activeRuntime)
    controller.interact(runtime, OverlayInteraction.SettledPage("pager", 1))
    controller.show("again", spec())
    controller.dismiss("dismiss", "panel", null)
    assertEquals(listOf(1L, 2L), events.map { it.sequence })
    controller.destroy()
    controller.interact(runtime, OverlayInteraction.Tap(listOf(OverlayEmitAction("late"))))
    assertEquals(2, events.size)
  }

  @Test
  fun `destroy emits teardown and is terminal even when host removal fails and text fields control focusability`() =
    runTest {
      controller.show(
        "show",
        spec()
          .copy(
            root = OverlayScrollNode(child = OverlayTextFieldNode(stateKey = "query")),
            state = mapOf("query" to OverlayScalar.Text("")),
          ),
      )
      assertTrue(host.requests.last().hasTextField)
      val runtime = checkNotNull(controller.activeRuntime)
      controller.interact(runtime, OverlayInteraction.TextChange("query", "typed"))
      assertEquals(1, events.size)
      host.accept = false
      controller.destroy()
      assertFalse(runtime.current.active)
      controller.interact(runtime, OverlayInteraction.TextChange("query", "late"))
      assertEquals(2, events.size)
      assertEquals(Json.parseToJsonElement("""{"reason":"teardown"}"""), events.last().payload)
      assertEquals("typed", (runtime.current.state["query"] as OverlayScalar.Text).value)
    }

  @Test
  fun `typed scalar dimension and integer fields round trip exactly`() {
    val original =
      spec()
        .copy(
          state =
            mapOf(
              "name" to OverlayScalar.Text("text"),
              "n" to OverlayScalar.Numeric(2.5),
              "b" to OverlayScalar.BooleanValue(false),
            ),
          root =
            OverlayTextNode(
              text = "text",
              style =
                OverlayStyle(
                  width = OverlayDimension.Dp(1.25),
                  height = OverlayDimension.Wrap,
                  fontWeight = 700,
                  maxLines = 2,
                ),
            ),
        )
    val validation =
      OverlaySpecValidator.validate(json.encodeToString(original)) as OverlaySpecValidation.Success
    assertEquals(original, validation.spec)
  }
}

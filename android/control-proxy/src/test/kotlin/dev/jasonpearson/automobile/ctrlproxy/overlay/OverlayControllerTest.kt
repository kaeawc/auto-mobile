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
        override fun showOverlay(requestId: String?, spec: OverlaySpec) {
          launch { controller.show(requestId, spec) }
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
    assertEquals(listOf("show", "replace", "replace"), host.calls)
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
        render = { error("render broke") },
      )
    failing.show("render", spec())
    assertResult("render", false, "render broke")
    assertTrue(host.calls.isEmpty())
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

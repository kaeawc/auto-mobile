package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.view.KeyEvent
import dev.jasonpearson.automobile.ctrlproxy.CtrlProxyMessageHandler
import dev.jasonpearson.automobile.ctrlproxy.NoOpCtrlProxyActions
import dev.jasonpearson.automobile.ctrlproxy.prototypeResultFrame
import dev.jasonpearson.automobile.ctrlproxy.prototypeStatusFrame
import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class PrototypeControllerTest {
  private val originalTraceSink = PrototypeTrace.sink

  @After
  fun restoreTraceSink() {
    PrototypeTrace.sink = originalTraceSink
  }

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

  private class HiddenFixture {
    val host = FakePrototypeHost()
    val shown = mutableListOf<PrototypeHiddenReason?>()
    val statuses = mutableListOf<PrototypeStatusEntry>()
    val probes = mutableListOf<Int>()
    val delays = mutableListOf<Long>()
    var blocked = false
    var suspended = false
    var onScreen: (Int) -> Boolean? = { false }
    var wait: suspend (Long) -> Unit = { delays += it }
    val controller =
      PrototypeController(
        host,
        object : PrototypeResultSink {
          override suspend fun send(requestId: String?, success: Boolean, error: String?) {
            check(success) { error.orEmpty() }
          }

          override suspend fun sendShown(
            requestId: String?,
            missingAssets: List<String>,
            appearance: PrototypeAppearance,
            hiddenReason: PrototypeHiddenReason?,
          ) {
            shown += hiddenReason
          }

          override suspend fun sendPrototypeStatus(
            requestId: String?,
            prototypes: List<PrototypeStatusEntry>,
            droppedEvents: Long,
          ) {
            statuses.addAll(prototypes)
          }
        },
        lifecycle = PrototypeLifecycle(FakePrototypeTimer(), isBlocked = { blocked }),
        foreground =
          object : PrototypeForegroundScope {
            override val suspended: Boolean
              get() = this@HiddenFixture.suspended

            override fun anchor() = Unit

            override fun release() = Unit
          },
        windowOnScreen =
          PrototypeWindowOnScreen { displayId ->
            probes += displayId
            onScreen(probes.size)
          },
        settle = { wait(it) },
      )

    suspend fun show(layer: String = "app", displayId: Int = 0, reset: Boolean = false) {
      controller.show(
        "show",
        PrototypeSpec(
          "panel",
          PrototypeWindow(PrototypeFullscreenPlacement(), layer = layer),
          root = PrototypeTextNode(text = "Panel"),
        ),
        displayId = displayId,
        reset = reset,
      )
    }
  }

  @Test
  fun `window probe reads only titled candidates and preserves unknown`() {
    val ownPackage = "dev.jasonpearson.automobile.ctrlproxy"
    val reads = mutableListOf<String?>()
    fun probe(windows: List<Triple<Int, String, String?>>?): Boolean? =
      prototypeWindowOnScreen(
        windows,
        hasTitle = { hasPrototypeTitle(it.first, it.second) },
        rootPackage = {
          reads += it.third
          it.third
        },
        ownPackage = ownPackage,
      )
    val type = android.view.accessibility.AccessibilityWindowInfo.TYPE_SYSTEM
    assertNull(probe(null))
    assertNull(probe(listOf(Triple(type, PROTOTYPE_WINDOW_TITLE, null))))
    assertEquals(true, probe(listOf(Triple(type, PROTOTYPE_WINDOW_TITLE, ownPackage))))
    reads.clear()
    assertEquals(false, probe(listOf(Triple(type, "Highlight", ownPackage))))
    assertEquals(false, probe(listOf(Triple(1, PROTOTYPE_WINDOW_TITLE, ownPackage))))
    assertTrue(reads.isEmpty())
    assertEquals(false, probe(listOf(Triple(type, PROTOTYPE_WINDOW_TITLE, "other.app"))))
  }

  @Test
  fun `inspect uses bounded confirmation and stops at visible or unknown`() = runTest {
    for (result in listOf(true, false, null)) {
      val fixture = HiddenFixture()
      fixture.onScreen = { true }
      fixture.show()
      fixture.probes.clear()
      fixture.delays.clear()
      fixture.onScreen = { attempt -> if (result == true && attempt < 3) false else result }
      fixture.controller.inspect("inspect")
      val expectedProbes =
        when (result) {
          true -> 3
          false -> 5
          null -> 1
        }
      assertEquals(List(expectedProbes) { 0 }, fixture.probes)
      assertEquals(List(expectedProbes - 1) { 100L }, fixture.delays)
      assertEquals(
        if (result == false) PrototypeHiddenReason.APP_LAYER_WINDOW_HIDDEN else null,
        fixture.statuses.single().hiddenReason,
      )
    }
  }

  @Test
  fun `hidden decision distinguishes runtime layer display capture block and suspension`() =
    runTest {
      val fixture = HiddenFixture()
      val controller = fixture.controller
      assertNull(controller.hiddenReason(0, false))
      fixture.show(displayId = 2)
      assertEquals(PrototypeHiddenReason.APP_LAYER_WINDOW_HIDDEN, controller.hiddenReason(2, false))
      assertNull(controller.hiddenReason(0, false))
      assertNull(controller.hiddenReason(2, null))
      assertNull(controller.hiddenReason(2, true))
      fixture.host.isHiddenForCapture = true
      assertNull(controller.hiddenReason(2, false))
      fixture.host.isHiddenForCapture = false
      fixture.blocked = true
      assertEquals(PrototypeHiddenReason.DEVICE_BLOCKED, controller.hiddenReason(0, null))
      fixture.suspended = true
      assertNull(controller.hiddenReason(2, false))
      fixture.suspended = false
      fixture.blocked = false
      fixture.show(layer = "system")
      assertNull(controller.hiddenReason(2, false))
      fixture.blocked = true
      assertEquals(PrototypeHiddenReason.DEVICE_BLOCKED, controller.hiddenReason(2, false))
    }

  @Test
  fun `app show confirms five absent windows using four injected waits`() = runTest {
    val fixture = HiddenFixture()
    fixture.show()
    assertEquals(listOf(0, 0, 0, 0, 0), fixture.probes)
    assertEquals(listOf(100L, 100L, 100L, 100L), fixture.delays)
    assertEquals(listOf(PrototypeHiddenReason.APP_LAYER_WINDOW_HIDDEN), fixture.shown)
    // In-place and fresh replacement replies use the same confirmation path.
    fixture.show()
    assertEquals(10, fixture.probes.size)
    assertEquals(PrototypeHiddenReason.APP_LAYER_WINDOW_HIDDEN, fixture.shown.last())
    fixture.show(reset = true)
    assertEquals(15, fixture.probes.size)
    assertEquals(PrototypeHiddenReason.APP_LAYER_WINDOW_HIDDEN, fixture.shown.last())
  }

  @Test
  fun `show stops probing at visible or unknown and skips system and blocked windows`() = runTest {
    val visible = HiddenFixture()
    visible.onScreen = { it == 2 }
    visible.show()
    assertEquals(2, visible.probes.size)
    assertEquals(listOf(100L), visible.delays)
    assertNull(visible.shown.single())
    val unknown = HiddenFixture()
    unknown.onScreen = { null }
    unknown.show()
    assertEquals(1, unknown.probes.size)
    assertTrue(unknown.delays.isEmpty())
    assertNull(unknown.shown.single())
    val system = HiddenFixture()
    system.show("system")
    assertTrue(system.probes.isEmpty())
    assertNull(system.shown.single())
    for (layer in listOf("system", "app")) {
      val blocked = HiddenFixture()
      blocked.blocked = true
      blocked.show(layer)
      assertTrue(blocked.probes.isEmpty())
      assertTrue(blocked.delays.isEmpty())
      assertEquals(PrototypeHiddenReason.DEVICE_BLOCKED, blocked.shown.single())
    }
  }

  @Test
  fun `inspect reports hidden app window but suspension retains its own flag`() = runTest {
    val fixture = HiddenFixture()
    fixture.show()
    fixture.controller.inspect("inspect")
    assertEquals(
      PrototypeHiddenReason.APP_LAYER_WINDOW_HIDDEN,
      fixture.statuses.last().hiddenReason,
    )
    fixture.suspended = true
    fixture.controller.inspect("suspended")
    assertTrue(fixture.statuses.last().suspended)
    assertNull(fixture.statuses.last().hiddenReason)
  }

  @Test
  fun `show settle cancellation propagates without a reply`() = runTest {
    val fixture = HiddenFixture()
    fixture.wait = { throw CancellationException("cancelled") }
    try {
      fixture.show()
      fail("Expected cancellation")
    } catch (_: CancellationException) {
      assertTrue(fixture.shown.isEmpty())
      assertEquals(1, fixture.probes.size)
    }
  }

  private fun assertResult(id: String, success: Boolean, error: String? = null) {
    assertEquals(id, results.last().requestId)
    assertEquals(success, results.last().success)
    if (error != null)
      assertTrue(results.last().error.orEmpty(), results.last().error.orEmpty().contains(error))
  }

  private fun stackSpec(
    screens: Map<String, PrototypeNode> =
      linkedMapOf(
        "home" to PrototypeTextNode(text = "Home"),
        "detail" to PrototypeTextNode(text = "Detail"),
        "third" to PrototypeTextNode(text = "Third"),
      ),
    start: String = "home",
  ) = spec().copy(root = PrototypeStackNode("nav", start = start, screens = screens))

  private fun assertStackBackFocus(enabled: Boolean) {
    val request = host.requests.last()
    assertFalse(request.hasTextField)
    assertEquals(enabled, request.hasStackBack)
    assertEquals(enabled, request.focusable)
    assertEquals(enabled, checkNotNull(controller.activeRuntime).hasPoppableStack())
    assertEquals(
      if (enabled) PrototypeBackDecision.CONSUME else PrototypeBackDecision.PASS,
      prototypeBackDecision(request.focusable, KeyEvent.KEYCODE_BACK, KeyEvent.ACTION_DOWN, false),
    )
    assertEquals(
      if (enabled) PrototypeBackDecision.DISMISS else PrototypeBackDecision.PASS,
      prototypeBackDecision(request.focusable, KeyEvent.KEYCODE_BACK, KeyEvent.ACTION_UP, false),
    )
  }

  @Test
  fun `off-page stack keeps depth without taking Back and page changes release focus`() = runTest {
    val panel =
      spec()
        .copy(
          root =
            PrototypePagerNode(
              "pager",
              children = listOf(PrototypeSpacerNode(), stackSpec().root),
            ),
        )
    controller.show("show", panel)
    var runtime = checkNotNull(controller.activeRuntime)
    controller.interact(
      runtime,
      PrototypeInteraction.Tap(listOf(PrototypePushAction("nav", "detail"))),
    )
    assertEquals(2, runtime.current.stacks.getValue("nav").depth)
    assertStackBackFocus(false)
    assertFalse(runtime.popTopmostStack())
    // Retained off-page navigation must not take focus on a same-id show either.
    controller.show("same", panel)
    runtime = checkNotNull(controller.activeRuntime)
    assertEquals(2, runtime.current.stacks.getValue("nav").depth)
    assertStackBackFocus(false)
    controller.interact(runtime, PrototypeInteraction.SettledPage("pager", 1))
    assertStackBackFocus(true)
    controller.interact(runtime, PrototypeInteraction.SettledPage("pager", 0))
    assertStackBackFocus(false)
    controller.interact(runtime, PrototypeInteraction.SettledPage("pager", 1))
    checkNotNull(host.requests.last().onHostBack).invoke()
    assertEquals(1, runtime.current.stacks.getValue("nav").depth)
    assertStackBackFocus(false)
    assertTrue(controller.isShowing)
    assertEquals(0, dismissed)
  }

  @Test
  fun `hidden ancestor releases stack Back focus when visibleWhen state changes`() = runTest {
    controller.show(
      "show",
      spec()
        .copy(
          root =
            PrototypeColumnNode(
              children = listOf(stackSpec().root),
              visibleWhen = PrototypeCondition("open", PrototypeScalar.BooleanValue(true)),
            ),
          state = mapOf("open" to PrototypeScalar.BooleanValue(false)),
        ),
    )
    val runtime = checkNotNull(controller.activeRuntime)
    controller.interact(
      runtime,
      PrototypeInteraction.Tap(listOf(PrototypePushAction("nav", "detail"))),
    )
    assertEquals(2, runtime.current.stacks.getValue("nav").depth)
    assertStackBackFocus(false)
    assertFalse(runtime.popTopmostStack())
    controller.interact(
      runtime,
      PrototypeInteraction.Tap(
        listOf(PrototypeSetStateAction("open", PrototypeScalar.BooleanValue(true))),
      ),
    )
    assertStackBackFocus(true)
    controller.interact(
      runtime,
      PrototypeInteraction.Tap(
        listOf(PrototypeSetStateAction("open", PrototypeScalar.BooleanValue(false))),
      ),
    )
    assertStackBackFocus(false)
    assertEquals(2, runtime.current.stacks.getValue("nav").depth)
    assertTrue(controller.isShowing)
    assertEquals(0, dismissed)
  }

  @Test
  fun `opening and closing a modal recomputes stack Back focus`() = runTest {
    val condition = PrototypeSheetCondition("open", true)
    controller.show(
      "show",
      spec()
        .copy(
          root =
            PrototypeDialogNode(
              openWhen = condition,
              confirm = PrototypeDialogButton("OK"),
              child = stackSpec().root,
            ),
          state = mapOf("open" to PrototypeScalar.BooleanValue(false)),
        ),
    )
    val runtime = checkNotNull(controller.activeRuntime)
    controller.interact(
      runtime,
      PrototypeInteraction.Tap(listOf(PrototypePushAction("nav", "detail"))),
    )
    assertStackBackFocus(false)
    assertFalse(runtime.popTopmostStack())
    controller.interact(
      runtime,
      PrototypeInteraction.Tap(
        listOf(PrototypeSetStateAction("open", PrototypeScalar.BooleanValue(true))),
      ),
    )
    assertStackBackFocus(true)
    controller.interact(runtime, PrototypeInteraction.CloseModal(condition))
    assertStackBackFocus(false)
    assertEquals(2, runtime.current.stacks.getValue("nav").depth)
    assertTrue(controller.isShowing)
    assertEquals(0, dismissed)
  }

  @Test
  fun `re-show keeps stack paths clamps screens and reset starts fresh`() = runTest {
    controller.show("show", stackSpec())
    val first = checkNotNull(controller.activeRuntime)
    controller.interact(
      first,
      PrototypeInteraction.Tap(
        listOf(
          PrototypePushAction("nav", "detail"),
          PrototypePushAction("nav", "third"),
        ),
      ),
    )
    controller.show("same", stackSpec())
    assertEquals(
      listOf("home", "detail", "third"),
      controller.activeRuntime!!.current.stacks.getValue("nav").path,
    )
    val screens = (stackSpec().root as PrototypeStackNode).screens
    controller.show("clamp", stackSpec(screens - "detail"))
    assertEquals(
      listOf("home", "third"),
      controller.activeRuntime!!.current.stacks.getValue("nav").path,
    )
    controller.show(
      "empty-path",
      stackSpec(mapOf("detail" to screens.getValue("detail")), "detail"),
    )
    assertEquals(listOf("detail"), controller.activeRuntime!!.current.stacks.getValue("nav").path)
    controller.show("reset", stackSpec(), reset = true)
    assertEquals(listOf("home"), controller.activeRuntime!!.current.stacks.getValue("nav").path)
    assertFalse(host.requests.last().hasStackBack)
    assertEquals(2, events.size)
    assertTrue(results.all { it.success })
  }

  @Test
  fun `stack Back focuses without a field pops before dismissal and root releases Back`() =
    runTest {
      controller.show("show", stackSpec())
      val runtime = checkNotNull(controller.activeRuntime)
      assertFalse(host.requests.last().focusable)
      controller.interact(
        runtime,
        PrototypeInteraction.Tap(listOf(PrototypePushAction("nav", "detail"))),
      )
      assertTrue(host.requests.last().hasStackBack)
      assertTrue(host.requests.last().focusable)
      assertFalse(host.requests.last().hasTextField)
      checkNotNull(host.requests.last().onHostBack).invoke()
      assertTrue(controller.isShowing)
      assertEquals(1, runtime.current.stacks.getValue("nav").depth)
      assertFalse(host.requests.last().focusable)
      assertEquals(0, dismissed)
      assertEquals(
        listOf(PrototypeEventKind.SCREEN_CHANGED, PrototypeEventKind.SCREEN_CHANGED),
        events.map { it.kind },
      )
      // The close control still dismisses, regardless of a stack's depth.
      controller.interact(
        runtime,
        PrototypeInteraction.Tap(listOf(PrototypePushAction("nav", "detail"))),
      )
      host.requests.last().onHostDismiss()
      assertFalse(controller.isShowing)
      assertEquals(1, dismissed)
    }

  @Test
  fun `show results and inspect carry the same wire stack snapshot beside pages`() = runTest {
    val frames = mutableListOf<PrototypeResult>()
    fun record(frame: String) {
      frames += json.decodeFromString<WebSocketResponse>(frame) as PrototypeResult
    }
    val sink =
      object : PrototypeResultSink {
        override suspend fun send(requestId: String?, success: Boolean, error: String?) {
          record(prototypeResultFrame(requestId, success, error))
        }

        override suspend fun sendShownNavigation(
          requestId: String?,
          missingAssets: List<String>,
          appearance: PrototypeAppearance,
          pages: Map<String, Int>,
          stacks: Map<String, PrototypeStackSnapshot>,
          hiddenReason: PrototypeHiddenReason?,
        ) {
          record(
            prototypeResultFrame(
              requestId,
              true,
              null,
              missingAssets,
              appearance,
              pages,
              stacks,
              hiddenReason,
            ),
          )
        }

        override suspend fun sendPrototypeStatus(
          requestId: String?,
          prototypes: List<PrototypeStatusEntry>,
          droppedEvents: Long,
        ) {
          record(prototypeStatusFrame(requestId, prototypes, droppedEvents))
        }
      }
    val controller =
      PrototypeController(host, sink, lifecycle = PrototypeLifecycle(FakePrototypeTimer()))
    controller.show("show", stackSpec())
    assertEquals(emptyMap<String, Int>(), frames.last().pages)
    assertEquals(mapOf("nav" to PrototypeStackSnapshot(listOf("home"))), frames.last().stacks)
    val runtime = checkNotNull(controller.activeRuntime)
    controller.interact(
      runtime,
      PrototypeInteraction.Tap(listOf(PrototypePushAction("nav", "detail"))),
    )
    controller.inspect("inspect")
    val status = frames.last().prototypes!!.single()
    assertEquals(runtime.current.pages, status.pages)
    assertEquals(runtime.current.stacks, status.stacks)
    controller.show("same", stackSpec())
    assertEquals(status.stacks, frames.last().stacks)
  }

  @Test
  fun `idle configuration keeps mapping passes stable but always relayouts`() = runTest {
    val device = FakePrototypeDeviceAppearance()
    val subject =
      PrototypeController(
        host,
        PrototypeResultSink { _, _, _ -> },
        lifecycle = PrototypeLifecycle(FakePrototypeTimer()),
        deviceAppearance = device,
      )
    subject.show("show", spec())
    val runtime = checkNotNull(subject.activeRuntime)
    val passes = runtime.renderMappingPasses
    repeat(100) { subject.onConfigurationChanged() }
    assertEquals(passes, runtime.renderMappingPasses)
    assertEquals(100, host.calls.count { it == "relayout" })
  }

  @Test
  fun `configuration sync follows device palette snapshot interaction and override changes`() =
    runTest {
      val device = FakePrototypeDeviceAppearance()
      val subject =
        PrototypeController(
          host,
          PrototypeResultSink { _, _, _ -> },
          eventSink = PrototypeEventSink { events += it },
          lifecycle = PrototypeLifecycle(FakePrototypeTimer()),
          deviceAppearance = device,
        )
      val initial = spec().copy(state = mapOf("name" to PrototypeScalar.Text("old")))
      subject.show("show", initial)
      val runtime = checkNotNull(subject.activeRuntime)
      device.dark = true
      subject.onConfigurationChanged()
      repeat(100) { subject.onConfigurationChanged() }
      assertEquals(1, events.count { it.kind == PrototypeEventKind.APPEARANCE_CHANGED })
      assertTrue(checkNotNull(host.requests.last().theme).value.appearance.dark)
      device.paletteKey = 42
      subject.onConfigurationChanged()
      assertEquals(42, checkNotNull(host.requests.last().theme).value.paletteKey)
      assertEquals(1, events.count { it.kind == PrototypeEventKind.APPEARANCE_CHANGED })
      val passes = runtime.renderMappingPasses
      runtime.replace(initial.copy(state = mapOf("name" to PrototypeScalar.Text("replaced"))))
      subject.onConfigurationChanged()
      assertEquals(passes + 1, runtime.renderMappingPasses)
      subject.interact(
        runtime,
        PrototypeInteraction.Tap(
          listOf(
            PrototypeSetStateAction("name", PrototypeScalar.Text("tapped")),
          ),
        ),
      )
      assertEquals(passes + 2, runtime.renderMappingPasses)
      subject.onConfigurationChanged()
      assertEquals(passes + 2, runtime.renderMappingPasses)
      subject.show("override", initial, appearance = PrototypeAppearanceOverride.LIGHT)
      assertFalse(checkNotNull(host.requests.last().theme).value.appearance.dark)
      val replacement = checkNotNull(subject.activeRuntime)
      val replacementPasses = replacement.renderMappingPasses
      subject.onConfigurationChanged()
      assertEquals(replacementPasses, replacement.renderMappingPasses)
    }

  @Test
  fun `failed appearance sync does not retain the previous successful key`() = runTest {
    val device = FakePrototypeDeviceAppearance()
    var rejectAppearance = true
    val subject =
      PrototypeController(
        host,
        PrototypeResultSink { _, _, _ -> },
        eventSink =
          PrototypeEventSink {
            if (it.kind == PrototypeEventKind.APPEARANCE_CHANGED && rejectAppearance)
              throw IllegalStateException("Rejected appearance event")
            events += it
          },
        lifecycle = PrototypeLifecycle(FakePrototypeTimer()),
        deviceAppearance = device,
      )
    subject.show("show", spec())
    device.dark = true
    subject.onConfigurationChanged()
    assertTrue(checkNotNull(host.requests.last().theme).value.appearance.dark)
    rejectAppearance = false
    device.dark = false
    subject.onConfigurationChanged()
    assertFalse(checkNotNull(host.requests.last().theme).value.appearance.dark)
    assertEquals(1, events.count { it.kind == PrototypeEventKind.APPEARANCE_CHANGED })
    assertEquals(2, host.calls.count { it == "relayout" })
  }

  @Test
  fun `interaction traces appearance sync inside one async section and skips stale runtime`() =
    runTest {
      controller.show("show", spec())
      val runtime = checkNotNull(controller.activeRuntime)
      // Warm the cached render model before recording the interaction's own sections.
      runtime.renderModel()
      val trace = FakePrototypeTraceSink()
      PrototypeTrace.sink = trace
      controller.interact(runtime, PrototypeInteraction.Tap(emptyList()))
      val interact = trace.asyncCookies[0]
      val appearance = trace.asyncCookies[1]
      assertNotEquals(interact, appearance)
      assertEquals(
        listOf(
          "beginAsync:Prototype.interact:$interact",
          "beginAsync:Prototype.syncAppearance:$appearance",
          "endAsync:Prototype.syncAppearance:$appearance",
          "endAsync:Prototype.interact:$interact",
        ),
        trace.events,
      )
      assertTrue(trace.openSections.isEmpty())
      controller.show("replace", spec("replacement"))
      trace.events.clear()
      controller.interact(runtime, PrototypeInteraction.Tap(emptyList()))
      assertTrue(trace.events.isEmpty())
      assertTrue(trace.openSections.isEmpty())
    }

  @Test
  fun `controller applies chrome defaults and explicit overrides to the host request`() = runTest {
    val windows =
      listOf(
        PrototypeWindow(PrototypeFullscreenPlacement()) to PrototypeWindowChrome.NONE,
        PrototypeWindow(PrototypeFullscreenPlacement(), persistence = "device") to
          PrototypeWindowChrome.BAR,
        PrototypeWindow(PrototypeFullscreenPlacement(), chrome = "bar") to
          PrototypeWindowChrome.BAR,
        PrototypeWindow(PrototypeFullscreenPlacement(), persistence = "device", chrome = "none") to
          PrototypeWindowChrome.NONE,
      )
    windows.forEachIndexed { index, (window, expected) ->
      controller.show("show-$index", spec().copy(window = window))
      assertResult("show-$index", true)
      assertEquals(expected, host.requests.last().chrome)
    }
  }

  @Test
  fun `agent dismiss removes a chromeless prototype and emits agent reason`() = runTest {
    controller.show("show", spec())
    assertEquals(PrototypeWindowChrome.NONE, host.requests.last().chrome)
    controller.dismiss("dismiss", "panel", null)
    assertResult("dismiss", true)
    assertFalse(host.isShowing)
    assertEquals(listOf("show", "dismiss"), host.calls)
    assertEquals(PrototypeEventKind.DISMISSED, events.single().kind)
    assertEquals(Json.parseToJsonElement("""{"reason":"agent"}"""), events.single().payload)
  }

  @Test
  fun `chromeless escape uses host dismiss and emits user reason`() = runTest {
    controller.show("show", spec())
    assertEquals(PrototypeWindowChrome.NONE, host.requests.last().chrome)
    host.requests.last().onHostDismiss()
    assertFalse(host.isShowing)
    assertEquals(listOf("show", "dismiss"), host.calls)
    assertEquals(PrototypeEventKind.DISMISSED, events.single().kind)
    assertEquals(Json.parseToJsonElement("""{"reason":"user"}"""), events.single().payload)
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

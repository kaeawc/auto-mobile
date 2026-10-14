package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class PrototypeMultiSurfaceTest {
  private val hosts = mutableListOf(FakePrototypeHost())
  private val timer = FakePrototypeTimer()
  private val events = mutableListOf<PrototypeEvent>()
  private val statuses = mutableListOf<List<PrototypeStatusEntry>>()
  private val results = mutableListOf<Pair<Boolean, String?>>()
  private val patches = mutableListOf<PrototypeResult>()
  private val shownReasons = mutableListOf<PrototypeHiddenReason?>()
  private val deviceAppearance = FakePrototypeDeviceAppearance()
  private var onScreen: (Int) -> Boolean? = { null }
  private var dismissed = 0
  private var cleared = 0
  private var blocked = false
  private var clients = 1
  private var observerSession = 1
  private var foregroundApp: String? = "app.one"
  private lateinit var controller: PrototypeController
  private val foreground =
    PrototypeForegroundTracker(
      timer,
      ownPackage = "ctrlproxy",
      foregroundNow = { foregroundApp },
      onChanged = { controller.onConfigurationChanged() },
    )

  init {
    controller =
      PrototypeController(
        hosts.first(),
        object : PrototypeResultSink {
          override suspend fun send(requestId: String?, success: Boolean, error: String?) {
            results += success to error
          }

          override suspend fun sendPatched(
            requestId: String?,
            success: Boolean,
            error: String?,
            revision: Long?,
            conflict: PrototypePatchConflict?,
          ) {
            patches +=
              PrototypeResult(
                42L,
                requestId,
                success,
                error,
                revision = revision,
                conflict = conflict,
              )
          }

          override suspend fun sendShown(
            requestId: String?,
            missingAssets: List<String>,
            appearance: PrototypeAppearance,
            hiddenReason: PrototypeHiddenReason?,
          ) {
            shownReasons += hiddenReason
            send(requestId, true, null)
          }

          override suspend fun sendPrototypeStatus(
            requestId: String?,
            prototypes: List<PrototypeStatusEntry>,
            droppedEvents: Long,
          ) {
            statuses += prototypes
          }
        },
        onDismissed = { dismissed++ },
        eventSink = PrototypeEventSink { events += it },
        clock = { timer.now },
        lifecycle =
          PrototypeLifecycle(
            timer,
            ttlMillis = 1_000L,
            isBlocked = { blocked },
            observerSession = { observerSession },
            clientCount = { clients },
          ),
        foreground = foreground,
        clearAssets = { cleared++ },
        hostFactory = { FakePrototypeHost().also { hosts += it } },
        deviceAppearance = deviceAppearance,
        windowOnScreen = PrototypeWindowOnScreen { onScreen(it) },
        settle = {},
      )
  }

  private fun spec(id: String, persistent: Boolean = false) =
    PrototypeSpec(
      id,
      PrototypeWindow(
        PrototypeFullscreenPlacement(),
        persistence = if (persistent) "device" else null,
      ),
      root = PrototypePagerNode("pages", children = List(3) { PrototypeTextNode(text = "page") }),
    )

  private suspend fun show(
    id: String,
    replaceOthers: Boolean = false,
    persistent: Boolean = false,
  ): PrototypeRuntime {
    controller.show(id, spec(id, persistent), replaceOthers = replaceOthers)
    assertTrue(results.last().toString(), results.last().first)
    return checkNotNull(controller.activeRuntime)
  }

  private suspend fun status(): List<PrototypeStatusEntry> {
    controller.inspect("inspect")
    return statuses.last()
  }

  private suspend fun emit(runtime: PrototypeRuntime) {
    controller.interact(runtime, PrototypeInteraction.Tap(listOf(PrototypeEmitAction("ping"))))
  }

  @Test
  fun `three added surfaces have separate hosts runtimes state and sequences`() = runTest {
    val a = show("a")
    val b = show("b")
    val c = show("c")
    assertEquals(3, hosts.size)
    assertTrue(hosts.all { it.isShowing })
    assertEquals(listOf("a", "b", "c"), status().map { it.id })
    emit(a)
    emit(b)
    emit(a)
    emit(c)
    assertEquals(listOf("a", "b", "a", "c"), events.map { it.id })
    assertEquals(listOf(1L, 1L, 2L, 1L), events.map { it.sequence })
    assertEquals(listOf(2L, 1L, 1L), status().map { it.lastSequence })
    assertTrue(listOf(a, b, c).all { it.current.active })
    controller.interact(
      a,
      PrototypeInteraction.Tap(
        listOf(PrototypeSetStateAction("label", PrototypeScalar.Text("only a"))),
      ),
    )
    assertEquals(PrototypeScalar.Text("only a"), a.current.state["label"])
    assertNull(b.current.state["label"])
    assertNull(c.current.state["label"])
    assertEquals(listOf(3L, 1L, 1L), status().map { it.lastSequence })
  }

  @Test
  fun `default show closes every old runtime and dismisses sibling windows without events`() =
    runTest {
      val old = listOf(show("a"), show("b"), show("c"))
      // Omit the new parameter to pin the legacy default.
      controller.show("default", spec("new"))
      assertTrue(results.last().first)
      assertEquals(listOf("new"), status().map { it.id })
      assertTrue(old.none { it.current.active })
      assertEquals(listOf(false, false, true), hosts.map { it.isShowing })
      assertTrue(events.isEmpty())
      assertEquals(0, dismissed)
      assertEquals(0, cleared)
    }

  @Test
  fun `accepted replacement succeeds when a sibling refuses teardown and retries its closed host`() =
    runTest {
      val a = show("a")
      val aTimer = timer.tasks.last()
      val b = show("b")
      val c = show("c")
      hosts[0].accept = false
      controller.show("default", spec("new"))
      assertEquals(true to null, results.last())
      assertEquals(listOf("new"), status().map { it.id })
      assertTrue(listOf(a, b, c).none { it.current.active })
      assertTrue(aTimer.cancelled)
      assertEquals(listOf(true, false, true), hosts.map { it.isShowing })
      val tasks = timer.tasks.toList()
      emit(a)
      hosts[0].requests.last().onHostDismiss()
      assertEquals(tasks, timer.tasks)
      assertTrue(events.isEmpty())
      controller.onConfigurationChanged()
      assertEquals(listOf("new"), status().map { it.id })
      hosts[0].accept = true
      controller.onConfigurationChanged()
      assertEquals(listOf(false, false, true), hosts.map { it.isShowing })
      assertEquals(listOf("new"), status().map { it.id })
      assertEquals(0, dismissed)
      assertEquals(0, cleared)
    }

  @Test
  fun `retired host cleanup releases assets after the accepted replacement has ended`() = runTest {
    show("a")
    show("b")
    hosts[0].accept = false
    controller.show("replace", spec("new"))
    assertTrue(results.last().first)
    controller.dismiss("new", "new", null)
    assertTrue(status().isEmpty())
    assertTrue(controller.isShowing)
    assertEquals(0, cleared)
    hosts[0].accept = true
    controller.onConfigurationChanged()
    assertFalse(controller.isShowing)
    assertEquals(1, dismissed)
    assertEquals(1, cleared)
  }

  @Test
  fun `dismissing the last visible surface detaches once while a suspended sibling remains`() =
    runTest {
      val a = show("a")
      foregroundApp = "app.two"
      show("b")
      foreground.onWindowEvent(
        "app.two",
        android.view.accessibility.AccessibilityWindowInfo.TYPE_APPLICATION,
      )
      timer.advance(PROTOTYPE_FOREGROUND_DEBOUNCE_MILLIS)
      assertEquals(listOf(true, false), status().map { it.suspended })
      assertEquals(listOf(false, true), hosts.map { it.isShowing })
      assertEquals(0, dismissed)
      controller.dismiss("b", "b", null)
      assertEquals(true to null, results.last())
      assertEquals(listOf("a"), status().map { it.id })
      assertTrue(a.current.active)
      assertFalse(controller.isShowing)
      assertEquals(1, dismissed)
      assertEquals(0, cleared)
      controller.dismiss("a", "a", null)
      assertEquals(1, dismissed)
      assertEquals(1, cleared)
    }

  @Test
  fun `default same-id show preserves pages and removes every other surface`() = runTest {
    val a = show("a")
    val b = show("b")
    controller.interact(a, PrototypeInteraction.SettledPage("pages", 2))
    controller.show("default", spec("a"))
    assertEquals(listOf("a"), status().map { it.id })
    assertEquals(2, controller.activeRuntime?.current?.pages?.get("pages"))
    assertFalse(a.current.active)
    assertFalse(b.current.active)
    assertTrue(hosts[0].isShowing)
    assertFalse(hosts[1].isShowing)
  }

  @Test
  fun `same-id additive show preserves display and pages replaces just its runtime and raises it`() =
    runTest {
      val a = show("a")
      val b = show("b")
      controller.interact(a, PrototypeInteraction.SettledPage("pages", 2))
      val bTimer = timer.tasks[1]
      controller.show("update", spec("a"), displayId = 9, replaceOthers = false)
      val updated = checkNotNull(controller.activeRuntime)
      assertEquals(listOf("b", "a"), status().map { it.id })
      assertEquals(2, updated.current.pages["pages"])
      assertFalse(a.current.active)
      assertTrue(b.current.active)
      assertEquals(2, hosts.size)
      assertEquals(listOf("show", "replace"), hosts[0].calls)
      assertEquals(0, hosts[0].requests.last().displayId)
      assertTrue(hosts[0].requests.last().bringToFront)
      assertFalse(bTimer.cancelled)
      emit(b)
      emit(updated)
      assertEquals(listOf(1L, 1L, 2L), events.map { it.sequence })
    }

  @Test
  fun `fifth id is refused before any mutation while reshow in the fourth slot is allowed`() =
    runTest {
      val runtimes = listOf(show("a"), show("b"), show("c"), show("d"))
      val before = status()
      val calls = hosts.map { it.calls.toList() }
      val tasks = timer.tasks.toList()
      controller.show("fifth", spec("e"), replaceOthers = false)
      assertEquals(false to "Too many prototypes on screen (max 4): a, b, c, d", results.last())
      assertEquals(before, status())
      assertEquals(calls, hosts.map { it.calls.toList() })
      assertEquals(tasks, timer.tasks)
      assertTrue(runtimes.all { it.current.active })
      assertEquals(4, hosts.size)
      show("b")
      assertEquals(listOf("a", "c", "d", "b"), status().map { it.id })
      controller.show("fifth-again", spec("e"), replaceOthers = false)
      assertEquals(false to "Too many prototypes on screen (max 4): a, c, d, b", results.last())
    }

  @Test
  fun `dismiss by id leaves siblings running and all fires the last-surface callback once`() =
    runTest {
      val a = show("a")
      val b = show("b")
      val c = show("c")
      val otherTimers = listOf(timer.tasks[0], timer.tasks[2])
      controller.dismiss("one", "b", null)
      assertEquals(listOf("a", "c"), status().map { it.id })
      assertFalse(b.current.active)
      assertTrue(otherTimers.none { it.cancelled })
      assertEquals(0, dismissed)
      assertEquals(0, cleared)
      emit(a)
      emit(c)
      controller.dismiss("all", null, true)
      assertTrue(status().isEmpty())
      assertTrue(hosts.none { it.isShowing })
      assertEquals(1, dismissed)
      assertEquals(1, cleared)
      controller.dismiss("empty", null, true)
      assertEquals(1, dismissed)
      controller.dismiss("unknown", "missing", null)
      assertEquals(false to "Unknown prototype id: missing", results.last())
      assertEquals(
        listOf("b", "a", "c"),
        events.filter { it.kind == PrototypeEventKind.DISMISSED }.map { it.id },
      )
    }

  @Test
  fun `authored and host dismiss target only their own surface and stale callbacks do nothing`() =
    runTest {
      val a = show("a")
      val b = show("b")
      val c = show("c")
      val stale = hosts[0].requests.last().onHostDismiss
      controller.interact(a, PrototypeInteraction.Tap(listOf(PrototypeDismissAction)))
      assertEquals(listOf("b", "c"), status().map { it.id })
      hosts[1].requests.last().onHostDismiss()
      stale()
      assertEquals(listOf("c"), status().map { it.id })
      assertFalse(b.current.active)
      emit(c)
      assertEquals(listOf("a", "b", "c"), events.map { it.id })
      assertEquals(0, dismissed)
    }

  @Test
  fun `capture nests every host so all windows are hidden together and all are restored`() =
    runTest {
      show("a")
      show("b")
      show("c")
      val captured = controller.withHiddenForCapture {
        assertTrue(hosts.all { it.captureHidden })
        "pixels"
      }
      assertEquals(PrototypeHiddenCapture("pixels", true), captured)
      assertTrue(hosts.all { it.isShowing && !it.captureHidden })
      hosts[1].captureExcluded = false
      assertFalse(controller.withHiddenForCapture { "pixels" }.prototypeExcluded)
      val failed = runCatching { controller.withHiddenForCapture { error("capture failed") } }
      assertTrue(failed.isFailure)
      assertTrue(hosts.none { it.captureHidden })
    }

  @Test
  fun `capture never waits for a show holding the controller mutex`() = runTest {
    show("a")
    val entered = CompletableDeferred<Unit>()
    val release = CompletableDeferred<Unit>()
    hosts[0].beforeShow = {
      entered.complete(Unit)
      release.await()
    }
    val pending = launch { controller.show("update", spec("a")) }
    runCurrent()
    assertTrue(entered.isCompleted)
    var captured = false
    val capture = launch { controller.withHiddenForCapture { captured = true } }
    runCurrent()
    assertTrue(captured)
    assertTrue(capture.isCompleted)
    assertFalse(pending.isCompleted)
    release.complete(Unit)
    pending.join()
  }

  @Test
  fun `each idle timer expires only its own surface`() = runTest {
    show("a")
    timer.advance(100)
    val b = show("b")
    val bTimer = timer.tasks.last()
    timer.advance(900)
    assertEquals(listOf("b"), status().map { it.id })
    assertFalse(bTimer.cancelled)
    assertTrue(b.current.active)
    assertEquals("a", events.single().id)
    timer.advance(100)
    assertTrue(status().isEmpty())
    assertEquals(listOf("a", "b"), events.map { it.id })
    assertEquals(1, dismissed)
  }

  @Test
  fun `disconnect removes all session surfaces while persistent surfaces and assets survive`() =
    runTest {
      show("a")
      show("persistent", persistent = true)
      show("c")
      controller.onClientCountChanged(1)
      assertEquals(3, status().size)
      clients = 0
      controller.onClientCountChanged(0)
      assertEquals(listOf("persistent"), status().map { it.id })
      assertEquals(listOf(false, true, false), hosts.map { it.isShowing })
      assertEquals(listOf("a", "c"), events.map { it.id })
      assertEquals(0, dismissed)
      assertEquals(0, cleared)
      timer.advance(5_000)
      assertTrue(hosts[1].isShowing)
    }

  @Test
  fun `stale observer disconnect only dismisses surfaces from that observer session`() = runTest {
    show("a")
    observerSession++
    show("b")
    controller.onClientCountChanged(0, observerSession = 1)
    assertEquals(listOf("b"), status().map { it.id })
    assertTrue(hosts[1].isShowing)
    assertEquals(0, cleared)
  }

  @Test
  fun `one failed lifecycle removal cannot strand other surfaces and is retried`() = runTest {
    show("a")
    show("b")
    show("c")
    hosts[0].accept = false
    controller.onClientCountChanged(0)
    assertEquals(listOf("a"), status().map { it.id })
    hosts[0].accept = true
    controller.onConfigurationChanged()
    assertTrue(status().isEmpty())
    assertEquals(1, dismissed)
    assertEquals(listOf("b", "c", "a"), events.map { it.id })
  }

  @Test
  fun `configuration and teardown reach every surface despite a failing sibling`() = runTest {
    show("a")
    show("b")
    show("c")
    hosts[0].accept = false
    controller.onConfigurationChanged()
    assertTrue(hosts.all { "relayout" in it.calls })
    controller.destroy()
    assertNull(controller.activeRuntime)
    assertTrue(hosts.all { "destroy" in it.calls })
    assertEquals(listOf("a", "b", "c"), events.map { it.id })
    assertEquals(0, dismissed)
    assertTrue(controller.isShowing)
    hosts[0].accept = true
    controller.destroy()
    assertFalse(controller.isShowing)
    assertEquals(1, dismissed)
    assertEquals(3, events.size)
  }

  @Test
  fun `display transitions affect only matching surfaces including after one removal fails`() =
    runTest {
      controller.show("a", spec("a"), displayId = 2, replaceOthers = false)
      val a = checkNotNull(controller.activeRuntime)
      show("b")
      controller.show("c", spec("c"), displayId = 2, replaceOthers = false)
      controller.onDisplayTransition(2, removed = false)
      assertTrue("relayout" in hosts[0].calls)
      assertFalse("relayout" in hosts[1].calls)
      assertTrue("relayout" in hosts[2].calls)
      hosts[0].accept = false
      controller.onDisplayTransition(2, removed = true)
      assertEquals(listOf("a", "b"), status().map { it.id })
      assertTrue(a.current.active)
      assertTrue(hosts[1].isShowing)
      hosts[0].accept = true
      controller.onDisplayTransition(2, removed = true)
      assertEquals(listOf("b"), status().map { it.id })
    }

  @Test
  fun `lock hides and restores all windows and unbind dismisses them with one callback`() =
    runTest {
      show("a")
      show("persistent", persistent = true)
      show("c")
      val tasks = timer.tasks.toList()
      blocked = true
      controller.onConfigurationChanged()
      assertTrue(hosts.none { it.isShowing })
      assertEquals(1, dismissed)
      assertEquals(tasks, timer.tasks)
      assertEquals(0, cleared)
      assertTrue(events.isEmpty())
      blocked = false
      controller.onConfigurationChanged()
      assertTrue(hosts.all { it.isShowing })
      assertEquals(listOf("a", "persistent", "c"), status().map { it.id })
      hosts[0].accept = false
      controller.dismissForUnbind()
      assertEquals(listOf("a"), status().map { it.id })
      hosts[0].accept = true
      controller.dismissForUnbind()
      assertTrue(status().isEmpty())
      assertEquals(2, dismissed)
      assertEquals(1, cleared)
    }

  @Test
  fun `metadata reports the topmost surface while app-layer presence checks all windows`() =
    runTest {
      val appSpec =
        spec("app").copy(window = PrototypeWindow(PrototypeFullscreenPlacement(), layer = "app"))
      controller.show("app", appSpec, replaceOthers = false)
      assertTrue(controller.isAppLayerShowing)
      val sheetSpec =
        spec("sheet")
          .copy(window = PrototypeWindow(PrototypeSheetPlacement(edge = "bottom", height = 100.0)))
      controller.show("sheet", sheetSpec, replaceOthers = false)
      assertEquals("sheet", controller.windowMetadata()?.placement)
      assertTrue(controller.isAppLayerShowing)
      controller.show("raise", appSpec, replaceOthers = false)
      assertEquals("fullscreen", controller.windowMetadata()?.placement)
      controller.dismiss("app", "app", null)
      assertFalse(controller.isAppLayerShowing)
      assertTrue(controller.isShowing)
      assertEquals("sheet", controller.windowMetadata()?.placement)
    }

  @Test
  fun `capture with every surface foreground suspended skips every host`() = runTest {
    show("a")
    show("b")
    foreground.onWindowEvent(
      "other",
      android.view.accessibility.AccessibilityWindowInfo.TYPE_APPLICATION,
    )
    timer.advance(PROTOTYPE_FOREGROUND_DEBOUNCE_MILLIS)
    assertTrue(status().all { it.suspended })
    val calls = hosts.map { it.calls.toList() }
    assertEquals(
      PrototypeHiddenCapture("pixels", true),
      controller.withHiddenForCapture { "pixels" },
    )
    assertEquals(calls, hosts.map { it.calls.toList() })
  }

  @Test
  fun `foreground suspension is independent and persistent windows never follow another app`() =
    runTest {
      show("a")
      show("persistent", persistent = true)
      foregroundApp = "app.two"
      show("b")
      foreground.onWindowEvent(
        "app.two",
        android.view.accessibility.AccessibilityWindowInfo.TYPE_APPLICATION,
      )
      timer.advance(PROTOTYPE_FOREGROUND_DEBOUNCE_MILLIS)
      assertEquals(listOf(true, false, false), status().map { it.suspended })
      assertEquals(listOf(false, true, true), hosts.map { it.isShowing })
      assertTrue(controller.isSuspendedByForeground)
      controller.withHiddenForCapture {
        assertFalse(hosts[0].captureHidden)
        assertTrue(hosts[1].captureHidden)
        assertTrue(hosts[2].captureHidden)
      }
      assertEquals(0, dismissed)
      controller.dismiss("persistent", "persistent", null)
      foreground.onWindowEvent(
        "app.one",
        android.view.accessibility.AccessibilityWindowInfo.TYPE_APPLICATION,
      )
      timer.advance(PROTOTYPE_FOREGROUND_DEBOUNCE_MILLIS)
      assertEquals(listOf(false, true), status().map { it.suspended })
      assertEquals(listOf(true, false), listOf(hosts[0].isShowing, hosts[2].isShowing))
    }

  @Test
  fun `patch targets a non-topmost surface with independent revisions and conflicts`() = runTest {
    val initial =
      spec("a")
        .copy(
          state = mapOf("label" to PrototypeScalar.Text("old")),
          root = PrototypeTextNode(text = "{label}"),
        )
    controller.show("a", initial, replaceOthers = false)
    val a = checkNotNull(controller.activeRuntime)
    controller.show("b", initial.copy(id = "b"), replaceOthers = false)
    val b = checkNotNull(controller.activeRuntime)
    val aBase = a.current.revision
    val bBefore = b.current
    controller.interact(
      a,
      PrototypeInteraction.Tap(
        listOf(PrototypeSetStateAction("label", PrototypeScalar.Text("user"))),
      ),
    )
    val ops =
      Json.parseToJsonElement(
          """[{"op":"replace","path":"/state/label","value":"patched"}]""",
        )
        .jsonArray
    controller.patch("conflict", "a", aBase, ops)
    assertFalse(patches.last().success)
    assertEquals(a.current.revision, patches.last().revision)
    assertEquals(mapOf("label" to PrototypeScalar.Text("user")), patches.last().conflict?.state)
    controller.patch("applied", "a", a.current.revision, ops)
    assertTrue(patches.last().error, patches.last().success)
    assertEquals(PrototypeScalar.Text("patched"), a.current.state["label"])
    assertEquals(a.current.revision, patches.last().revision)
    assertSame(bBefore, b.current)
    assertSame(b, controller.activeRuntime)
    assertEquals(listOf("show"), hosts[0].calls.filter { it in listOf("show", "replace") })
    val previousRevision = a.current.revision
    controller.show("replace a", initial, replaceOthers = false)
    assertTrue(checkNotNull(controller.activeRuntime).current.revision > previousRevision)
    assertSame(bBefore, b.current)
  }

  @Test
  fun `idle refresh caches each surface appearance and updates every changed palette`() = runTest {
    val a = show("a")
    val b = show("b")
    val passes = listOf(a.renderMappingPasses, b.renderMappingPasses)
    repeat(10) { controller.onConfigurationChanged() }
    assertEquals(passes, listOf(a.renderMappingPasses, b.renderMappingPasses))
    deviceAppearance.dark = true
    controller.onConfigurationChanged()
    assertEquals(listOf("a", "b"), events.map { it.id })
    assertTrue(status().all { it.appearance?.mode == PrototypeAppearanceMode.DARK })
    val updatedPasses = listOf(a.renderMappingPasses, b.renderMappingPasses)
    repeat(10) { controller.onConfigurationChanged() }
    assertEquals(updatedPasses, listOf(a.renderMappingPasses, b.renderMappingPasses))
    assertEquals(2, events.size)
  }

  @Test
  fun `show and inspect resolve hidden reasons for each surface layer and display`() = runTest {
    onScreen = { it != 2 }
    val app =
      spec("app").copy(window = PrototypeWindow(PrototypeFullscreenPlacement(), layer = "app"))
    controller.show("app", app, displayId = 2, replaceOthers = false)
    assertEquals(PrototypeHiddenReason.APP_LAYER_WINDOW_HIDDEN, shownReasons.last())
    show("system")
    assertNull(shownReasons.last())
    val entries = status().associateBy { it.id }
    assertEquals(
      PrototypeHiddenReason.APP_LAYER_WINDOW_HIDDEN,
      entries.getValue("app").hiddenReason,
    )
    assertNull(entries.getValue("system").hiddenReason)
    assertEquals(PrototypeHiddenReason.APP_LAYER_WINDOW_HIDDEN, controller.hiddenReason(2, false))
    assertNull(controller.hiddenReason(0, false))
    blocked = true
    controller.onConfigurationChanged()
    assertTrue(status().all { it.hiddenReason == PrototypeHiddenReason.DEVICE_BLOCKED })
  }
}

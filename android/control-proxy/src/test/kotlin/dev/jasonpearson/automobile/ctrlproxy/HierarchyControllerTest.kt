package dev.jasonpearson.automobile.ctrlproxy

import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ViewHierarchy
import dev.jasonpearson.automobile.ctrlproxy.perf.PerfProvider
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.protocol.ErrorResponse
import dev.jasonpearson.automobile.protocol.RequestHierarchy
import io.mockk.mockk
import java.io.File
import java.io.OutputStream
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class HierarchyControllerTest {
  @get:Rule val tmp = TemporaryFolder()

  private class FakeTimer : TimeProvider {
    override fun currentTimeMillis(): Long = 1_000L
  }

  private class FakeHost(val dir: File) : HierarchyController.Host {
    var windows: List<AccessibilityWindowInfo> = emptyList()
    private val provenance =
      RotationProvenanceTracker(
        object : RotationChangeSignal {
          override fun register(listener: (Int) -> Unit) = false

          override fun synchronize() = false

          override fun unregister() = Unit
        },
      )
    var root: AccessibilityNodeInfo? = null
    var windowState = AccessibilityEventDispatcher.WindowState(null, null)
    var onWakefulness: () -> Unit = {}
    val foregroundCalls = mutableListOf<Triple<String?, String?, String?>>()
    var running = true
    val released = mutableListOf<String?>()
    val syncFrames = mutableListOf<String>()
    val asyncFrames = mutableListOf<String>()
    val errorFrames = mutableListOf<ErrorResponse?>()

    override fun currentFrameContext() = "epoch:1"

    override fun selectDisplayWindows(displayId: Int?) =
      ViewHierarchyExtractor.DisplayWindows(displayId ?: 0, windows)

    override fun activeWindowRoot(): AccessibilityNodeInfo? = root

    override fun lastWindowState() = windowState

    override fun rotationProvenance() = provenance

    override fun occlusionEnabled() = true

    override fun wakefulness(): String {
      onWakefulness()
      return "Awake"
    }

    override fun foregroundActivity(
      rootPackage: String?,
      windowClass: String?,
      windowPackage: String?,
    ): String? {
      foregroundCalls += Triple(rootPackage, windowClass, windowPackage)
      return null
    }

    override fun isEmulator() = true

    override fun accessibilityTool(): Boolean? = null

    override fun isServerRunning() = running

    override fun connectionCount() = 1

    override fun releaseRequestOwner(requestId: String?) {
      released += requestId
    }

    override suspend fun broadcastHierarchyWithPerf(
      routeByRequestId: Boolean,
      messageBuilder: (perfTiming: JsonElement?) -> String,
    ) {
      asyncFrames += messageBuilder(null)
    }

    override suspend fun broadcastHierarchyWithPerfSync(
      routeByRequestId: Boolean,
      messageBuilder: (perfTiming: JsonElement?) -> String,
    ) {
      syncFrames += messageBuilder(null)
    }

    override suspend fun broadcastHierarchyExtractFrame(
      frame: ErrorResponse?,
      externallyCorrelated: Boolean,
    ) {
      errorFrames += frame
    }

    override fun launchRequestScope(
      requestId: String?,
      block: suspend CoroutineScope.() -> Unit,
    ): Job = error("not used")

    override fun openFileOutput(filename: String, mode: Int): OutputStream =
      File(dir, filename).outputStream()

    override fun filesDir(): File = dir
  }

  private fun TestScope.controller(
    host: FakeHost,
    debouncerTimer: TimeProvider = FakeTimer(),
    extract: (HierarchySnapshotOptions) -> ViewHierarchy?,
  ): HierarchyController =
    HierarchyController(
        host = host,
        serviceScope = backgroundScope,
        viewHierarchyExtractor = mockk(relaxed = true),
        displayController = DisplayController(mockk(relaxed = true)),
        diagnostics =
          HierarchyDiagnosticsDependencies(
            perfProvider = PerfProvider.instance,
            timeProvider = FakeTimer(),
            workStats = CtrlProxyWorkStats(),
          ),
        jsonCompact = Json { encodeDefaults = true },
      )
      .also {
        it.debouncer =
          HierarchyDebouncer(
            scope = backgroundScope,
            timeProvider = debouncerTimer,
            dependencies =
              HierarchyDebouncerDependencies(
                extractHierarchy = { _, options -> extract(options) },
              ),
          )
      }

  private fun TestScope.directController(host: FakeHost): HierarchyController =
    HierarchyController(
        host = host,
        serviceScope = backgroundScope,
        viewHierarchyExtractor = ViewHierarchyExtractor(),
        displayController =
          DisplayController(
            object : DisplayController.Host {
              override fun displayManager() = null

              override fun windowManager() = null

              override fun displayInsetsProvider() = WindowMetricsDisplayInsetsProvider(30) { null }

              override fun frameworkDimenPx(name: String) = 0

              override fun densityDpi() = 160
            },
          ),
        diagnostics =
          HierarchyDiagnosticsDependencies(
            PerfProvider.instance,
            FakeTimer(),
            CtrlProxyWorkStats(),
          ),
        jsonCompact = Json { encodeDefaults = true },
      )
      .also { it.start() }

  @Test
  fun `direct and fallback enrichment use the captured event class and package together`() =
    runTest {
      for (requested in listOf(false, true)) {
        val host =
          FakeHost(tmp.newFolder()).apply {
            root =
              AccessibilityNodeInfo.obtain().apply {
                packageName = "com.google.android.permissioncontroller"
                className = "android.widget.FrameLayout"
              }
            windowState =
              AccessibilityEventDispatcher.WindowState(
                "dev.jasonpearson.automobile.playground.MainActivity",
                "dev.jasonpearson.automobile.playground",
              )
            onWakefulness = {
              windowState =
                AccessibilityEventDispatcher.WindowState(
                  "com.google.android.permissioncontroller.PermissionActivity",
                  "com.google.android.permissioncontroller",
                )
            }
          }
        val controller = directController(host)

        if (requested) {
          controller.requestHierarchy(RequestHierarchy(requestId = "req_permission"))
          assertEquals(1, host.syncFrames.size)
        } else {
          assertTrue(controller.extractHierarchy() != null)
        }

        assertEquals(
          listOf(
            Triple(
              "com.google.android.permissioncontroller",
              "dev.jasonpearson.automobile.playground.MainActivity",
              "dev.jasonpearson.automobile.playground",
            ),
          ),
          host.foregroundCalls,
        )
      }
    }

  @Test
  fun `non-default display without windows or root reports inaccessible display`() = runTest {
    val host = FakeHost(tmp.newFolder())
    val controller = directController(host)

    controller.requestHierarchy(RequestHierarchy(requestId = "req_overlay", displayId = 2))

    assertEquals(
      "Display 2 exposes no accessibility windows on this device: " +
        "the accessibility service does not track this display (overlay displays are not tracked). " +
        "Use the default display or a display tracked by accessibility.",
      host.errorFrames.single()!!.error,
    )
    assertEquals("req_overlay", host.errorFrames.single()!!.requestId)
    assertTrue(host.syncFrames.isEmpty())
  }

  @Test
  fun `default display without windows or root keeps generic null error`() = runTest {
    val host = FakeHost(tmp.newFolder())
    val controller = directController(host)

    controller.requestHierarchy(RequestHierarchy(requestId = "req_default", displayId = 0))

    assertEquals(
      HierarchyExtractErrorFrames.NULL_HIERARCHY_ERROR,
      host.errorFrames.single()!!.error,
    )
  }

  @Test
  fun `non-default display with windows keeps normal extraction`() = runTest {
    val host =
      FakeHost(tmp.newFolder()).apply {
        windows = listOf(AccessibilityWindowInfo.obtain())
      }
    val controller = directController(host)

    controller.requestHierarchy(RequestHierarchy(requestId = "req_windows", displayId = 2))

    assertTrue(host.errorFrames.isEmpty())
    assertEquals(
      "2",
      Json.parseToJsonElement(host.syncFrames.single())
        .jsonObject["data"]
        ?.jsonObject
        ?.get("displayId")
        ?.jsonPrimitive
        ?.content,
    )
  }

  @Test
  fun `request hierarchy forwards limits and delivers a correlated sync update without a dump`() =
    runTest {
      val host = FakeHost(tmp.newFolder())
      val seen = mutableListOf<HierarchySnapshotOptions>()
      val hierarchy = ViewHierarchy(packageName = "com.example")
      val controller =
        controller(host) {
          seen += it
          hierarchy
        }

      controller.requestHierarchy(
        RequestHierarchy(requestId = "req_1", maxDepth = 7, maxNodes = 9, displayId = 2),
      )

      assertEquals(listOf(7 to 9), seen.map { it.maxDepth to it.maxNodes })
      assertEquals(2, seen.single().displayId)
      val frame = Json.parseToJsonElement(host.syncFrames.single()).jsonObject
      assertEquals("hierarchy_update", frame["type"]?.jsonPrimitive?.content)
      assertEquals("req_1", frame["requestId"]?.jsonPrimitive?.content)
      assertFalse(File(host.dir, "latest_hierarchy.json").exists())
      assertEquals(listOf<String?>("req_1"), host.released)
      assertTrue(controller.extractedHierarchyFrameContexts.isEmpty())
    }

  @Test
  fun `push and request dump only while the marker exists and always broadcast`() = runTest {
    for (requested in listOf(false, true)) {
      val host = FakeHost(tmp.newFolder())
      var hierarchy = ViewHierarchy(packageName = "com.example.initial")
      val controller = controller(host) { hierarchy }
      val marker = File(host.dir, "dump_hierarchy")
      val dump = File(host.dir, "latest_hierarchy.json")
      val frames = if (requested) host.syncFrames else host.asyncFrames

      for (enabled in listOf(false, true, false)) {
        if (enabled) assertTrue(marker.createNewFile()) else marker.delete()
        val previousDump = dump.takeIf { it.exists() }?.readText()
        val packageName = "com.example.frame${frames.size}"
        hierarchy = ViewHierarchy(packageName = packageName)
        if (requested) {
          controller.requestHierarchy(RequestHierarchy(requestId = "req_${frames.size}"))
        } else {
          controller.deliverResult(HierarchyResult.Changed(hierarchy, 1, 0L))
        }
        val frame = Json.parseToJsonElement(frames.last()).jsonObject
        assertEquals("hierarchy_update", frame["type"]?.jsonPrimitive?.content)
        assertTrue(frames.last().contains(packageName))
        if (enabled) {
          assertTrue(dump.readText().contains(packageName))
        } else {
          assertEquals(previousDump, dump.takeIf { it.exists() }?.readText())
        }
      }
      assertEquals(3, frames.size)
    }
  }

  @Test
  fun `request hierarchy defaults the snapshot limits`() = runTest {
    val host = FakeHost(tmp.newFolder())
    val seen = mutableListOf<HierarchySnapshotOptions>()
    val controller =
      controller(host) {
        seen += it
        ViewHierarchy()
      }

    controller.requestHierarchy(RequestHierarchy(requestId = "req_2"))

    assertEquals(listOf(100 to 10_000), seen.map { it.maxDepth to it.maxNodes })
  }

  /** Virtual time, so the quiescence wait elapses without real sleeps. */
  private fun TestScope.virtualTimer() =
    object : TimeProvider {
      override fun currentTimeMillis() = testScheduler.currentTime
    }

  @Test
  fun `a settled hierarchy is published as one in-order update`() = runTest {
    val host = FakeHost(tmp.newFolder())
    val seen = mutableListOf<HierarchySnapshotOptions>()
    val controller =
      controller(host, virtualTimer()) {
        seen += it
        ViewHierarchy(packageName = "com.example.settled")
      }

    controller.publishSettledHierarchy()

    assertEquals(listOf<Int?>(null), seen.map { it.displayId })
    val frame = Json.parseToJsonElement(host.syncFrames.single()).jsonObject
    assertEquals("hierarchy_update", frame["type"]?.jsonPrimitive?.content)
    assertTrue("a settled publish is never fire-and-forget", host.asyncFrames.isEmpty())
  }

  @Test
  fun `nothing is published when the settled extraction fails`() = runTest {
    val host = FakeHost(tmp.newFolder())
    val controller = controller(host, virtualTimer()) { null }

    controller.publishSettledHierarchy()

    assertTrue(host.syncFrames.isEmpty() && host.asyncFrames.isEmpty())
    assertTrue(host.errorFrames.isEmpty())
  }

  @Test
  fun `a settled hierarchy is extracted from the requested display`() = runTest {
    val host = FakeHost(tmp.newFolder())
    val seen = mutableListOf<Int?>()
    val tree = ViewHierarchy(packageName = "com.example.display")
    val controller =
      controller(host, virtualTimer()) {
        seen += it.displayId
        tree
      }

    assertSame(tree, controller.settledHierarchy(displayId = 2))
    controller.settledHierarchy()

    assertEquals(listOf<Int?>(2, null), seen)
    assertTrue("settling alone publishes nothing", host.syncFrames.isEmpty())
  }

  @Test
  fun `null extraction replies with one correlated error frame and no update`() = runTest {
    val host = FakeHost(tmp.newFolder())
    val controller = controller(host) { null }

    controller.requestHierarchy(RequestHierarchy(requestId = "req_3"))

    assertTrue(host.syncFrames.isEmpty())
    assertEquals(
      listOf("req_3"),
      host.errorFrames.map { it?.requestId },
    )
    assertEquals(listOf<String?>("req_3"), host.released)
  }

  @Test
  fun `broadcast is skipped and the frame context released while the server is not running`() =
    runTest {
      val host = FakeHost(tmp.newFolder()).apply { running = false }
      val controller = controller(host) { ViewHierarchy() }

      controller.requestHierarchy(RequestHierarchy(requestId = "req_4"))

      assertTrue(host.syncFrames.isEmpty())
      assertTrue(controller.extractedHierarchyFrameContexts.isEmpty())
    }

  @Test
  fun `cleanup deletes uuid hierarchy files but keeps the latest hierarchy file and dump marker`() =
    runTest {
      val host = FakeHost(tmp.newFolder())
      File(host.dir, "hierarchy_abc.json").writeText("{}")
      File(host.dir, "latest_hierarchy.json").writeText("{}")
      File(host.dir, "other.json").writeText("{}")
      File(host.dir, "dump_hierarchy").createNewFile()
      val controller = controller(host) { null }

      controller.cleanupUuidHierarchyFiles()

      assertFalse(File(host.dir, "hierarchy_abc.json").exists())
      assertTrue(File(host.dir, "latest_hierarchy.json").exists())
      assertTrue(File(host.dir, "other.json").exists())
      assertTrue(File(host.dir, "dump_hierarchy").exists())
    }

  @Test
  fun `interval and event hooks are safe before the debouncer exists`() = runTest {
    val controller =
      HierarchyController(
        host = FakeHost(tmp.newFolder()),
        serviceScope = backgroundScope,
        viewHierarchyExtractor = mockk(relaxed = true),
        displayController = DisplayController(mockk(relaxed = true)),
        diagnostics =
          HierarchyDiagnosticsDependencies(
            perfProvider = PerfProvider.instance,
            timeProvider = FakeTimer(),
            workStats = CtrlProxyWorkStats(),
          ),
        jsonCompact = Json { encodeDefaults = true },
      )

    controller.setHierarchyInterval(null)
    controller.onAccessibilityEvent()
    controller.extractNow()
    controller.resetDebouncer()
    controller.stop()
  }
}

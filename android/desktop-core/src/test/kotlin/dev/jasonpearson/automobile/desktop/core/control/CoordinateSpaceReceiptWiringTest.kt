package dev.jasonpearson.automobile.desktop.core.control

import java.io.File
import kotlin.test.Test
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * Structural backstop for the receipt-time coordinate-space gate (issue #4550).
 *
 * `DeviceControlSession.onObservationSpaceDeclared` only protects the debounce window if it is
 * called at the moment a stream message is observed — ahead of the hierarchy parse and ahead of
 * `LayoutInspectorState`'s debounce. That ordering lives in `AutoMobileContent`'s two stream
 * collectors, which are `@Composable` and therefore not reachable from a plain unit test: the
 * behavior test drives the session and the debounced state directly, so it would keep passing if
 * the call were moved after the parse, moved after `applyHierarchyUpdate`, or deleted outright.
 *
 * That is exactly the test-vs-production divergence this repo keeps producing, so the ordering is
 * asserted against the real source instead of being assumed. Same mechanism as
 * `BroadcastGuardAdoptionTest` in `control-proxy`.
 */
class CoordinateSpaceReceiptWiringTest {

  private val hook = "deviceControlSession.onObservationSpaceDeclared(update.coordinateSpace)"

  @Test
  fun `both stream collectors declare the coordinate space at receipt`() {
    val source = readAutoMobileContentSource()
    val occurrences = source.split(hook).size - 1
    assertTrue(
      occurrences == 2,
      "Expected exactly 2 receipt-time `$hook` calls in AutoMobileContent.kt (one per stream " +
        "collector), found $occurrences. A collector that stops declaring the space at receipt " +
        "reopens the debounce window a tap can be mis-converted in (issue #4550).",
    )
  }

  @Test
  fun `the receipt-time call precedes the state apply in both collectors`() {
    // Ordering, not just presence: the whole point is that the gate runs BEFORE the frame facts are
    // written. A call that drifted below `applyHierarchyUpdate` / `updateScreenshot` would be back
    // inside the window it exists to close, while still satisfying the presence check above.
    val source = readAutoMobileContentSource()
    val applies =
      listOf("layoutInspectorState.applyHierarchyUpdate(", "layoutInspectorState.updateScreenshot(")

    applies.forEach { apply ->
      val applyIndex = source.indexOf(apply)
      assertTrue(applyIndex >= 0, "could not find `$apply` in AutoMobileContent.kt")
      val hookIndex = source.lastIndexOf(hook, applyIndex)
      assertTrue(
        hookIndex in 0 until applyIndex,
        "`$hook` must appear BEFORE `$apply` in its collector (issue #4550): detecting the " +
          "transition from the frame facts is one debounce interval too late.",
      )
    }
  }

  private fun readAutoMobileContentSource(): String = locateAutoMobileContentSource().readText()

  private fun locateAutoMobileContentSource(): File {
    val rel = "src/main/kotlin/dev/jasonpearson/automobile/desktop/core/AutoMobileContent.kt"
    // The Gradle working directory may be the module root, the `android` dir, or the repo root.
    // Try the common anchors, then walk up as a fallback. Path separators are normalized by File.
    val anchors = listOf(rel, "desktop-core/$rel", "android/desktop-core/$rel")
    anchors
      .map(::File)
      .firstOrNull { it.isFile }
      ?.let {
        return it
      }

    var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
    while (dir != null) {
      anchors
        .map { File(dir, it) }
        .firstOrNull { it.isFile }
        ?.let {
          return it
        }
      dir = dir.parentFile
    }
    fail("Could not locate AutoMobileContent.kt from ${System.getProperty("user.dir")}")
  }
}

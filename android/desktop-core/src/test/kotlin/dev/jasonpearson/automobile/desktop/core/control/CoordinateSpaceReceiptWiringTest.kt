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

  /**
   * The receipt-time call, whitespace-normalized.
   *
   * ktfmt wraps a call this long across lines, and the exact argument list is load-bearing (the
   * capture id is what keeps a late frame from rolling the tracked space backward), so the guard
   * matches on a normalized form rather than on one particular line breaking.
   */
  private val hook =
    "deviceControlSession.onObservationSpaceDeclared(update.coordinateSpace,update.captureSequence)"

  /**
   * Collapse whitespace and drop the trailing comma ktfmt adds when it wraps an argument list, so
   * only the CALL matters and not how it happens to be laid out.
   */
  private fun normalize(source: String): String =
    source.replace(Regex("\\s+"), "").replace(",)", ")")

  /**
   * One collector's source region: from where it starts consuming the flow to where it writes the
   * frame state. The hook must live inside THIS span.
   *
   * Scoping per collector is the point. A whole-file occurrence count plus a `lastIndexOf` walk
   * backwards from each apply passes when one collector holds two hooks and the other holds none —
   * the asymmetric regression this guard exists to catch. Each collector is therefore isolated to
   * its own slice and asserted independently, so removing either hook fails exactly one test.
   */
  private data class CollectorSpan(val name: String, val start: String, val apply: String)

  private val collectors =
    listOf(
      CollectorSpan(
        name = "hierarchy",
        start = "liveStreamClient.hierarchyUpdates.collect { update ->",
        apply = "layoutInspectorState.applyHierarchyUpdate(",
      ),
      CollectorSpan(
        name = "screenshot",
        start = "liveStreamClient.screenshotUpdates.collect { update ->",
        apply = "layoutInspectorState.updateScreenshot(",
      ),
    )

  @Test
  fun `the hierarchy collector declares the coordinate space before applying the update`() {
    assertHookPrecedesApply(collectors.single { it.name == "hierarchy" })
  }

  @Test
  fun `the screenshot collector declares the coordinate space before applying the update`() {
    assertHookPrecedesApply(collectors.single { it.name == "screenshot" })
  }

  /**
   * Assert [span]'s own region contains the hook, ahead of its own state write.
   *
   * Both facts in one assertion because they are one property: a hook that is present but below the
   * apply is back inside the window it exists to close, and a hook that is absent leaves the window
   * fully open. Slicing to the region makes them per-collector rather than file-wide.
   */
  private fun assertHookPrecedesApply(span: CollectorSpan) {
    val source = readAutoMobileContentSource()
    val start = source.indexOf(span.start)
    assertTrue(
      start >= 0,
      "could not find the ${span.name} collector (`${span.start}`) in AutoMobileContent.kt — if it " +
        "was renamed, update this guard rather than deleting it (issue #4550)",
    )
    val applyIndex = source.indexOf(span.apply, start)
    assertTrue(
      applyIndex > start,
      "could not find `${span.apply}` after the ${span.name} collector in AutoMobileContent.kt",
    )

    val region = normalize(source.substring(start, applyIndex))
    assertTrue(
      region.contains(normalize(hook)),
      "The ${span.name} collector must call `$hook` at RECEIPT — inside its own body and BEFORE " +
        "`${span.apply}` (issue #4550). Detecting the transition from the frame facts instead is " +
        "one debounce interval too late, and a tap in that window is mapped in the old coordinate " +
        "space while the daemon already converts under the new one.",
    )
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

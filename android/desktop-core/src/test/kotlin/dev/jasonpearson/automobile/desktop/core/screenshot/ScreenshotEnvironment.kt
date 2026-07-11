package dev.jasonpearson.automobile.desktop.core.screenshot

import java.awt.image.BufferedImage
import java.io.File
import kotlin.test.fail
import org.junit.Assume

/**
 * Reads the system properties that configure a screenshot-test run and turns a captured image into
 * a pass/fail/record outcome.
 *
 * Supported `-D` properties (forwarded to the test JVM by `desktop-core/build.gradle.kts`):
 * - `screenshot.record` (`true`/`false`, default `false`) — write baselines instead of comparing.
 * - `screenshot.reference.os` (default `linux`, or `any` to disable OS gating) — baselines are
 *   pixel-identical only on one OS because font rasterization differs; tests are skipped (not
 *   failed) elsewhere so `./gradlew test` stays green on any developer machine.
 * - `screenshot.golden.dir` (default `src/test/resources/screenshots`) — where baseline PNGs live.
 * - `screenshot.report.dir` (default `build/reports/screenshots`) — where rejected/diff images go.
 */
object ScreenshotEnvironment {

  private const val RECORD_PROPERTY = "screenshot.record"
  private const val REFERENCE_OS_PROPERTY = "screenshot.reference.os"
  private const val GOLDEN_DIR_PROPERTY = "screenshot.golden.dir"
  private const val REPORT_DIR_PROPERTY = "screenshot.report.dir"

  private const val DEFAULT_REFERENCE_OS = "linux"
  private const val DEFAULT_GOLDEN_DIR = "src/test/resources/screenshots"
  private const val DEFAULT_REPORT_DIR = "build/reports/screenshots"

  val recordEnabled: Boolean
    get() = System.getProperty(RECORD_PROPERTY)?.toBooleanStrictOrNull() == true

  private val goldenDir: File
    get() = File(System.getProperty(GOLDEN_DIR_PROPERTY) ?: DEFAULT_GOLDEN_DIR)

  private val reportDir: File
    get() = File(System.getProperty(REPORT_DIR_PROPERTY) ?: DEFAULT_REPORT_DIR)

  /**
   * Skips the calling test (via a JUnit assumption) unless it is running on the reference OS. This
   * keeps OS-specific pixel differences from turning into false failures on developer machines
   * while still enforcing the baseline on the reference CI platform.
   */
  fun assumeReferencePlatform() {
    val referenceOs =
      (System.getProperty(REFERENCE_OS_PROPERTY) ?: DEFAULT_REFERENCE_OS).lowercase()
    if (referenceOs == "any") return
    val currentOs = System.getProperty("os.name", "").lowercase()
    Assume.assumeTrue(
      "Screenshot tests only run on the reference OS '$referenceOs' (current: '$currentOs'). " +
        "Record on CI, or override locally with -D$REFERENCE_OS_PROPERTY=any.",
      currentOs.contains(referenceOs),
    )
  }

  /**
   * Skips a [pending] test (one whose baseline is not recorded yet) in verify mode, so it can't
   * fail on a missing baseline — but lets it run in record mode so `-Dscreenshot.record=true` still
   * produces the baseline. Non-pending tests are unaffected and fail on a missing baseline.
   */
  fun skipIfPending(name: String, pending: Boolean) {
    if (pending && !recordEnabled) {
      Assume.assumeTrue(
        "Screenshot '$name' is pending — its baseline is not recorded yet. " +
          "Record it with -D$RECORD_PROPERTY=true, commit the PNG, then drop pending = true.",
        false,
      )
    }
  }

  /** Records or verifies [image] for [name], failing the test with an actionable message. */
  fun handleResult(
    name: String,
    image: BufferedImage,
    options: ScreenshotComparator.Options,
  ) {
    val baseline = File(goldenDir, "$name.png")
    if (recordEnabled) {
      ScreenshotComparator.record(baseline, image)
      return
    }
    when (val result = ScreenshotComparator.compare(baseline, image, reportDir, name, options)) {
      ScreenshotComparator.Result.Match -> Unit
      ScreenshotComparator.Result.Recorded -> Unit
      is ScreenshotComparator.Result.MissingBaseline ->
        // A missing baseline is a failure, not a skip: verification must not silently pass when a
        // baseline is absent or has been deleted. Commit baselines together with their tests
        // (record them with -Dscreenshot.record=true). A test whose baseline is not recorded yet
        // should pass pending = true (see skipIfPending) rather than relaxing this into a skip.
        fail(
          "No screenshot baseline for '$name' at ${result.baseline.path}. " +
            "Record it with: ./gradlew -p android :desktop-core:test -D$RECORD_PROPERTY=true, " +
            "then commit the PNG alongside the test."
        )
      is ScreenshotComparator.Result.SizeMismatch ->
        fail(
          "Screenshot '$name' size changed: baseline ${result.expectedWidth}x${result.expectedHeight}, " +
            "actual ${result.actualWidth}x${result.actualHeight}. Rejected image: ${result.actualFile.path}"
        )
      is ScreenshotComparator.Result.Mismatch ->
        fail(
          "Screenshot '$name' differs: ${result.differentPixelCount} pixels " +
            "(${"%.4f".format(result.differentPixelRatio * 100)}%) exceed tolerance. " +
            "Diff: ${result.diffFile.path}, rejected: ${result.actualFile.path}. " +
            "If intentional, re-record with -D$RECORD_PROPERTY=true."
        )
    }
  }
}

package dev.jasonpearson.automobile.ctrlproxy.prototype.screenshot

import java.io.File
import java.util.Locale
import org.junit.Assert.fail
import org.junit.Assume

/**
 * Reads the `-Dscreenshot.*` switches (forwarded to the test JVM by
 * `control-proxy/build.gradle.kts`) and turns a captured prototype render into a record, pass or
 * fail outcome. The switches and their semantics match desktop-core's screenshot harness
 * (`android/docs/screenshot-testing.md`):
 * - `screenshot.record` (`true`/`false`, default `false`) — write baselines instead of comparing.
 * - `screenshot.reference.os` (default `linux`, or `any`) — baselines are pixel-identical only on
 *   the OS that recorded them, so tests are skipped (not failed) elsewhere.
 * - `screenshot.golden.dir` (default `src/test/resources/screenshots/prototype`) — where baselines
 *   live.
 * - `screenshot.report.dir` (default `build/reports/screenshots/prototype`) — rejected/diff images.
 */
internal object PrototypeScreenshotEnvironment {
  private const val RECORD_PROPERTY = "screenshot.record"
  private const val REFERENCE_OS_PROPERTY = "screenshot.reference.os"
  private const val GOLDEN_DIR_PROPERTY = "screenshot.golden.dir"
  private const val REPORT_DIR_PROPERTY = "screenshot.report.dir"

  val recordEnabled: Boolean
    get() = System.getProperty(RECORD_PROPERTY)?.toBooleanStrictOrNull() == true

  private val goldenDir: File
    get() =
      File(System.getProperty(GOLDEN_DIR_PROPERTY) ?: "src/test/resources/screenshots/prototype")

  private val reportDir: File
    get() = File(System.getProperty(REPORT_DIR_PROPERTY) ?: "build/reports/screenshots/prototype")

  fun assumeReferencePlatform() {
    val referenceOs = (System.getProperty(REFERENCE_OS_PROPERTY) ?: "linux").lowercase()
    if (referenceOs == "any") return
    val currentOs = System.getProperty("os.name", "").lowercase()
    Assume.assumeTrue(
      "Prototype screenshot tests only run on the reference OS '$referenceOs' (current: " +
        "'$currentOs'). Record on CI, or override locally with -D$REFERENCE_OS_PROPERTY=any.",
      currentOs.contains(referenceOs),
    )
  }

  /**
   * A pending test (baseline not recorded yet) is skipped in verify mode but runs when recording.
   */
  fun skipIfPending(name: String, pending: Boolean) {
    Assume.assumeFalse(
      "Prototype screenshot '$name' is pending — its baseline is not recorded yet. Record it with " +
        "-D$RECORD_PROPERTY=true, commit the PNG, then drop pending = true.",
      pending && !recordEnabled,
    )
  }

  fun handleResult(
    codec: PrototypeScreenshotComparator.PngCodec,
    name: String,
    image: PrototypeScreenshotComparator.Image,
    options: PrototypeScreenshotComparator.Options,
  ) {
    val baseline = File(goldenDir, "$name.png")
    if (recordEnabled) {
      PrototypeScreenshotComparator.record(codec, baseline, image)
      return
    }
    when (
      val result =
        PrototypeScreenshotComparator.compare(codec, baseline, image, reportDir, name, options)
    ) {
      PrototypeScreenshotComparator.Result.Match,
      PrototypeScreenshotComparator.Result.Recorded -> Unit
      // A missing baseline fails rather than skips, so deleting a baseline cannot silently pass.
      is PrototypeScreenshotComparator.Result.MissingBaseline ->
        fail(
          "No prototype screenshot baseline for '$name' at ${result.baseline.path}. Record it with " +
            "./gradlew -p android :control-proxy:testDebugUnitTest -D$RECORD_PROPERTY=true " +
            "on the reference OS, then commit the PNG with the test.",
        )
      is PrototypeScreenshotComparator.Result.SizeMismatch ->
        fail(
          "Prototype screenshot '$name' size changed: baseline " +
            "${result.expectedWidth}x${result.expectedHeight}, actual " +
            "${result.actualWidth}x${result.actualHeight}. Rejected image: ${result.actualFile.path}",
        )
      is PrototypeScreenshotComparator.Result.Mismatch ->
        fail(
          "Prototype screenshot '$name' differs: ${result.differentPixelCount} pixels " +
            "(${"%.4f".format(Locale.ROOT, result.differentPixelRatio * 100)}%) exceed tolerance. " +
            "Diff: ${result.diffFile.path}, rejected: ${result.actualFile.path}. " +
            "If intentional, re-record with -D$RECORD_PROPERTY=true.",
        )
    }
  }
}

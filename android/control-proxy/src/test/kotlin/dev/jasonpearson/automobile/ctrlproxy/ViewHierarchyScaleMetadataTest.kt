package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.ViewHierarchy
import java.io.File
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Additive scale-reporting metadata on the hierarchy wire format (#4548, B1 of the canonical-pixel
 * campaign). Android accessibility bounds and screenshots are BOTH physical pixels, so the
 * bounds->pixel ratio the runner reports is exactly 1, and the pixel dimensions equal the reported
 * screen dimensions. iOS reports the same three fields with `UIScreen.nativeScale`.
 */
class ViewHierarchyScaleMetadataTest {

  /** Mirrors CtrlProxy's `jsonCompact` broadcast configuration. */
  private val wireJson = Json {
    prettyPrint = false
    encodeDefaults = true
  }

  private val lenientJson = Json { ignoreUnknownKeys = true }

  @Test
  fun `scale metadata serializes on the wire when present`() {
    val hierarchy =
      ViewHierarchy(
        updatedAt = 1L,
        screenWidth = 1080,
        screenHeight = 2340,
        nativeScale = 1f,
        pixelWidth = 1080,
        pixelHeight = 2340,
      )

    val encoded = wireJson.encodeToString(ViewHierarchy.serializer(), hierarchy)

    assertTrue(encoded, encoded.contains("\"nativeScale\":1.0"))
    assertTrue(encoded, encoded.contains("\"pixelWidth\":1080"))
    assertTrue(encoded, encoded.contains("\"pixelHeight\":2340"))
  }

  @Test
  fun `legacy payload without scale metadata decodes with absent fields`() {
    // A hierarchy JSON produced before #4548 must decode unchanged, with the additive
    // fields absent rather than invented.
    val legacy = """{"updatedAt":1,"screenWidth":1080,"screenHeight":2340}"""

    val decoded = lenientJson.decodeFromString(ViewHierarchy.serializer(), legacy)

    assertEquals(1080, decoded.screenWidth)
    assertNull(decoded.nativeScale)
    assertNull(decoded.pixelWidth)
    assertNull(decoded.pixelHeight)
  }

  @Test
  fun `pixel dimensions equal screen dimensions under the scale-1 contract`() {
    // On Android the reported bounds unit IS the screenshot pixel: any hierarchy carrying
    // the metadata must satisfy pixel == screen * 1 exactly.
    val hierarchy =
      ViewHierarchy(
        screenWidth = 1440,
        screenHeight = 3120,
        nativeScale = 1f,
        pixelWidth = 1440,
        pixelHeight = 3120,
      )

    assertEquals(hierarchy.screenWidth, hierarchy.pixelWidth)
    assertEquals(hierarchy.screenHeight, hierarchy.pixelHeight)
    assertEquals(1f, requireNotNull(hierarchy.nativeScale), 0f)
  }

  /**
   * Structural guard on the SHARED enrichment helper. `withScaleMetadata` is the single point that
   * attaches the scale metadata, and EVERY route that produces a hierarchy response must pass
   * through it — the debounced direct extraction ([extractHierarchyDirect]) and the ADB
   * EXTRACT_HIERARCHY broadcast ([extractHierarchy]). If the helper's scale-1 contract is altered,
   * or either route stops calling it, no serialization test above would notice. Scans the committed
   * source (the BroadcastGuardAdoptionTest mechanism) rather than executing the
   * AccessibilityService, which cannot be constructed in a unit test.
   */
  @Test
  fun `withScaleMetadata pins the scale-1 contract`() {
    val source = KotlinSourceScan.maskLiteralsAndComments(locateCtrlProxySource().readText())
    val marker = "private fun withScaleMetadata"
    val start = source.indexOf(marker)
    assertTrue("withScaleMetadata not found in CtrlProxy.kt", start >= 0)
    // The helper is a single-expression `copy(...)`; carve out its argument list.
    val parenOpen = source.indexOf('(', source.indexOf("hierarchy?.copy", start))
    val body = source.substring(parenOpen, KotlinSourceScan.matchParen(source, parenOpen))

    assertTrue(
      "Android must report exactly scale 1, gated on having dimensions (bounds are already pixels)",
      "nativeScale = if (screenDimensions != null) 1f else null" in body,
    )
    assertTrue(
      "pixelWidth must mirror the screen width (scale-1 contract)",
      "pixelWidth = screenDimensions?.width" in body,
    )
    assertTrue(
      "pixelHeight must mirror the screen height (scale-1 contract)",
      "pixelHeight = screenDimensions?.height" in body,
    )
  }

  @Test
  fun `every hierarchy route enriches scale metadata through the shared helper`() {
    val source = KotlinSourceScan.maskLiteralsAndComments(locateCtrlProxySource().readText())

    for (route in listOf("private fun extractHierarchyDirect", "private fun extractHierarchy(")) {
      val start = source.indexOf(route)
      assertTrue("$route not found in CtrlProxy.kt", start >= 0)
      val bodyOpen = source.indexOf('{', start)
      val body = source.substring(bodyOpen, KotlinSourceScan.matchBrace(source, bodyOpen))
      assertTrue(
        "$route must enrich scale metadata via withScaleMetadata so the daemon retains it off this route (#4548)",
        "withScaleMetadata(" in body,
      )
    }
  }

  @Test
  fun `adb hierarchy fallback brackets and stamps rotation`() {
    val source = KotlinSourceScan.maskLiteralsAndComments(locateCtrlProxySource().readText())
    val marker = "private fun extractHierarchy("
    val start = source.indexOf(marker)
    assertTrue("ADB hierarchy route not found in CtrlProxy.kt", start >= 0)
    val bodyOpen = source.indexOf('{', start)
    val body = source.substring(bodyOpen, KotlinSourceScan.matchBrace(source, bodyOpen))

    assertTrue(
      "ADB fallback must capture the display-change generation before hierarchy inputs",
      "val rotationCapture = rotationProvenance.beginCapture()" in body,
    )
    assertTrue(
      "ADB fallback must retain rotation only when the display-change generation is stable",
      "rotationProvenance.rotationIfUnchanged(" in body,
    )
    assertTrue(
      "ADB fallback must retain the prior endpoint guard until display callbacks arrive",
      "rotationAtCaptureStart" in body,
    )
    assertTrue(
      "ADB fallback must stamp only a stable rotation onto its hierarchy",
      "rotation = rotation" in body,
    )
    assertTrue(
      "ADB fallback must capture typed insets against the same screen dimensions",
      "val insets = getObservationInsets(screenDimensions)" in body,
    )
    assertTrue(
      "ADB fallback must preserve legacy system insets for compatibility",
      "systemInsets = legacySystemInsets(insets)" in body,
    )
    assertTrue(
      "ADB fallback must retain typed insets and display-cutout state",
      "insets = insets" in body,
    )
  }

  private fun locateCtrlProxySource(): File {
    val rel = "src/main/kotlin/dev/jasonpearson/automobile/ctrlproxy/CtrlProxy.kt"
    // The Gradle working directory may be the module root, `android`, or the repo root.
    val direct =
      listOf(File(rel), File("control-proxy/$rel"), File("android/control-proxy/$rel"))
        .firstOrNull { it.isFile }
    if (direct != null) return direct

    val userDir = System.getProperty("user.dir") ?: "."
    var dir: File? = File(userDir).absoluteFile
    while (dir != null) {
      for (candidate in
        listOf(
          File(dir, rel),
          File(dir, "control-proxy/$rel"),
          File(dir, "android/control-proxy/$rel"),
        )) {
        if (candidate.isFile) return candidate
      }
      dir = dir.parentFile
    }
    fail("Could not locate CtrlProxy.kt from user.dir=$userDir")
    error("unreachable")
  }
}

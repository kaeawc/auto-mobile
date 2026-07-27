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
   * Structural guard on the single hierarchy enrichment site: `extractHierarchyDirect` in
   * CtrlProxy.kt is the only place device metadata is attached to broadcast hierarchies, so if the
   * scale metadata assignments are removed there, no serialization test above would notice. Scans
   * the committed source (the BroadcastGuardAdoptionTest mechanism) rather than executing the
   * AccessibilityService, which cannot be constructed in a unit test.
   */
  @Test
  fun `extractHierarchyDirect attaches all three scale metadata fields`() {
    val source = KotlinSourceScan.maskLiteralsAndComments(locateCtrlProxySource().readText())
    val marker = "private fun extractHierarchyDirect"
    val start = source.indexOf(marker)
    assertTrue("extractHierarchyDirect not found in CtrlProxy.kt", start >= 0)
    val bodyOpen = source.indexOf('{', start)
    val body = source.substring(bodyOpen, KotlinSourceScan.matchBrace(source, bodyOpen))

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
    // Exactly one nativeScale assignment: a second one could override the scale-1 contract.
    assertEquals(
      "expected exactly one nativeScale assignment in extractHierarchyDirect",
      1,
      Regex("nativeScale\\s*=").findAll(body).count(),
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

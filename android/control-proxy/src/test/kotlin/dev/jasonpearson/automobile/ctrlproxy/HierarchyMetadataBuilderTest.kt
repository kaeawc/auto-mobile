package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.ObservationInsetsInfo
import dev.jasonpearson.automobile.ctrlproxy.models.SystemInsetsInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ViewHierarchy
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class HierarchyMetadataBuilderTest {
  @Test
  fun `builder applies the shared metadata set`() {
    val insets = ObservationInsetsInfo()
    val systemInsets = SystemInsetsInfo(top = 24, bottom = 48)
    val hierarchy =
      HierarchyMetadataBuilder.enrich(
        ViewHierarchy(),
        HierarchyMetadata(
          displayId = 2,
          panelUniqueId = "display-2",
          screenWidth = 1080,
          screenHeight = 2400,
          rotation = 1,
          systemInsets = systemInsets,
          insets = insets,
          wakefulness = "Awake",
          foregroundActivity = "com.example/.MainActivity",
          density = 420,
          sdkInt = 35,
          deviceModel = "Pixel",
          isEmulator = true,
          accessibilityTool = true,
        ),
      )

    assertNotNull(hierarchy)
    requireNotNull(hierarchy).run {
      assertEquals(2, displayId)
      assertEquals("display-2", panelUniqueId)
      assertEquals(1080, screenWidth)
      assertEquals(2400, screenHeight)
      assertEquals(1, rotation)
      assertEquals(systemInsets, this.systemInsets)
      assertEquals(insets, this.insets)
      assertEquals("Awake", wakefulness)
      assertEquals("com.example/.MainActivity", foregroundActivity)
      assertEquals(420, density)
      assertEquals(35, sdkInt)
      assertEquals("Pixel", deviceModel)
      assertEquals(true, isEmulator)
      assertEquals(true, accessibilityTool)
    }
  }

  @Test
  fun `both hierarchy routes use the shared metadata builder`() {
    val source = KotlinSourceScan.maskLiteralsAndComments(locateCtrlProxySource().readText())

    for (route in listOf("private fun extractHierarchyDirect", "private fun extractHierarchy(")) {
      val start = source.indexOf(route)
      assertTrue("$route not found in CtrlProxy.kt", start >= 0)
      val bodyOpen = source.indexOf('{', start)
      val body = source.substring(bodyOpen, KotlinSourceScan.matchBrace(source, bodyOpen))
      assertTrue(
        "$route must use the shared metadata builder",
        "HierarchyMetadataBuilder.enrich(" in body,
      )
    }

    val builder = locateBuilderSource().readText()
    for (field in
      listOf(
        "displayId",
        "panelUniqueId",
        "screenWidth",
        "screenHeight",
        "rotation",
        "systemInsets",
        "insets",
        "wakefulness",
        "foregroundActivity",
        "density",
        "sdkInt",
        "deviceModel",
        "isEmulator",
        "accessibilityTool",
      )) {
      assertTrue("shared builder must assign $field", "$field = metadata.$field" in builder)
    }
  }

  private fun locateCtrlProxySource(): File = locateSource("CtrlProxy.kt")

  private fun locateBuilderSource(): File = locateSource("HierarchyMetadataBuilder.kt")

  private fun locateSource(fileName: String): File {
    val rel = "src/main/kotlin/dev/jasonpearson/automobile/ctrlproxy/$fileName"
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
    fail("Could not locate $fileName from user.dir=$userDir")
    error("unreachable")
  }
}

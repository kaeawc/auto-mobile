package dev.jasonpearson.automobile.design.system.components

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/** Prevents feature screens from bypassing the design system's fixture-compatible components. */
class FeatureComponentMigrationTest {
  @Test
  fun featureContainersAndButtonsUseDesignSystem() {
    var root = File(System.getProperty("user.dir")).absoluteFile
    while (!File(root, "android/playground").isDirectory) {
      root = checkNotNull(root.parentFile) { "Cannot locate playground source" }
    }
    val modules = listOf("demos", "discover", "settings", "home", "mediaplayer", "slides")
    val components =
      listOf(
        "Button",
        "OutlinedButton",
        "TextButton",
        "FilledTonalButton",
        "ElevatedButton",
        "Card",
        "FilterChip",
        "NavigationBar",
        "TopAppBar",
        "TextField",
        "OutlinedTextField",
      )
    // Low-contrast/tiny-target fixtures must stay deliberate defects. Chat's custom-shaped
    // input and content-slot FAB are not supported by the existing public component signatures.
    val preservedScreens = setOf("AccessibilityScreens.kt", "ChatScreen.kt")
    for (module in modules) {
      val sources = File(root, "android/playground/$module/src/main/kotlin")
      for (file in sources.walkTopDown().filter { it.extension == "kt" }) {
        if (file.name in preservedScreens) continue
        val imports = file.readLines().filter { it.startsWith("import ") }.toSet()
        val bypasses = components.filter { "import androidx.compose.material3.$it" in imports }
        assertTrue("${file.name} bypasses the design system: $bypasses", bypasses.isEmpty())
      }
    }
  }
}

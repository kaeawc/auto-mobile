package dev.jasonpearson.automobile.desktop.core

import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class AutoMobileContentDecompositionTest {
  private val sourceRoot = Path.of("src/main/kotlin/dev/jasonpearson/automobile/desktop/core")

  @Test
  fun `AutoMobileContent delegates extracted concerns to sibling source files`() {
    val autoMobileContent = sourceRoot.resolve("AutoMobileContent.kt").readSource()

    mapOf(
        "DeviceFilterPersistence.kt" to
          listOf(
            "data class DeviceFilterState",
            "fun loadDeviceFilter",
            "fun saveDeviceFilter",
          ),
        "DeviceIcon.kt" to listOf("fun DeviceIcon", "fun AndroidDeviceIcon", "fun AppleDeviceIcon"),
        "McpProcessesPanel.kt" to
          listOf("fun McpProcessesPanel", "fun ProcessSection", "fun McpProcessItem"),
        "DevicesSection.kt" to
          listOf("fun DevicesSection", "fun DeviceImagesGrouped", "fun BootedDeviceRow"),
        "AppSelectorDropdown.kt" to listOf("fun AppSelectorDropdown", "fun AppDropdownItem"),
      )
      .forEach { (fileName, declarations) ->
        val extractedSource = sourceRoot.resolve(fileName).readSource()
        declarations.forEach { declaration ->
          assertTrue(
            extractedSource.contains(declaration),
            "$fileName should own $declaration",
          )
          assertFalse(
            autoMobileContent.contains(declaration),
            "AutoMobileContent.kt should not still own $declaration",
          )
        }
      }
  }

  private fun Path.readSource(): String {
    assertTrue(Files.exists(this), "$this should exist")
    return Files.readString(this)
  }
}

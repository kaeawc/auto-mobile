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
        "DeviceManagementPanel.kt" to
          listOf(
            "fun DeviceManagementPanel",
            "fun DeviceSectionHeader",
            "fun DeviceListItem",
          ),
        "DevicesSection.kt" to
          listOf("fun DevicesSection", "fun DeviceImagesGrouped", "fun BootedDeviceRow"),
        "shell/LeftSidebarPanel.kt" to listOf("fun LeftSidebarPanel"),
        "shell/AvailableDeviceImagesSection.kt" to
          listOf("fun AvailableDeviceImagesSection", "fun FilterChip"),
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

  @Test
  fun `left slot uses the panel and delegates image controls without the stub`() {
    val source = sourceRoot.resolve("AutoMobileContent.kt").readSource()
    val leftSlot =
      source.substringAfter("leftPaneContent = {").substringBefore("rightPaneContent = {")
    assertTrue(leftSlot.contains("LeftSidebarPanel("))
    assertTrue(leftSlot.contains("AvailableDeviceImagesSection("))
    assertTrue(leftSlot.contains("onRetryDetection = { mcpConnectRetryCounter++ }"))
    assertFalse(leftSlot.contains("Stub: replaced by real LeftSidebarPanel"))
    assertFalse(leftSlot.contains("devices.forEach"))
    assertFalse(leftSlot.contains("loadDeviceFilter"))
  }

  private fun Path.readSource(): String {
    assertTrue(Files.exists(this), "$this should exist")
    return Files.readString(this)
  }
}

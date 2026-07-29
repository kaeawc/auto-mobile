package dev.jasonpearson.automobile.desktop.core.workspace.picker

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.workspace.Platform
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class DevicePickerUiTest {

  private val devices =
    listOf(
      PickerDevice("p8", "Pixel 8", Platform.Android, DeviceState.Booted, "34", "API 34"),
      PickerDevice("i15", "iPhone 15", Platform.Ios, DeviceState.Shutdown, "17", "iOS 17", "arm64"),
    )

  private fun content(selected: Set<String> = emptySet()) =
    DevicePickerUiState.Content(devices, PickerFilters(), selected)

  @Test
  fun `renders rail options and device cards`() = runComposeUiTest {
    setContent { MaterialTheme { DevicePicker(content(), onAction = {}, onClose = {}) } }
    onNodeWithContentDescription("Select filter Booted").assertIsDisplayed()
    onNodeWithContentDescription("Select filter Android").assertIsDisplayed()
    onNodeWithText("Pixel 8", substring = true).assertIsDisplayed()
    onNodeWithContentDescription("Select Pixel 8").assertIsDisplayed()
    onNodeWithContentDescription("iPhone 15 (not booted)").assertIsDisplayed()
  }

  @Test
  fun `clicking a filter option dispatches its toggle`() = runComposeUiTest {
    var action: DevicePickerAction? = null
    setContent {
      MaterialTheme { DevicePicker(content(), onAction = { action = it }, onClose = {}) }
    }
    onNodeWithContentDescription("Select filter Android").performClick()
    assertEquals(DevicePickerAction.TogglePlatform(Platform.Android), action)
  }

  @Test
  fun `clicking a booted card dispatches ToggleSelect`() = runComposeUiTest {
    var action: DevicePickerAction? = null
    setContent {
      MaterialTheme { DevicePicker(content(), onAction = { action = it }, onClose = {}) }
    }
    onNodeWithContentDescription("Select Pixel 8").performClick()
    assertEquals(DevicePickerAction.ToggleSelect("p8"), action)
  }

  @Test
  fun `observe is disabled with no selection and enabled + dispatches with a selection`() =
    runComposeUiTest {
      var action: DevicePickerAction? = null
      setContent {
        MaterialTheme {
          DevicePicker(content(selected = setOf("p8")), onAction = { action = it }, onClose = {})
        }
      }
      onNodeWithContentDescription("Observe selected").assertIsEnabled().performClick()
      assertEquals(DevicePickerAction.ObserveSelected, action)
    }

  @Test
  fun `observe is disabled when nothing is selected`() = runComposeUiTest {
    setContent { MaterialTheme { DevicePicker(content(), onAction = {}, onClose = {}) } }
    onNodeWithContentDescription("Observe selected").assertIsNotEnabled()
  }

  @Test
  fun `close invokes onClose`() = runComposeUiTest {
    var closed = false
    setContent {
      MaterialTheme { DevicePicker(content(), onAction = {}, onClose = { closed = true }) }
    }
    onNodeWithContentDescription("Close picker").performClick()
    assertTrue(closed)
  }
}

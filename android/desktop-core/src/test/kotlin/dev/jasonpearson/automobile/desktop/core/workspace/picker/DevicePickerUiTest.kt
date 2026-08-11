package dev.jasonpearson.automobile.desktop.core.workspace.picker

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
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

  private fun content(
    selected: Set<String> = emptySet(),
    bootingIds: Set<String> = emptySet(),
    bootErrors: Map<String, String> = emptyMap(),
  ) = DevicePickerUiState.Content(devices, PickerFilters(), selected, bootingIds, bootErrors)

  // Stub the hoisted thumbnail so composing the grid never opens a video/observation socket.
  private fun ComposeUiTest.picker(
    state: DevicePickerUiState.Content = content(),
    onAction: (DevicePickerAction) -> Unit = {},
    onClose: () -> Unit = {},
    canClose: Boolean = true,
  ) = setContent {
    MaterialTheme {
      DevicePicker(
        state,
        onAction = onAction,
        onClose = onClose,
        canClose = canClose,
        thumbnail = { _, _ -> },
      )
    }
  }

  @Test
  fun `renders rail options and device cards`() = runComposeUiTest {
    picker()
    onNodeWithContentDescription("Select filter Booted").assertIsDisplayed()
    onNodeWithContentDescription("Select filter Android").assertIsDisplayed()
    onNodeWithText("Pixel 8", substring = true).assertIsDisplayed()
    onNodeWithContentDescription("Observe Pixel 8").assertIsDisplayed()
    onNodeWithContentDescription("Boot iPhone 15").assertIsDisplayed()
    onNodeWithText("Click to boot").assertIsDisplayed()
  }

  @Test
  fun `plain-clicking a booted card observes it immediately`() = runComposeUiTest {
    var action: DevicePickerAction? = null
    picker(onAction = { action = it })
    onNodeWithContentDescription("Observe Pixel 8").performClick()
    assertEquals(DevicePickerAction.ObserveOne("p8"), action)
  }

  @Test
  fun `clicking a shut-down card dispatches BootDevice`() = runComposeUiTest {
    var action: DevicePickerAction? = null
    picker(onAction = { action = it })
    onNodeWithContentDescription("Boot iPhone 15").performClick()
    assertEquals(DevicePickerAction.BootDevice("i15"), action)
  }

  @Test
  fun `a booting card shows Booting and offers no boot affordance`() = runComposeUiTest {
    picker(content(bootingIds = setOf("i15")))
    // No boot/retry affordance while a boot is in flight — the card is a passive "Booting…".
    onNodeWithText("Booting…").assertIsDisplayed()
    onNodeWithText("Click to boot").assertDoesNotExist()
    onNodeWithContentDescription("Boot iPhone 15").assertDoesNotExist()
    onNodeWithContentDescription("Retry boot iPhone 15").assertDoesNotExist()
  }

  @Test
  fun `a failed card offers a retry that dispatches BootDevice`() = runComposeUiTest {
    var action: DevicePickerAction? = null
    picker(content(bootErrors = mapOf("i15" to "boom")), onAction = { action = it })
    onNodeWithText("Boot failed · Click to retry").assertIsDisplayed()
    onNodeWithContentDescription("Retry boot iPhone 15").performClick()
    assertEquals(DevicePickerAction.BootDevice("i15"), action)
  }

  @Test
  fun `clicking a filter option dispatches its toggle`() = runComposeUiTest {
    var action: DevicePickerAction? = null
    picker(onAction = { action = it })
    onNodeWithContentDescription("Select filter Android").performClick()
    assertEquals(DevicePickerAction.TogglePlatform(Platform.Android), action)
  }

  @Test
  fun `the observe-selected button appears only once a selection exists and dispatches`() =
    runComposeUiTest {
      var action: DevicePickerAction? = null
      picker(content(selected = setOf("p8")), onAction = { action = it })
      onNodeWithContentDescription("Observe selected").assertIsEnabled().performClick()
      assertEquals(DevicePickerAction.ObserveSelected, action)
    }

  @Test
  fun `no observe-selected button is shown when nothing is selected`() = runComposeUiTest {
    picker()
    onNodeWithContentDescription("Observe selected").assertDoesNotExist()
  }

  @Test
  fun `close invokes onClose when closable`() = runComposeUiTest {
    var closed = false
    picker(onClose = { closed = true })
    onNodeWithContentDescription("Close picker").performClick()
    assertTrue(closed)
  }

  @Test
  fun `close is hidden when the grid is the home surface`() = runComposeUiTest {
    picker(canClose = false)
    onNodeWithContentDescription("Close picker").assertDoesNotExist()
  }
}

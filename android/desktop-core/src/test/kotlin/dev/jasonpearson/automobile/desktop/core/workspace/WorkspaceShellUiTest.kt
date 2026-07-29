package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class WorkspaceShellUiTest {

  private fun col(id: String, name: String, platform: Platform = Platform.Android) =
    DeviceColumn(deviceId = id, name = name, platform = platform)

  @Test
  fun `empty state prompts to open Devices`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        WorkspaceShell(state = WorkspaceUiState.Empty, onAction = {}, onOpenPicker = {})
      }
    }
    onNodeWithText("No devices observed", substring = true).assertIsDisplayed()
    onNodeWithContentDescription("Open Devices").assertIsDisplayed()
  }

  @Test
  fun `empty state Open Devices click invokes callback`() = runComposeUiTest {
    var opened = false
    setContent {
      MaterialTheme {
        WorkspaceShell(
          state = WorkspaceUiState.Empty,
          onAction = {},
          onOpenPicker = { opened = true },
        )
      }
    }
    onNodeWithContentDescription("Open Devices").performClick()
    assertTrue(opened)
  }

  @Test
  fun `content renders the device chip header with tools and close`() = runComposeUiTest {
    val state =
      WorkspaceUiState.Content(columns = listOf(col("a", "Pixel 8")), focusedDeviceId = "a")
    setContent { MaterialTheme { WorkspaceShell(state = state, onAction = {}, onOpenPicker = {}) } }
    onNodeWithText("Pixel 8").assertIsDisplayed()
    onNodeWithContentDescription("Input mode").assertIsDisplayed()
    onNodeWithContentDescription("Inspect mode").assertIsDisplayed()
    onNodeWithContentDescription("Navigation Pixel 8").assertIsDisplayed()
    onNodeWithContentDescription("Performance Pixel 8").assertIsDisplayed()
    onNodeWithContentDescription("Close Pixel 8").assertIsDisplayed()
  }

  @Test
  fun `clicking close emits CloseDevice for that column`() = runComposeUiTest {
    var action: WorkspaceAction? = null
    val state =
      WorkspaceUiState.Content(columns = listOf(col("a", "Pixel 8")), focusedDeviceId = "a")
    setContent {
      MaterialTheme { WorkspaceShell(state = state, onAction = { action = it }, onOpenPicker = {}) }
    }
    onNodeWithContentDescription("Close Pixel 8").performClick()
    assertEquals(WorkspaceAction.CloseDevice("a"), action)
  }

  @Test
  fun `two devices render both chips`() = runComposeUiTest {
    val state =
      WorkspaceUiState.Content(
        columns = listOf(col("a", "Pixel 8"), col("b", "iPhone 15", Platform.Ios)),
        focusedDeviceId = "a",
      )
    setContent { MaterialTheme { WorkspaceShell(state = state, onAction = {}, onOpenPicker = {}) } }
    onNodeWithText("Pixel 8").assertIsDisplayed()
    onNodeWithText("iPhone 15").assertIsDisplayed()
  }

  @Test
  fun `pane renders rotate screenshot and snapshot controls`() = runComposeUiTest {
    val state =
      WorkspaceUiState.Content(columns = listOf(col("a", "Pixel 8")), focusedDeviceId = "a")
    setContent { MaterialTheme { WorkspaceShell(state = state, onAction = {}, onOpenPicker = {}) } }
    onNodeWithContentDescription("Rotate Pixel 8").assertIsDisplayed()
    onNodeWithContentDescription("Screenshot Pixel 8").assertIsDisplayed()
    onNodeWithContentDescription("Snapshot Pixel 8").assertIsDisplayed()
  }

  @Test
  fun `Unlock control appears only when the device is locked`() = runComposeUiTest {
    val state =
      WorkspaceUiState.Content(
        columns = listOf(col("a", "Pixel 8").copy(locked = true)),
        focusedDeviceId = "a",
      )
    setContent { MaterialTheme { WorkspaceShell(state = state, onAction = {}, onOpenPicker = {}) } }
    onNodeWithContentDescription("Unlock Pixel 8").assertIsDisplayed()
  }

  @Test
  fun `Unlock control is absent when the device is unlocked`() = runComposeUiTest {
    val state =
      WorkspaceUiState.Content(columns = listOf(col("a", "Pixel 8")), focusedDeviceId = "a")
    setContent { MaterialTheme { WorkspaceShell(state = state, onAction = {}, onOpenPicker = {}) } }
    onNodeWithContentDescription("Unlock Pixel 8").assertDoesNotExist()
  }

  @Test
  fun `clicking a control dispatches RunControl for that column`() = runComposeUiTest {
    var action: WorkspaceAction? = null
    val state =
      WorkspaceUiState.Content(columns = listOf(col("a", "Pixel 8")), focusedDeviceId = "a")
    setContent {
      MaterialTheme { WorkspaceShell(state = state, onAction = { action = it }, onOpenPicker = {}) }
    }
    onNodeWithContentDescription("Screenshot Pixel 8").performClick()
    assertEquals(WorkspaceAction.RunControl("a", EmulatorControl.Screenshot), action)
  }

  @Test
  fun `active tool renders a docked facet with a close control`() = runComposeUiTest {
    val state =
      WorkspaceUiState.Content(
        columns = listOf(col("a", "Pixel 8").copy(activeTool = Tool.Logs)),
        focusedDeviceId = "a",
      )
    setContent { MaterialTheme { WorkspaceShell(state = state, onAction = {}, onOpenPicker = {}) } }
    onNodeWithContentDescription("Close Logs facet on Pixel 8").assertIsDisplayed()
  }

  @Test
  fun `no active tool renders no facet`() = runComposeUiTest {
    val state =
      WorkspaceUiState.Content(columns = listOf(col("a", "Pixel 8")), focusedDeviceId = "a")
    setContent { MaterialTheme { WorkspaceShell(state = state, onAction = {}, onOpenPicker = {}) } }
    onNodeWithContentDescription("Close Logs facet on Pixel 8").assertDoesNotExist()
  }

  @Test
  fun `facet close deselects the active tool`() = runComposeUiTest {
    var action: WorkspaceAction? = null
    val state =
      WorkspaceUiState.Content(
        columns = listOf(col("a", "Pixel 8").copy(activeTool = Tool.Logs)),
        focusedDeviceId = "a",
      )
    setContent {
      MaterialTheme { WorkspaceShell(state = state, onAction = { action = it }, onOpenPicker = {}) }
    }
    onNodeWithContentDescription("Close Logs facet on Pixel 8").performClick()
    assertEquals(WorkspaceAction.SelectTool("a", null), action)
  }

  @Test
  fun `re-tapping the active tool toggles it off`() = runComposeUiTest {
    var action: WorkspaceAction? = null
    val state =
      WorkspaceUiState.Content(
        columns = listOf(col("a", "Pixel 8").copy(activeTool = Tool.Logs)),
        focusedDeviceId = "a",
      )
    setContent {
      MaterialTheme { WorkspaceShell(state = state, onAction = { action = it }, onOpenPicker = {}) }
    }
    onNodeWithContentDescription("Logs Pixel 8").performClick()
    assertEquals(WorkspaceAction.SelectTool("a", null), action)
  }

  @Test
  fun `tapping an inactive tool selects it`() = runComposeUiTest {
    var action: WorkspaceAction? = null
    val state =
      WorkspaceUiState.Content(columns = listOf(col("a", "Pixel 8")), focusedDeviceId = "a")
    setContent {
      MaterialTheme { WorkspaceShell(state = state, onAction = { action = it }, onOpenPicker = {}) }
    }
    onNodeWithContentDescription("Storage Pixel 8").performClick()
    assertEquals(WorkspaceAction.SelectTool("a", Tool.Storage), action)
  }
}

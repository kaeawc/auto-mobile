package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class WorkspaceCompareEntryTest {

  private fun col(id: String, name: String, platform: Platform = Platform.Android) =
    DeviceColumn(deviceId = id, name = name, platform = platform)

  @Test
  fun `compareColumns is null with a single device`() {
    val content =
      WorkspaceUiState.Content(columns = listOf(col("a", "Pixel")), focusedDeviceId = "a")
    assertNull(compareColumns(content))
  }

  @Test
  fun `compareColumns pairs the focused device with the first same-platform other`() {
    val content =
      WorkspaceUiState.Content(
        columns =
          listOf(
            col("a", "Pixel", Platform.Android),
            col("b", "iPhone", Platform.Ios),
            col("c", "Tab", Platform.Android),
          ),
        focusedDeviceId = "a",
      )
    val pair = compareColumns(content)
    // Skips the iOS device b (cross-platform diff is meaningless) and pairs with the Android c.
    assertEquals("a", pair?.first?.deviceId)
    assertEquals("c", pair?.second?.deviceId)
  }

  @Test
  fun `compareColumns is null when the only other device is a different platform`() {
    val content =
      WorkspaceUiState.Content(
        columns = listOf(col("a", "Pixel", Platform.Android), col("b", "iPhone", Platform.Ios)),
        focusedDeviceId = "a",
      )
    assertNull(compareColumns(content))
  }

  @Test
  fun `compare glyph is hidden when the only other device is a different platform`() =
    runComposeUiTest {
      val state =
        WorkspaceUiState.Content(
          columns = listOf(col("a", "Pixel", Platform.Android), col("b", "iPhone", Platform.Ios)),
          focusedDeviceId = "a",
        )
      setContent {
        MaterialTheme { WorkspaceShell(state = state, onAction = {}, onOpenPicker = {}) }
      }
      onNodeWithContentDescription("Compare two devices").assertDoesNotExist()
    }

  @Test
  fun `compare glyph is hidden with a single device`() = runComposeUiTest {
    val state = WorkspaceUiState.Content(columns = listOf(col("a", "Pixel")), focusedDeviceId = "a")
    setContent { MaterialTheme { WorkspaceShell(state = state, onAction = {}, onOpenPicker = {}) } }
    onNodeWithContentDescription("Compare two devices").assertDoesNotExist()
  }

  @Test
  fun `compare glyph opens the compare surface for the focused device and one other`() =
    runComposeUiTest {
      val state =
        WorkspaceUiState.Content(
          columns = listOf(col("a", "Pixel"), col("b", "iPhone")),
          focusedDeviceId = "a",
        )
      setContent {
        MaterialTheme {
          WorkspaceShell(
            state = state,
            onAction = {},
            onOpenPicker = {},
            compareContent = { a, b -> Text("compare ${a.deviceId} vs ${b.deviceId}") },
          )
        }
      }
      onNodeWithContentDescription("Compare two devices").assertIsDisplayed()
      onNodeWithContentDescription("Compare two devices").performClick()

      onNodeWithContentDescription("Compare devices").assertIsDisplayed()
      onNodeWithText("compare a vs b").assertIsDisplayed()
    }

  @Test
  fun `compare overlay closes on the close affordance`() = runComposeUiTest {
    val state =
      WorkspaceUiState.Content(
        columns = listOf(col("a", "Pixel"), col("b", "iPhone")),
        focusedDeviceId = "a",
      )
    setContent {
      MaterialTheme {
        WorkspaceShell(
          state = state,
          onAction = {},
          onOpenPicker = {},
          compareContent = { _, _ -> Text("compare-body") },
        )
      }
    }
    onNodeWithContentDescription("Compare two devices").performClick()
    onNodeWithText("compare-body").assertIsDisplayed()
    onNodeWithContentDescription("Close compare").performClick()
    onNodeWithText("compare-body").assertDoesNotExist()
  }
}

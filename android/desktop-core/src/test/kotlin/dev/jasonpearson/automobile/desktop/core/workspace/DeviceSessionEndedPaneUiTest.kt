package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class DeviceSessionEndedPaneUiTest {
  private val live =
    DeviceColumn(
      deviceId = "emulator-5554",
      name = "Pixel",
      platform = Platform.Android,
      activeTool = Tool.Logs,
      deviceSessionUuid = "epoch-a",
    )

  private fun content(column: DeviceColumn) =
    WorkspaceUiState.Content(listOf(column), focusedDeviceId = column.deviceId)

  @Test
  fun `an ended epoch disposes the pane's stream and facet and shows the disconnected state`() =
    runComposeUiTest {
      val state = mutableStateOf<WorkspaceUiState>(content(live))
      val actions = mutableListOf<WorkspaceAction>()
      var streamsOpen = 0
      var facetsOpen = 0
      setContent {
        MaterialTheme {
          WorkspaceShell(
            state = state.value,
            onAction = { actions += it },
            options =
              WorkspaceShellOptions(
                onOpenPicker = {},
                streamContent = {
                  DisposableEffect(Unit) {
                    streamsOpen++
                    onDispose { streamsOpen-- }
                  }
                },
                facetContent = { _, _ ->
                  DisposableEffect(Unit) {
                    facetsOpen++
                    onDispose { facetsOpen-- }
                  }
                },
              ),
          )
        }
      }
      waitForIdle()
      assertEquals(1, streamsOpen)
      assertEquals(1, facetsOpen)

      state.value = content(live.copy(deviceSessionUuid = null, sessionEnded = true))
      waitForIdle()

      assertEquals(0, streamsOpen)
      assertEquals(0, facetsOpen)
      onNodeWithContentDescription(DEVICE_SESSION_ENDED_DESCRIPTION).assertIsDisplayed()
      // The header stays, so the user can still close the pane.
      onNodeWithContentDescription("Close Pixel").performClick()
      assertEquals(listOf<WorkspaceAction>(WorkspaceAction.CloseDevice("emulator-5554")), actions)

      state.value = content(live.copy(deviceSessionUuid = "epoch-b"))
      waitForIdle()
      assertEquals(1, streamsOpen)
      assertEquals(1, facetsOpen)
    }
}

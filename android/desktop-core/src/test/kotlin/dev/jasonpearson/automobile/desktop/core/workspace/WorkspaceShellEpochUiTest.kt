package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runComposeUiTest
import org.junit.Test

/** A pane's composition is keyed on its device epoch, not only its serial. */
@OptIn(ExperimentalTestApi::class)
internal class WorkspaceShellEpochUiTest {

  private fun column(id: String, epoch: String?) =
    DeviceColumn(
      deviceId = id,
      name = "Device $id",
      platform = Platform.Android,
      deviceSessionUuid = epoch,
    )

  @Test
  fun `a new epoch of a reused serial drops only that pane's remembered state`() =
    runComposeUiTest {
      var instances = 0
      val epochA = mutableStateOf("epoch-1")
      setContent {
        MaterialTheme {
          WorkspaceShell(
            state =
              WorkspaceUiState.Content(
                columns = listOf(column("a", epochA.value), column("b", "epoch-b")),
                focusedDeviceId = "a",
              ),
            onAction = {},
            options =
              WorkspaceShellOptions(
                onOpenPicker = {},
                streamContent = { column ->
                  val instance = remember { ++instances }
                  Text("stream:${column.deviceId}:$instance")
                },
              ),
          )
        }
      }
      onNodeWithText("stream:a:1").assertIsDisplayed()
      onNodeWithText("stream:b:2").assertIsDisplayed()

      runOnIdle { epochA.value = "epoch-2" }

      onNodeWithText("stream:a:3").assertIsDisplayed()
      onNodeWithText("stream:a:1").assertDoesNotExist()
      onNodeWithText("stream:b:2").assertIsDisplayed()
    }
}

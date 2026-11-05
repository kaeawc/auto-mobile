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

  private fun column(id: String, epoch: String?, generation: Int = 0) =
    DeviceColumn(
      deviceId = id,
      name = "Device $id",
      platform = Platform.Android,
      deviceSessionUuid = epoch,
      epochGeneration = generation,
    )

  @Test
  fun `a replaced epoch drops only that pane's remembered state and a UUID refresh keeps it`() =
    runComposeUiTest {
      var instances = 0
      val epochA = mutableStateOf("epoch-1" to 0)
      setContent {
        MaterialTheme {
          WorkspaceShell(
            state =
              WorkspaceUiState.Content(
                columns =
                  listOf(
                    column("a", epochA.value.first, epochA.value.second),
                    column("b", "epoch-b"),
                  ),
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

      // A daemon restart re-mints the UUID without replacing the epoch: nothing is forgotten.
      runOnIdle { epochA.value = "epoch-1b" to 0 }
      onNodeWithText("stream:a:1").assertIsDisplayed()

      // A replaced epoch (reboot) starts the pane over.
      runOnIdle { epochA.value = "epoch-2" to 1 }

      onNodeWithText("stream:a:3").assertIsDisplayed()
      onNodeWithText("stream:a:1").assertDoesNotExist()
      onNodeWithText("stream:b:2").assertIsDisplayed()
    }
}

package dev.jasonpearson.automobile.desktop.core.device

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.daemon.AppearanceConfig
import dev.jasonpearson.automobile.desktop.core.daemon.FakeAppearanceClient
import dev.jasonpearson.automobile.desktop.core.daemon.FakeVideoRecordingActions
import dev.jasonpearson.automobile.desktop.core.daemon.FakeVideoRecordingConfigClient
import dev.jasonpearson.automobile.desktop.core.daemon.VideoRecordingConfig
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class DeviceControlsDashboardUiTest {

  @Test
  fun `renders both control groups`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        DeviceControlsDashboard(
          appearanceClient = FakeAppearanceClient(),
          recordingActions = FakeVideoRecordingActions(),
          recordingConfigClient = FakeVideoRecordingConfigClient(),
          activeDeviceId = "emulator-5554",
        )
      }
    }

    onNodeWithText("Appearance").assertIsDisplayed()
    onNodeWithText("Video recording").assertIsDisplayed()
  }

  @Test
  fun `appearance is labelled as applying to all devices, not the active one`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        DeviceControlsDashboard(
          appearanceClient = FakeAppearanceClient(),
          recordingActions = FakeVideoRecordingActions(),
          recordingConfigClient = FakeVideoRecordingConfigClient(),
          activeDeviceId = "emulator-5554",
        )
      }
    }

    onNodeWithText("Applies to all connected devices.").assertIsDisplayed()
  }

  @Test
  fun `degrades when the appearance socket is absent`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        DeviceControlsDashboard(
          appearanceClient = FakeAppearanceClient(available = false),
          recordingActions = FakeVideoRecordingActions(),
          recordingConfigClient = FakeVideoRecordingConfigClient(),
          activeDeviceId = "emulator-5554",
        )
      }
    }

    onNodeWithText("Appearance control is unavailable on this daemon.").assertIsDisplayed()
    // Recording must still work.
    onNodeWithText("Record").assertIsDisplayed()
  }

  @Test
  fun `prompts for a device before recording`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        DeviceControlsDashboard(
          appearanceClient = FakeAppearanceClient(),
          recordingActions = FakeVideoRecordingActions(),
          recordingConfigClient = FakeVideoRecordingConfigClient(),
          activeDeviceId = null,
        )
      }
    }

    onNodeWithText("Select a device to record.").assertIsDisplayed()
  }

  @Test
  fun `shows the recording config summary`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        DeviceControlsDashboard(
          appearanceClient = FakeAppearanceClient(),
          recordingActions = FakeVideoRecordingActions(),
          recordingConfigClient =
            FakeVideoRecordingConfigClient(
              VideoRecordingConfig(qualityPreset = "high", fps = 60, maxArchiveSizeMb = 2048)
            ),
          activeDeviceId = "emulator-5554",
        )
      }
    }

    onNodeWithText("high", substring = true).assertIsDisplayed()
  }

  @Test
  fun `setting an explicit mode warns that host sync is now off`() = runComposeUiTest {
    // The daemon couples these; surfacing it prevents the setting looking self-changing.
    setContent {
      MaterialTheme {
        DeviceControlsDashboard(
          appearanceClient =
            FakeAppearanceClient(AppearanceConfig(syncWithHost = false, defaultMode = "dark")),
          recordingActions = FakeVideoRecordingActions(),
          recordingConfigClient = FakeVideoRecordingConfigClient(),
          activeDeviceId = "emulator-5554",
        )
      }
    }

    onNodeWithText("turns off host sync", substring = true).assertIsDisplayed()
  }

  @Test
  fun `auto mode does not warn about host sync`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        DeviceControlsDashboard(
          appearanceClient =
            FakeAppearanceClient(AppearanceConfig(syncWithHost = true, defaultMode = "auto")),
          recordingActions = FakeVideoRecordingActions(),
          recordingConfigClient = FakeVideoRecordingConfigClient(),
          activeDeviceId = "emulator-5554",
        )
      }
    }

    onNodeWithText("turns off host sync", substring = true).assertDoesNotExist()
  }

  @Test
  fun `recording toggles to stop once started`() = runComposeUiTest {
    val actions = FakeVideoRecordingActions()
    setContent {
      MaterialTheme {
        DeviceControlsDashboard(
          appearanceClient = FakeAppearanceClient(),
          recordingActions = actions,
          recordingConfigClient = FakeVideoRecordingConfigClient(),
          activeDeviceId = "emulator-5554",
        )
      }
    }

    onNodeWithText("Record").performClick()
    waitUntil(timeoutMillis = ACTION_TIMEOUT_MS) { actions.isRecording }
  }

  @Test
  fun `stopping a segmented session lists every segment`() = runComposeUiTest {
    val actions = FakeVideoRecordingActions(segmentsPerStop = 3)
    setContent {
      MaterialTheme {
        DeviceControlsDashboard(
          appearanceClient = FakeAppearanceClient(),
          recordingActions = actions,
          recordingConfigClient = FakeVideoRecordingConfigClient(),
          activeDeviceId = "emulator-5554",
        )
      }
    }

    onNodeWithText("Record").performClick()
    waitUntil(timeoutMillis = ACTION_TIMEOUT_MS) { actions.isRecording }

    onNodeWithText("Stop").performClick()
    waitUntil(timeoutMillis = ACTION_TIMEOUT_MS) { !actions.isRecording }

    onNodeWithText("Segment 0").assertIsDisplayed()
    onNodeWithText("Segment 2").assertIsDisplayed()
  }

  private companion object {
    const val ACTION_TIMEOUT_MS = 5_000L
  }
}

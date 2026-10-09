package dev.jasonpearson.automobile.desktop.core.device

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.daemon.AppearanceConfig
import dev.jasonpearson.automobile.desktop.core.daemon.FakeAppearanceClient
import dev.jasonpearson.automobile.desktop.core.daemon.FakeVideoRecordingActions
import dev.jasonpearson.automobile.desktop.core.daemon.FakeVideoRecordingConfigClient
import dev.jasonpearson.automobile.desktop.core.daemon.FakeWebRtcStreamClient
import dev.jasonpearson.automobile.desktop.core.daemon.VideoRecordingActions
import dev.jasonpearson.automobile.desktop.core.daemon.VideoRecordingArtifact
import dev.jasonpearson.automobile.desktop.core.daemon.VideoRecordingConfig
import dev.jasonpearson.automobile.desktop.core.daemon.VideoRecordingStopResult
import kotlin.test.assertEquals
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
          streamClient = FakeWebRtcStreamClient(),
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
          streamClient = FakeWebRtcStreamClient(),
          activeDeviceId = "emulator-5554",
        )
      }
    }

    // The daemon applies appearance only to devices this session controls (#10831).
    onNodeWithText(
        "Applies to the devices this session controls; changing it takes control of the " +
          "selected device.",
      )
      .assertIsDisplayed()
  }

  @Test
  fun `degrades when the appearance socket is absent`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        DeviceControlsDashboard(
          appearanceClient = FakeAppearanceClient(available = false),
          recordingActions = FakeVideoRecordingActions(),
          recordingConfigClient = FakeVideoRecordingConfigClient(),
          streamClient = FakeWebRtcStreamClient(),
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
          streamClient = FakeWebRtcStreamClient(),
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
              VideoRecordingConfig(qualityPreset = "high", fps = 60, maxArchiveSizeMb = 2048),
            ),
          streamClient = FakeWebRtcStreamClient(),
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
          streamClient = FakeWebRtcStreamClient(),
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
          streamClient = FakeWebRtcStreamClient(),
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
          streamClient = FakeWebRtcStreamClient(),
          activeDeviceId = "emulator-5554",
        )
      }
    }

    onNodeWithText("Record").performClick()
    waitUntil(timeoutMillis = ACTION_TIMEOUT_MS) { actions.isRecording }
  }

  @Test
  fun `a release stops the recording and the dashboard offers its artifact (#10978)`() =
    runComposeUiTest {
      val actions = FakeVideoRecordingActions().apply { failsDeviceStopWhenIdle = true }
      val released = mutableStateOf<String?>(null)
      setContent {
        MaterialTheme {
          DeviceControlsDashboard(
            appearanceClient = FakeAppearanceClient(),
            recordingActions = actions,
            recordingConfigClient = FakeVideoRecordingConfigClient(),
            streamClient = FakeWebRtcStreamClient(),
            activeDeviceId = "emulator-5554",
            releasedDeviceId = released.value,
          )
        }
      }
      onNodeWithText("Record").performClick()
      waitUntil(timeoutMillis = ACTION_TIMEOUT_MS) { actions.isRecording }

      actions.simulateRelease()
      released.value = "emulator-5554"

      waitUntil(timeoutMillis = ACTION_TIMEOUT_MS) {
        runCatching { onNodeWithText("Record").assertIsDisplayed() }.isSuccess
      }
      onNodeWithText("Stopped by release", substring = true).assertIsDisplayed()
      // The fetch went by recording id, never by device.
      assertEquals(listOf<Pair<String?, String?>>(null to "rec-emulator-5554-1"), actions.stopCalls)
    }

  @Test
  fun `stop after switching devices stops by recording id and allocates nothing (#10978)`() =
    runComposeUiTest {
      val actions = FakeVideoRecordingActions().apply { failsDeviceStopWhenIdle = true }
      val selected = mutableStateOf("emulator-5554")
      setContent {
        MaterialTheme {
          DeviceControlsDashboard(
            appearanceClient = FakeAppearanceClient(),
            recordingActions = actions,
            recordingConfigClient = FakeVideoRecordingConfigClient(),
            streamClient = FakeWebRtcStreamClient(),
            activeDeviceId = selected.value,
          )
        }
      }
      onNodeWithText("Record").performClick()
      waitUntil(timeoutMillis = ACTION_TIMEOUT_MS) { actions.isRecording }
      actions.simulateRelease()
      selected.value = "emulator-5556"
      waitForIdle()

      onNodeWithText("Stop").performClick()

      waitUntil(timeoutMillis = ACTION_TIMEOUT_MS) {
        runCatching { onNodeWithText("Record").assertIsDisplayed() }.isSuccess
      }
      assertEquals(listOf<Pair<String?, String?>>(null to "rec-emulator-5554-1"), actions.stopCalls)
    }

  @Test
  fun `a failed stop does not leave the button stuck on Stop (#10978)`() = runComposeUiTest {
    val actions =
      object : VideoRecordingActions {
        override fun startRecording(deviceId: String) =
          listOf(VideoRecordingArtifact("rec-1", "/tmp/rec-1.mp4", 0, "rec-1"))

        override fun stopRecording(
          deviceId: String,
          recordingId: String?,
          ownerSessionUuid: String?,
        ): VideoRecordingStopResult = error("No active video recording found for device.")
      }
    setContent {
      MaterialTheme {
        DeviceControlsDashboard(
          appearanceClient = FakeAppearanceClient(),
          recordingActions = actions,
          recordingConfigClient = FakeVideoRecordingConfigClient(),
          streamClient = FakeWebRtcStreamClient(),
          activeDeviceId = "emulator-5554",
        )
      }
    }
    onNodeWithText("Record").performClick()
    waitUntil(timeoutMillis = ACTION_TIMEOUT_MS) {
      runCatching { onNodeWithText("Stop").assertIsDisplayed() }.isSuccess
    }

    onNodeWithText("Stop").performClick()

    waitUntil(timeoutMillis = ACTION_TIMEOUT_MS) {
      runCatching { onNodeWithText("Record").assertIsDisplayed() }.isSuccess
    }
    onNodeWithText("No active video recording found for device.").assertIsDisplayed()
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
          streamClient = FakeWebRtcStreamClient(),
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

  @Test
  fun `offers screen sharing when the stream socket is present`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        DeviceControlsDashboard(
          appearanceClient = FakeAppearanceClient(),
          recordingActions = FakeVideoRecordingActions(),
          recordingConfigClient = FakeVideoRecordingConfigClient(),
          streamClient = FakeWebRtcStreamClient(),
          activeDeviceId = "emulator-5554",
        )
      }
    }

    onNodeWithText("Remote viewing").assertIsDisplayed()
    onNodeWithText("Share screen").assertIsDisplayed()
  }

  @Test
  fun `says where viewers watch rather than implying a local preview`() = runComposeUiTest {
    // The daemon publishes to a coordination server; it never serves video back here.
    setContent {
      MaterialTheme {
        DeviceControlsDashboard(
          appearanceClient = FakeAppearanceClient(),
          recordingActions = FakeVideoRecordingActions(),
          recordingConfigClient = FakeVideoRecordingConfigClient(),
          streamClient = FakeWebRtcStreamClient(),
          activeDeviceId = "emulator-5554",
        )
      }
    }

    onNodeWithText("browsers and CI dashboards can watch", substring = true).assertIsDisplayed()
  }

  @Test
  fun `degrades when the stream socket is absent`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        DeviceControlsDashboard(
          appearanceClient = FakeAppearanceClient(),
          recordingActions = FakeVideoRecordingActions(),
          recordingConfigClient = FakeVideoRecordingConfigClient(),
          streamClient = FakeWebRtcStreamClient(available = false),
          activeDeviceId = "emulator-5554",
        )
      }
    }

    onNodeWithText("Screen sharing is unavailable on this daemon.").assertIsDisplayed()
    // The other controls keep working.
    onNodeWithText("Record").assertIsDisplayed()
  }

  @Test
  fun `sharing starts a stream and flips the control to stop`() = runComposeUiTest {
    val streamClient = FakeWebRtcStreamClient()
    setContent {
      MaterialTheme {
        DeviceControlsDashboard(
          appearanceClient = FakeAppearanceClient(),
          recordingActions = FakeVideoRecordingActions(),
          recordingConfigClient = FakeVideoRecordingConfigClient(),
          streamClient = streamClient,
          activeDeviceId = "emulator-5554",
        )
      }
    }

    onNodeWithText("Share screen").performClick()
    waitUntil(timeoutMillis = ACTION_TIMEOUT_MS) { streamClient.listStreams().isNotEmpty() }
    waitUntil(timeoutMillis = ACTION_TIMEOUT_MS) {
      runCatching { onNodeWithText("Stop sharing").assertIsDisplayed() }.isSuccess
    }
  }

  @Test
  fun `an unconfigured coordination server surfaces the daemon's reason`() = runComposeUiTest {
    // Streaming is inert until AUTOMOBILE_WEBRTC_WHIP_ENDPOINT is set, and that is the most
    // likely reason sharing fails, so the operator must see it.
    setContent {
      MaterialTheme {
        DeviceControlsDashboard(
          appearanceClient = FakeAppearanceClient(),
          recordingActions = FakeVideoRecordingActions(),
          recordingConfigClient = FakeVideoRecordingConfigClient(),
          streamClient =
            FakeWebRtcStreamClient(
              startFailure = "WebRTC streaming is not configured (AUTOMOBILE_WEBRTC_WHIP_ENDPOINT)",
            ),
          activeDeviceId = "emulator-5554",
        )
      }
    }

    onNodeWithText("Share screen").performClick()
    waitUntil(timeoutMillis = ACTION_TIMEOUT_MS) {
      runCatching {
        onNodeWithText("AUTOMOBILE_WEBRTC_WHIP_ENDPOINT", substring = true).assertIsDisplayed()
      }
        .isSuccess
    }
  }

  private companion object {
    const val ACTION_TIMEOUT_MS = 5_000L
  }
}

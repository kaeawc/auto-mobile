package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.control.testSnapshot
import dev.jasonpearson.automobile.desktop.core.platform.ScreenRecordingSettingsLauncher
import dev.jasonpearson.automobile.desktop.core.video.FakeVideoStreamSource
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class DeviceStreamViewTest {

  private fun col(id: String = "emulator-5554", name: String = "Pixel 8") =
    DeviceColumn(deviceId = id, name = name, platform = Platform.Android)

  private fun iosCol() =
    DeviceColumn(deviceId = "ios-simulator", name = "iPhone 16", platform = Platform.Ios)

  @Test
  fun `connects the source for the pane's device`() = runComposeUiTest {
    val source = FakeVideoStreamSource()
    setContent { MaterialTheme { DeviceStreamView(col(), sourceFactory = { source }) } }
    waitUntil { source.connectedDeviceId == "emulator-5554" }
  }

  @Test
  fun `draws the newest decoded frame as the live mirror`() = runComposeUiTest {
    val source = FakeVideoStreamSource()
    setContent { MaterialTheme { DeviceStreamView(col(), sourceFactory = { source }) } }
    waitUntil { source.connectedDeviceId != null }
    source.emitFrame(width = 1, height = 1)
    waitUntil {
      onAllNodesWithContentDescription("Live stream of Pixel 8").fetchSemanticsNodes().isNotEmpty()
    }
    onNodeWithContentDescription("Live stream of Pixel 8").assertIsDisplayed()
  }

  @Test
  fun `shows the refusal reason when the relay is unavailable`() = runComposeUiTest {
    val source = FakeVideoStreamSource(refuseWith = "Live mirroring was refused")
    setContent { MaterialTheme { DeviceStreamView(col(), sourceFactory = { source }) } }
    onNodeWithText("Live mirroring was refused").assertIsDisplayed()
  }

  @Test
  fun `shows a waiting hint while streaming before the first frame decodes`() = runComposeUiTest {
    // The fake reports Streaming immediately on connect but emits no frame.
    val source = FakeVideoStreamSource()
    setContent { MaterialTheme { DeviceStreamView(col(), sourceFactory = { source }) } }
    onNodeWithText("Waiting for the first frame…").assertIsDisplayed()
  }

  @Test
  fun `guides iOS Screen Recording approval and exposes settings and retry actions`() =
    runComposeUiTest {
      val source =
        FakeVideoStreamSource(
          screenRecordingRequired = true,
          screenRecordingApprovalTarget = "Custom Capture Helper",
        )
      var openSettingsCalls = 0
      val launcher = ScreenRecordingSettingsLauncher {
        openSettingsCalls++
        Result.success(Unit)
      }
      setContent {
        MaterialTheme {
          DeviceStreamView(
            iosCol(),
            sourceFactory = { source },
            screenRecordingSettingsLauncher = launcher,
          )
        }
      }

      onNodeWithText("Screen Recording needs approval").assertIsDisplayed()
      onNodeWithText(
          "Enable Custom Capture Helper in System Settings to discover and observe iOS Simulator windows."
        )
        .assertIsDisplayed()
      onNodeWithText("Open System Settings").performClick()
      assertEquals(1, openSettingsCalls)

      val connectsBeforeRetry = source.connectCalls
      onNodeWithText("Check again").performClick()
      waitUntil { source.connectCalls > connectsBeforeRetry }
    }

  @Test
  fun `an armed iOS pane still surfaces Screen Recording approval over the control view`() =
    runComposeUiTest {
      // Regression: a refused iOS relay (PermissionRequired) must win even when device control is
      // armed. On iOS the observation stream can hand the pane a snapshot (arming it) while the
      // video relay is still refused; taking the armed branch there rendered a frozen fallback
      // screenshot and hid the approval UI, stranding the user with no way to recover (#5221).
      val source = FakeVideoStreamSource(screenRecordingRequired = true)
      val scope = CoroutineScope(Dispatchers.Unconfined)
      val control =
        WorkspaceDeviceControlState(
          dispatcher =
            VideoInputDispatcher(
              scope = scope,
              clientProvider = { null },
              platform = { "ios" },
              deviceId = "ios-simulator",
              tracer = InteractionLatencyTracer(),
            ),
          interactionSnapshot = testSnapshot(), // armed
          renderSnapshot = testSnapshot(),
          tapError = null,
          tracer = InteractionLatencyTracer(),
        )
      setContent {
        MaterialTheme {
          DeviceStreamView(
            iosCol(),
            enableDeviceControl = true,
            control = control,
            sourceFactory = { source },
          )
        }
      }

      onNodeWithText("Screen Recording needs approval").assertIsDisplayed()
      scope.cancel()
    }

  @Test
  fun `clears a settings launch failure when the pane changes devices`() = runComposeUiTest {
    val source = FakeVideoStreamSource(screenRecordingRequired = true)
    val column = mutableStateOf(iosCol())
    val launcher = ScreenRecordingSettingsLauncher {
      Result.failure(IllegalStateException("unavailable"))
    }
    setContent {
      MaterialTheme {
        DeviceStreamView(
          column.value,
          sourceFactory = { source },
          screenRecordingSettingsLauncher = launcher,
        )
      }
    }

    onNodeWithText("Open System Settings").performClick()
    onNodeWithText("Open Privacy & Security > Screen Recording and enable AutoMobile.")
      .assertIsDisplayed()

    runOnUiThread {
      column.value =
        DeviceColumn(deviceId = "ios-simulator-2", name = "iPhone 16 Pro", platform = Platform.Ios)
    }

    onAllNodesWithText("Open Privacy & Security > Screen Recording and enable AutoMobile.")
      .assertCountEquals(0)
  }

  @Test
  fun `disposes the source when the pane leaves the composition`() = runComposeUiTest {
    val source = FakeVideoStreamSource()
    val show = mutableStateOf(true)
    setContent {
      MaterialTheme { if (show.value) DeviceStreamView(col(), sourceFactory = { source }) }
    }
    waitUntil { source.connectedDeviceId == "emulator-5554" }
    runOnUiThread { show.value = false }
    waitUntil { source.connectedDeviceId == null }
    assertNull(source.connectedDeviceId)
  }

  @Test
  fun `status hints are pinned per state`() {
    assertEquals("Live mirror idle", streamStatusHint(VideoStreamState.Idle))
    assertEquals("Connecting to live mirror…", streamStatusHint(VideoStreamState.Connecting))
    assertEquals(
      "Waiting for the first frame…",
      streamStatusHint(VideoStreamState.Streaming(1080, 2400)),
    )
    assertEquals("relay down", streamStatusHint(VideoStreamState.Unavailable("relay down")))
  }
}

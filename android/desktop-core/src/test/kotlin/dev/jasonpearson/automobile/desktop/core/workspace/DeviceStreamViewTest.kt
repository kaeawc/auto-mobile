package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.video.FakeVideoStreamSource
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class DeviceStreamViewTest {

  private fun col(id: String = "emulator-5554", name: String = "Pixel 8") =
    DeviceColumn(deviceId = id, name = name, platform = Platform.Android)

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

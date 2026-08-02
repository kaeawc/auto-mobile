package dev.jasonpearson.automobile.desktop.core

import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.video.FakeVideoStreamSource
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamState
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

@OptIn(ExperimentalTestApi::class)
class LiveVideoStreamTest {
  @Test
  fun `connects for the active device and disposes when live layout closes`() = runComposeUiTest {
    val source = FakeVideoStreamSource()
    val showLiveLayout = mutableStateOf(true)

    setContent {
      if (showLiveLayout.value) {
        rememberLiveVideoFrame(source, "emulator-5554")
      }
    }

    waitUntil { source.connectedDeviceId == "emulator-5554" }
    runOnUiThread { showLiveLayout.value = false }
    waitUntil { source.connectedDeviceId == null }
  }

  @Test
  fun `populates the live frame's rotation from the decoded stream`() = runComposeUiTest {
    // Issue #4786: the rotation attested by the stream's config packets rides through to the
    // LiveVideoFrame so DeviceControlSession can prove the live frame's orientation.
    val source = FakeVideoStreamSource()
    var observedRotation: Int? = null

    setContent {
      val liveFrame = rememberLiveVideoFrame(source, "emulator-5554")
      SideEffect { liveFrame?.let { observedRotation = it.rotation } }
    }

    source.emitFrame(width = 1, height = 1, rotation = 3)
    waitUntil { observedRotation == 3 }
    assertEquals(3, observedRotation)
  }

  @Test
  fun `clears the live frame when the relay becomes unavailable`() = runComposeUiTest {
    val source = FakeVideoStreamSource()
    var observedFrame: androidx.compose.ui.graphics.ImageBitmap? = null

    setContent {
      val liveFrame = rememberLiveVideoFrame(source, "emulator-5554")
      SideEffect { observedFrame = liveFrame?.bitmap }
    }

    source.emitFrame(width = 1, height = 1)
    waitUntil { observedFrame != null }

    source.becomeUnavailable()
    waitUntil { observedFrame == null }

    source.emitFrame(width = 1, height = 1)
    waitForIdle()
    assertNull(observedFrame)
  }

  @Test
  fun `auto-reconnect re-subscribes after the relay drops`() = runComposeUiTest {
    // A dropped relay ("Live mirroring stopped") must heal itself rather than stay dead until the
    // pane is torn down. With autoReconnect on, an Unavailable state triggers a connect() retry —
    // the only path back to Streaming here, since the test never calls connect() again itself.
    val source = FakeVideoStreamSource()
    setContent {
      rememberLiveVideoFrame(source, "emulator-5554", autoReconnect = true, reconnectInitialMs = 10)
    }
    waitUntil { source.state.value is VideoStreamState.Streaming }

    source.becomeUnavailable("Live mirroring stopped")
    waitUntil(timeoutMillis = 2_000) { source.state.value is VideoStreamState.Streaming }
  }

  @Test
  fun `without auto-reconnect a dropped relay stays unavailable`() = runComposeUiTest {
    val source = FakeVideoStreamSource()
    setContent { rememberLiveVideoFrame(source, "emulator-5554") }
    waitUntil { source.state.value is VideoStreamState.Streaming }

    source.becomeUnavailable("Live mirroring stopped")
    waitForIdle()
    assertTrue(source.state.value is VideoStreamState.Unavailable)
  }

  @Test
  fun `does not adopt a frame emitted after the relay becomes unavailable`() = runComposeUiTest {
    // A frame can race the relay's death (it was decoded just before, delivered just after). The
    // collector gates on the CURRENT stream state, so the dead mirror stays cleared.
    val source = FakeVideoStreamSource()
    var observedFrame: androidx.compose.ui.graphics.ImageBitmap? = null

    setContent {
      val liveFrame = rememberLiveVideoFrame(source, "emulator-5554")
      SideEffect { observedFrame = liveFrame?.bitmap }
    }

    source.becomeUnavailable()
    source.emitFrame(width = 1, height = 1)
    waitForIdle()
    assertNull(observedFrame)
  }
}

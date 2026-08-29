package dev.jasonpearson.automobile.desktop.core

import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.video.FakeVideoStreamSource
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamState
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
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
  fun `auto-reconnect retains the last frame across a relay drop`() = runComposeUiTest {
    // The workspace video pane must never regress to a non-video surface while the relay
    // re-subscribes: with autoReconnect on, the last decoded frame is RETAINED through
    // Unavailable instead of cleared (the plain path above keeps its clear-and-blend contract).
    val source = FakeVideoStreamSource()
    var observedFrame: androidx.compose.ui.graphics.ImageBitmap? = null

    setContent {
      val liveFrame =
        rememberLiveVideoFrame(
          source,
          "emulator-5554",
          autoReconnect = true,
          reconnectInitialMs = 10,
        )
      SideEffect { observedFrame = liveFrame?.bitmap }
    }

    source.emitFrame(width = 1, height = 1)
    waitUntil { observedFrame != null }

    source.becomeUnavailable("Live mirroring stopped")
    // The retry re-subscribes on its own; the fake emits NO new frame afterwards, so a frame
    // that had been cleared would still read null here — non-null proves retention.
    waitUntil(timeoutMillis = 2_000) { source.state.value is VideoStreamState.Streaming }
    waitForIdle()
    assertTrue(observedFrame != null)
  }

  @Test
  fun `reconnects when a Streaming relay stops delivering frames`() = runComposeUiTest {
    // A relay that stalls with its socket OPEN never leaves Streaming, so the Unavailable-driven
    // retry above cannot fire — frame progress ceasing is the only signal. The stall watchdog
    // must reconnect, and the stale frame must stay rendered while it does.
    val monotonic = { System.nanoTime() / 1_000_000L }
    val source = FakeVideoStreamSource(nowMs = monotonic)
    var observedFrame: androidx.compose.ui.graphics.ImageBitmap? = null

    setContent {
      val liveFrame =
        rememberLiveVideoFrame(
          source,
          "emulator-5554",
          autoReconnect = true,
          reconnectInitialMs = 10,
          nowMs = monotonic,
          stallReconnectMs = 100,
          stallCheckIntervalMs = 20,
        )
      SideEffect { observedFrame = liveFrame?.bitmap }
    }

    waitUntil { source.connectCalls >= 1 }
    source.emitFrame(width = 1, height = 1)
    waitUntil { observedFrame != null }

    // No further frames arrive: the watchdog must tear down and re-subscribe on its own.
    waitUntil(timeoutMillis = 5_000) { source.connectCalls >= 2 }
    waitForIdle()
    assertTrue(observedFrame != null)
  }

  @Test
  fun `an idle-heartbeat-less source is NOT reconnected while idle-Streaming`() = runComposeUiTest {
    // iOS drops idle ScreenCaptureKit buffers, so a healthy static screen makes no frame progress.
    // With stallReconnectMs = null the watchdog must leave a Streaming-but-idle stream alone rather
    // than churn a healthy capture (#5255 review). connectCalls stays at the initial subscribe.
    val monotonic = { System.nanoTime() / 1_000_000L }
    val source = FakeVideoStreamSource(nowMs = monotonic)
    setContent {
      rememberLiveVideoFrame(
        source,
        "ios-simulator",
        autoReconnect = true,
        reconnectInitialMs = 10,
        nowMs = monotonic,
        stallReconnectMs = null, // iOS
        firstFrameTimeoutMs = 100,
        stallCheckIntervalMs = 20,
      )
    }
    waitUntil { source.connectCalls >= 1 }
    source.emitFrame(width = 1, height = 1) // first frame arrives → Streaming, then idle forever
    // Wait well past both the first-frame deadline and several stall-check intervals.
    Thread.sleep(400)
    waitForIdle()
    assertEquals(1, source.connectCalls) // idle Streaming is healthy; never reconnected
  }

  @Test
  fun `reconnects a stream stuck in Connecting past the first-frame deadline`() = runComposeUiTest {
    // A subscribe accepted (or connecting) that never yields a decodable first frame is the
    // key-frame wedge; neither the Streaming-stall watchdog nor the Unavailable retry can see it.
    // The first-frame deadline must re-subscribe (#5255 review).
    val monotonic = { System.nanoTime() / 1_000_000L }
    val source = FakeVideoStreamSource(nowMs = monotonic, holdConnecting = true)
    setContent {
      rememberLiveVideoFrame(
        source,
        "emulator-5554",
        autoReconnect = true,
        reconnectInitialMs = 10,
        nowMs = monotonic,
        stallReconnectMs = null,
        firstFrameTimeoutMs = 100,
        stallCheckIntervalMs = 20,
      )
    }
    waitUntil { source.connectCalls >= 1 }
    // Never leaves Connecting; the first-frame deadline must force a re-subscribe.
    waitUntil(timeoutMillis = 5_000) { source.connectCalls >= 2 }
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
  fun `auto-reconnect resumes after Screen Recording is granted`() = runComposeUiTest {
    val source = FakeVideoStreamSource(screenRecordingRequired = true)
    setContent {
      rememberLiveVideoFrame(source, "ios-simulator", autoReconnect = true, reconnectInitialMs = 10)
    }
    waitUntil { source.state.value is VideoStreamState.PermissionRequired }

    source.grantScreenRecording()

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

  @Test
  fun `resuming after a long pause does not reconnect off the retained frame`() = runComposeUiTest {
    // #5219 regression: a streamingEnabled resume restarts the stall watchdog while liveFrame still
    // holds the pre-pause frame. It must not adopt that stale frame's ancient receivedAtMs as the
    // progress baseline — otherwise a pause longer than stallReconnectMs makes the first tick judge
    // the freshly-resumed stream stalled and reconnect immediately. The logical clock (nowMs) is
    // frozen at the resume instant so the assertion is deterministic: with the fix the watchdog
    // sees
    // zero elapsed no-progress time and never reconnects.
    val clock = java.util.concurrent.atomic.AtomicLong(0L)
    val nowMs = { clock.get() }
    val source = FakeVideoStreamSource(nowMs = nowMs)
    val streaming = mutableStateOf(true)
    setContent {
      rememberLiveVideoFrame(
        source,
        "emulator-5554",
        autoReconnect = true,
        streamingEnabled = streaming.value,
        reconnectInitialMs = 10,
        nowMs = nowMs,
        stallReconnectMs = 100,
        stallCheckIntervalMs = 20,
      )
    }
    waitUntil { source.connectedDeviceId == "emulator-5554" }
    source.emitFrame(width = 1, height = 1) // retained frame, receivedAtMs = 0
    waitUntil { source.state.value is VideoStreamState.Streaming }

    runOnUiThread { streaming.value = false } // window unfocused → pause/disconnect
    waitUntil { source.connectedDeviceId == null }
    clock.set(10_000) // 10s elapse while unfocused, far exceeding stallReconnectMs

    runOnUiThread { streaming.value = true } // refocus → a single reconnect
    waitUntil { source.connectedDeviceId == "emulator-5554" }
    val connectsAtResume = source.connectCalls

    // waitUntil pumps the test clock, firing the watchdog's stallCheck ticks (Thread.sleep would
    // not advance it). No fresh frame arrives, so with the stale baseline the watchdog reconnects
    // within a tick or two; with the fix the frozen nowMs yields zero no-progress time forever, so
    // the wait times out with connectCalls unchanged.
    var reconnected = true
    try {
      waitUntil(timeoutMillis = 1_000) { source.connectCalls > connectsAtResume }
    } catch (_: androidx.compose.ui.test.ComposeTimeoutException) {
      reconnected = false
    }
    assertFalse(reconnected, "watchdog must not reconnect off the retained pre-pause frame")
  }
}

package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import androidx.compose.ui.test.waitUntilExactlyOneExists
import dev.jasonpearson.automobile.desktop.core.control.testSnapshot
import dev.jasonpearson.automobile.desktop.core.platform.ScreenRecordingSettingsLauncher
import dev.jasonpearson.automobile.desktop.core.settings.FakeSettingsProvider
import dev.jasonpearson.automobile.desktop.core.video.FakeVideoStreamSource
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamQuality
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamState
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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
    setContent { MaterialTheme { DeviceStreamView(col(), sourceFactory = { _, _ -> source }) } }
    waitUntil { source.connectedDeviceId == "emulator-5554" }
  }

  @Test
  fun `disconnects when the window loses focus and reconnects on refocus`() = runComposeUiTest {
    // #5219: an unfocused/minimized desktop window pauses the pane's live stream so the daemon can
    // drop the device-side encode; refocus resumes it on the same source.
    val source = FakeVideoStreamSource()
    val focused = mutableStateOf(true)
    setContent {
      MaterialTheme {
        DeviceStreamView(
          col(),
          sourceFactory = { _, _ -> source },
          streamingEnabled = focused.value,
        )
      }
    }
    waitUntil { source.connectedDeviceId == "emulator-5554" }

    runOnUiThread { focused.value = false }
    waitUntil { source.connectedDeviceId == null }

    runOnUiThread { focused.value = true }
    waitUntil { source.connectedDeviceId == "emulator-5554" }
  }

  @Test
  fun `never connects while the window starts unfocused`() = runComposeUiTest {
    // Mounting a pane while the window is already unfocused must not open a subscription at all.
    val source = FakeVideoStreamSource()
    setContent {
      MaterialTheme {
        DeviceStreamView(col(), sourceFactory = { _, _ -> source }, streamingEnabled = false)
      }
    }
    waitForIdle()
    assertNull(source.connectedDeviceId)
    assertEquals(0, source.connectCalls)
  }

  @Test
  fun `draws the newest decoded frame as the live mirror`() = runComposeUiTest {
    val source = FakeVideoStreamSource()
    setContent { MaterialTheme { DeviceStreamView(col(), sourceFactory = { _, _ -> source }) } }
    waitUntil { source.connectedDeviceId != null }
    source.emitFrame(width = 1, height = 1)
    waitUntil {
      onAllNodesWithContentDescription("Live stream of Pixel 8").fetchSemanticsNodes().isNotEmpty()
    }
    onNodeWithContentDescription("Live stream of Pixel 8").assertIsDisplayed()
  }

  @Test
  fun `keeps the last frame on screen while a recreated source reconnects`() = runComposeUiTest {
    // Arming the pane changes the source's remember keys (fps/preset), recreating the source. The
    // fresh source has no frame yet — the pane must keep rendering the retained frame instead of
    // flashing "Connecting to live mirror…" mid-interaction.
    val sources = mutableListOf<FakeVideoStreamSource>()
    val armed = androidx.compose.runtime.mutableStateOf(false)
    setContent {
      MaterialTheme {
        DeviceStreamView(
          col(),
          enableDeviceControl = armed.value,
          sourceFactory = { _, _ -> FakeVideoStreamSource().also { sources += it } },
        )
      }
    }
    waitUntil { sources.size == 1 && sources[0].connectedDeviceId != null }
    sources[0].emitFrame(width = 1, height = 1)
    waitUntil {
      onAllNodesWithContentDescription("Live stream of Pixel 8").fetchSemanticsNodes().isNotEmpty()
    }
    armed.value = true
    waitUntil { sources.size == 2 }
    onNodeWithContentDescription("Live stream of Pixel 8").assertIsDisplayed()
    assertTrue(onAllNodesWithText("Connecting to live mirror…").fetchSemanticsNodes().isEmpty())
    assertTrue(onAllNodesWithText("Waiting for the first frame…").fetchSemanticsNodes().isEmpty())
  }

  @Test
  fun `shows the refusal reason when the relay is unavailable`() = runComposeUiTest {
    val source = FakeVideoStreamSource(refuseWith = "Live mirroring was refused")
    setContent { MaterialTheme { DeviceStreamView(col(), sourceFactory = { _, _ -> source }) } }
    onNodeWithText("Live mirroring was refused").assertIsDisplayed()
  }

  @Test
  fun `shows a waiting hint while streaming before the first frame decodes`() = runComposeUiTest {
    // The fake reports Streaming immediately on connect but emits no frame.
    val source = FakeVideoStreamSource()
    setContent { MaterialTheme { DeviceStreamView(col(), sourceFactory = { _, _ -> source }) } }
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
            sourceFactory = { _, _ -> source },
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

  /** A minimal armed control state whose dispatcher never reaches a daemon. */
  private fun armedControlState(scope: CoroutineScope) =
    WorkspaceDeviceControlState(
      dispatcher =
        VideoInputDispatcher(
          scope = scope,
          clientProvider = { null },
          platform = { "android" },
          deviceId = "emulator-5554",
          tracer = InteractionLatencyTracer(),
        ),
      interactionSnapshot = testSnapshot(),
      renderSnapshot = testSnapshot(),
      tapError = null,
      tracer = InteractionLatencyTracer(),
    )

  @Test
  fun `an armed pane without video yet shows the waiting hint, not a screenshot surface`() =
    runComposeUiTest {
      // The pane's pixels are ALWAYS live video. Before the first decoded frame the armed branch
      // must fall through to the status hint instead of rendering the observation screenshot as an
      // interactive still — the "pane switches over to screenshots" regression (#3348 family).
      val source = FakeVideoStreamSource()
      val scope = CoroutineScope(Dispatchers.Unconfined)
      setContent {
        MaterialTheme {
          DeviceStreamView(
            col(),
            enableDeviceControl = true,
            control = armedControlState(scope),
            sourceFactory = { _, _ -> source },
          )
        }
      }

      onNodeWithText("Waiting for the first frame…").assertIsDisplayed()
      onAllNodesWithTag(DEVICE_CONTROL_SURFACE_TEST_TAG).assertCountEquals(0)
      scope.cancel()
    }

  @Test
  fun `an armed pane with live video renders the interactive video surface`() = runComposeUiTest {
    val source = FakeVideoStreamSource(nowMs = { System.nanoTime() / 1_000_000L })
    val scope = CoroutineScope(Dispatchers.Unconfined)
    setContent {
      MaterialTheme {
        DeviceStreamView(
          col(),
          enableDeviceControl = true,
          control = armedControlState(scope),
          sourceFactory = { _, _ -> source },
        )
      }
    }

    waitUntil { source.connectedDeviceId == "emulator-5554" }
    source.emitFrame()
    waitUntilExactlyOneExists(hasTestTag(DEVICE_CONTROL_SURFACE_TEST_TAG))
    onAllNodesWithText("Waiting for the first frame…").assertCountEquals(0)
    scope.cancel()
  }

  @Test
  fun `armed control disarms when the relay drops, but the retained frame keeps rendering`() =
    runComposeUiTest {
      // Retention keeps the last video frame on screen across a drop, but a stale frame must NOT
      // stay clickable — untagged taps would land on a device whose UI may have moved (#5255
      // review). refuseWith keeps the auto-reconnect from racing the state back to Streaming.
      val source =
        FakeVideoStreamSource(refuseWith = "dropped", nowMs = { System.nanoTime() / 1_000_000L })
      val scope = CoroutineScope(Dispatchers.Unconfined)
      setContent {
        MaterialTheme {
          DeviceStreamView(
            col(),
            enableDeviceControl = true,
            control = armedControlState(scope),
            sourceFactory = { _, _ -> source },
            // Immediate expiry: disarm the moment the relay leaves Streaming, so this test pins
            // the disarm rule itself rather than the transient-tolerance window.
            armedFrameGraceWait = {},
          )
        }
      }
      // Stage a live frame: force Streaming, emit, and confirm the armed interactive surface.
      runOnUiThread { source.becomeStreaming() }
      source.emitFrame()
      waitUntilExactlyOneExists(hasTestTag(DEVICE_CONTROL_SURFACE_TEST_TAG))

      // Relay drops: control disarms (surface gone) but the retained frame still renders as a
      // plain mirror image.
      runOnUiThread { source.becomeUnavailable("dropped") }
      waitUntil {
        onAllNodesWithTag(DEVICE_CONTROL_SURFACE_TEST_TAG).fetchSemanticsNodes().isEmpty()
      }
      onNodeWithContentDescription("Live stream of Pixel 8").assertIsDisplayed()
      scope.cancel()
    }

  @Test
  fun `armed control survives a transient drop within the retention window`() = runComposeUiTest {
    // A quality-step re-subscribe or momentary relay drop leaves Streaming briefly; while the
    // newest frame is within the retention window the interactive surface (and its Tap Targets
    // affordance) must stay mounted instead of flickering to the plain mirror and back.
    val source =
      FakeVideoStreamSource(refuseWith = "dropped", nowMs = { System.nanoTime() / 1_000_000L })
    val scope = CoroutineScope(Dispatchers.Unconfined)
    setContent {
      MaterialTheme {
        DeviceStreamView(
          col(),
          enableDeviceControl = true,
          control = armedControlState(scope),
          sourceFactory = { _, _ -> source },
          armedFrameGraceWait = { awaitCancellation() }, // grace never expires on its own
        )
      }
    }
    runOnUiThread { source.becomeStreaming() }
    source.emitFrame()
    waitUntilExactlyOneExists(hasTestTag(DEVICE_CONTROL_SURFACE_TEST_TAG))

    runOnUiThread { source.becomeUnavailable("dropped") }
    waitForIdle()
    onAllNodesWithTag(DEVICE_CONTROL_SURFACE_TEST_TAG).assertCountEquals(1)
    scope.cancel()
  }

  @Test
  fun `grace expiry and source-swap restart are driven deterministically`() = runComposeUiTest {
    // Drives the shipped grace window through the injected suspend seam (no wall time, no 0/huge
    // extremes): each grace pass awaits its own gate, so the test controls exactly when a window
    // expires and proves a source swap CANCELS the old source's window and starts a fresh one.
    val gates = mutableListOf<CompletableDeferred<Unit>>()
    val sources = mutableListOf<FakeVideoStreamSource>()
    val scope = CoroutineScope(Dispatchers.Unconfined)
    val armed = mutableStateOf(false)
    setContent {
      MaterialTheme {
        DeviceStreamView(
          col(),
          enableDeviceControl = armed.value,
          control = armedControlState(scope),
          sourceFactory = { _, _ ->
            FakeVideoStreamSource(nowMs = { System.nanoTime() / 1_000_000L }).also { sources += it }
          },
          armedFrameGraceWait = { CompletableDeferred<Unit>().also { gates += it }.await() },
        )
      }
    }
    // Mirror-mode source streams a frame; arming swaps to a fresh source. The initial non-Streaming
    // states open early gates; note how many exist before the drop we care about.
    waitUntil { sources.size == 1 && sources[0].connectedDeviceId != null }
    sources[0].emitFrame(width = 1, height = 1)
    // Wait for the frame to be collected (it becomes the retained frame) before swapping sources.
    waitUntil {
      onAllNodesWithContentDescription("Live stream of Pixel 8").fetchSemanticsNodes().isNotEmpty()
    }
    armed.value = true
    waitUntil { sources.size == 2 && sources[1].connectedDeviceId != null }
    waitUntilExactlyOneExists(hasTestTag(DEVICE_CONTROL_SURFACE_TEST_TAG))
    val gatesBeforeDrop = gates.size

    // Drop the stream: a grace window opens (new gate) and control stays armed while it runs.
    runOnUiThread { sources[1].becomeUnavailable("dropped") }
    waitUntil { gates.size == gatesBeforeDrop + 1 }
    onAllNodesWithTag(DEVICE_CONTROL_SURFACE_TEST_TAG).assertCountEquals(1)
    val droppedSourceGate = gates.last()

    // Swap sources mid-grace (disarm/rearm recreates it): the old window's gate is cancelled and a
    // fresh one opens for the new source's non-Streaming state.
    armed.value = false
    waitUntil { sources.size == 3 }
    runOnUiThread { sources[2].becomeUnavailable("still down") }
    armed.value = true
    waitUntil { sources.size == 4 }
    runOnUiThread { sources[3].becomeUnavailable("still down") }
    waitUntil { gates.size > gatesBeforeDrop + 1 }

    // The old window's waiter died with the swap: completing ITS gate must not disarm anything.
    droppedSourceGate.complete(Unit)
    waitForIdle()
    onAllNodesWithTag(DEVICE_CONTROL_SURFACE_TEST_TAG).assertCountEquals(1)

    // Completing the CURRENT window's gate is what disarms — deterministic boundary crossing.
    val currentGate = gates.last()
    currentGate.complete(Unit)
    waitUntil {
      onAllNodesWithTag(DEVICE_CONTROL_SURFACE_TEST_TAG).fetchSemanticsNodes().isEmpty()
    }
    onNodeWithContentDescription("Live stream of Pixel 8").assertIsDisplayed()
    scope.cancel()
  }

  @Test
  fun `a source swap does not leave control disarmed once the new source streams`() =
    runComposeUiTest {
      // Recreating the source (arming, quality step) must not strand the pane disarmed: the fresh
      // source reports Streaming before its first frame decodes, and the armed surface may run on
      // the retained frame under that Streaming state. Guards the grace effect's keying across
      // source swaps (CodeRabbit).
      val sources = mutableListOf<FakeVideoStreamSource>()
      val scope = CoroutineScope(Dispatchers.Unconfined)
      val armed = mutableStateOf(false)
      setContent {
        MaterialTheme {
          DeviceStreamView(
            col(),
            enableDeviceControl = armed.value,
            control = armedControlState(scope),
            sourceFactory = { _, _ -> FakeVideoStreamSource().also { sources += it } },
            armedFrameGraceWait = {}, // any grace comes from Streaming state, never the window
          )
        }
      }
      waitUntil { sources.size == 1 && sources[0].connectedDeviceId != null }
      sources[0].emitFrame(width = 1, height = 1)
      waitUntil {
        onAllNodesWithContentDescription("Live stream of Pixel 8")
          .fetchSemanticsNodes()
          .isNotEmpty()
      }

      // Arming swaps the source; the new fake connects straight to Streaming with no frame yet.
      armed.value = true
      waitUntil { sources.size == 2 && sources[1].connectedDeviceId != null }
      waitUntilExactlyOneExists(hasTestTag(DEVICE_CONTROL_SURFACE_TEST_TAG))
      scope.cancel()
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
            sourceFactory = { _, _ -> source },
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
          sourceFactory = { _, _ -> source },
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
      MaterialTheme { if (show.value) DeviceStreamView(col(), sourceFactory = { _, _ -> source }) }
    }
    waitUntil { source.connectedDeviceId == "emulator-5554" }
    runOnUiThread { show.value = false }
    waitUntil { source.connectedDeviceId == null }
    assertNull(source.connectedDeviceId)
  }

  @Test
  fun `shows the collapsed quality overlay on the focused pane`() = runComposeUiTest {
    val source = FakeVideoStreamSource()
    setContent {
      MaterialTheme {
        DeviceStreamView(
          col(),
          enableDeviceControl = true,
          settings = FakeSettingsProvider(streamQualityPreset = "medium"),
          sourceFactory = { _, _ -> source },
        )
      }
    }
    // Collapsed readout: persisted preset + live-vs-target fps (control pane targets 30fps). The
    // selector chips stay hidden so they cannot intercept a tap on the interactive surface.
    onNodeWithText("Medium · 0 fps").assertIsDisplayed()
    onAllNodesWithText("Auto").assertCountEquals(0)
  }

  @Test
  fun `no quality overlay on an unfocused pane even with settings`() = runComposeUiTest {
    val source = FakeVideoStreamSource()
    setContent {
      MaterialTheme {
        DeviceStreamView(
          col(),
          enableDeviceControl = false,
          settings = FakeSettingsProvider(streamQualityPreset = "medium"),
          sourceFactory = { _, _ -> source },
        )
      }
    }
    onAllNodesWithText("fps", substring = true).assertCountEquals(0)
  }

  @Test
  fun `no quality overlay without settings`() = runComposeUiTest {
    val source = FakeVideoStreamSource()
    setContent {
      MaterialTheme {
        DeviceStreamView(col(), enableDeviceControl = true, sourceFactory = { _, _ -> source })
      }
    }
    onAllNodesWithText("fps", substring = true).assertCountEquals(0)
  }

  @Test
  fun `manual quality selection persists and re-subscribes with the new preset`() =
    runComposeUiTest {
      val settings = FakeSettingsProvider(streamQualityPreset = "medium")
      // A distinct fake per preset, so the assertions prove a genuine source teardown + replacement
      // (not the same instance re-used) when the pane re-keys on the new quality.
      val sources = mutableMapOf<VideoStreamQuality, FakeVideoStreamSource>()
      setContent {
        MaterialTheme {
          DeviceStreamView(
            col(),
            enableDeviceControl = true,
            settings = settings,
            sourceFactory = { _, quality -> sources.getOrPut(quality) { FakeVideoStreamSource() } },
          )
        }
      }
      // First subscribe uses the persisted Medium preset and connects.
      waitUntil { sources[VideoStreamQuality.Medium]?.connectedDeviceId == "emulator-5554" }
      val medium = sources.getValue(VideoStreamQuality.Medium)

      // Expand the collapsed overlay, then pick High.
      onNodeWithText("Medium · 0 fps").performClick()
      onNodeWithText("High").performClick()

      // A distinct High source is created and connects, the old Medium source is disposed, and the
      // choice persists for next launch.
      waitUntil { sources[VideoStreamQuality.High]?.connectedDeviceId == "emulator-5554" }
      assertNull("old source disposed on re-key", medium.connectedDeviceId)
      assertEquals("high", settings.streamQualityPreset)
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

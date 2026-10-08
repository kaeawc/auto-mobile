package dev.jasonpearson.automobile.desktop.core.video

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest

@OptIn(ExperimentalCoroutinesApi::class)
class VideoStreamClientPolicyTest {
  @Test
  fun `typed end reasons decide automatic reconnect`() {
    for (reason in VideoStreamEndReason.entries) {
      assertEquals(
        reason == VideoStreamEndReason.DeviceRemoved ||
          reason == VideoStreamEndReason.IdentityQuarantined,
        VideoStreamState.Ended(reason).autoReconnects(),
        reason.wire,
      )
    }
    assertTrue(VideoStreamState.Unavailable("offline").autoReconnects())
    assertTrue(
      VideoStreamState.PermissionRequired(
          VideoStreamPermission.ScreenRecordingNeedsApproval,
          "AutoMobile",
        )
        .autoReconnects(),
    )
    assertTrue(!VideoStreamState.Idle.autoReconnects())
    assertTrue(!VideoStreamState.Connecting.autoReconnects())
    assertTrue(!VideoStreamState.Streaming(1, 1).autoReconnects())
  }

  @Test
  fun `fake viewer ack preserves input and downgrade is latched until connect`() {
    val source = FakeVideoStreamSource()
    source.connect("device")
    source.setSubscriptionKind(VideoStreamSubscriptionKind.Viewer)
    assertTrue(!source.readOnly.value)
    source.becomeDowngraded()
    assertEquals(VideoStreamSubscriptionKind.Viewer, source.subscriptionKind.value)
    assertTrue(source.readOnly.value)
    source.endWith(VideoStreamEndReason.SessionEnded)
    assertEquals(VideoStreamState.Ended(VideoStreamEndReason.SessionEnded), source.state.value)
    source.disconnect()
    assertTrue(source.readOnly.value)
    source.connect("device")
    assertTrue(!source.readOnly.value)
    assertEquals(null, source.subscriptionKind.value)
  }

  @Test
  fun `subscribe failures distinguish auth from device and capture errors`() = runTest {
    val other = VideoStreamState.UnavailableCause.OTHER
    val refused = VideoStreamState.UnavailableCause.REFUSED
    assertEquals(other, subscribeFailureCause("No connected device with id ghost."))
    assertEquals(other, subscribeFailureCause("Invalid fps hint"))
    assertEquals(other, subscribeFailureCause("Capture failed to start"))
    assertEquals(other, subscribeFailureCause(null))
    assertEquals(
      refused,
      subscribeFailureCause("Video stream subscribe requires an authenticated daemon session."),
    )
    assertEquals(
      refused,
      subscribeFailureCause(
        "Video stream subscribe rejected: session x is not an active daemon session (unknown or expired).",
      ),
    )
  }

  @Test
  fun `connect then refuse exposes Connecting before cancelling its collector`() = runTest {
    val source =
      FakeVideoStreamSource(
        refuseWith = "rejected",
        connectThenRefuse = true,
        refusalScope = backgroundScope,
      )
    val states = mutableListOf<VideoStreamState>()
    var cancelledConnecting = 0
    backgroundScope.launch(StandardTestDispatcher(testScheduler)) {
      source.state.collectLatest { state ->
        states += state
        if (state is VideoStreamState.Connecting) {
          try {
            awaitCancellation()
          } finally {
            cancelledConnecting++
          }
        }
      }
    }
    runCurrent()
    source.connect("ghost")
    runCurrent()

    assertTrue(states.any { it is VideoStreamState.Connecting })
    assertTrue(states.any { it is VideoStreamState.Unavailable })
    assertEquals(1, cancelledConnecting)
  }
}

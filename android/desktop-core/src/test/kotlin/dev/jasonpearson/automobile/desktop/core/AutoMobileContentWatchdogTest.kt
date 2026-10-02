package dev.jasonpearson.automobile.desktop.core

import androidx.compose.runtime.AbstractApplier
import androidx.compose.runtime.BroadcastFrameClock
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Composition
import androidx.compose.runtime.Recomposer
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.snapshots.Snapshot
import dev.jasonpearson.automobile.desktop.core.video.FakeVideoStreamSource
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamEndReason
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamState
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.BeforeClass

@OptIn(ExperimentalCoroutinesApi::class)
class AutoMobileContentWatchdogTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun initializeComposeRuntime() = runTest {
      // Compose's first-use class initialization is unrelated to the virtual-time watchdog work.
      val composition = VirtualComposition(this)
      composition.setContent {
        rememberLiveVideoFrame(
          FakeVideoStreamSource(),
          "warmup",
          stallReconnectMs = null,
          firstFrameTimeoutMs = null,
        )
      }
      composition.close()
    }
  }

  private class EmptyApplier : AbstractApplier<Unit>(Unit) {
    override fun insertTopDown(index: Int, instance: Unit) = Unit

    override fun insertBottomUp(index: Int, instance: Unit) = Unit

    override fun remove(index: Int, count: Int) = Unit

    override fun move(from: Int, to: Int, count: Int) = Unit

    override fun onClear() = Unit
  }

  private class VirtualComposition(private val scope: TestScope) {
    private val dispatcher = StandardTestDispatcher(scope.testScheduler)
    private val clock = BroadcastFrameClock()
    private val recomposer = Recomposer(dispatcher + clock)
    private val composition = Composition(EmptyApplier(), recomposer)

    init {
      scope.backgroundScope.launch(dispatcher + clock) { recomposer.runRecomposeAndApplyChanges() }
      scope.runCurrent()
    }

    fun setContent(content: @Composable () -> Unit) {
      composition.setContent(content)
      tick()
    }

    fun tick() {
      Snapshot.sendApplyNotifications()
      scope.runCurrent()
      clock.sendFrame(scope.testScheduler.currentTime * 1_000_000L)
      scope.runCurrent()
    }

    fun close() {
      composition.dispose()
      recomposer.cancel()
    }
  }

  @Test
  fun `watchdog restarts when a delayed heartbeat ack arms the iOS stall policy`() = runTest {
    val source = FakeVideoStreamSource(nowMs = { testScheduler.currentTime })
    val stallPolicy = mutableStateOf<Long?>(null)
    var composedPolicy: Long? = null
    val composition = VirtualComposition(this)
    composition.setContent {
      SideEffect { composedPolicy = stallPolicy.value }
      rememberLiveVideoFrame(
        source,
        "ios-simulator",
        autoReconnect = true,
        nowMs = { testScheduler.currentTime },
        stallReconnectMs = stallPolicy.value,
        firstFrameTimeoutMs = null,
        stallCheckIntervalMs = 20,
      )
    }
    assertEquals(1, source.connectCalls)
    advanceTimeBy(200)
    runCurrent()
    assertEquals(1, source.connectCalls)

    // The subscribe ack changes policy after the initial composition. The effect must re-key.
    stallPolicy.value = 100
    composition.tick()
    assertEquals(100L, composedPolicy)
    advanceTimeBy(140)
    runCurrent()
    assertEquals(2, source.connectCalls)
    composition.close()
  }

  @Test
  fun `activity reset to zero is not progress and cannot cause early reconnect`() = runTest {
    val source = FakeVideoStreamSource(nowMs = { 1_000 + testScheduler.currentTime })
    val composition = VirtualComposition(this)
    composition.setContent {
      rememberLiveVideoFrame(
        source,
        "ios-simulator",
        autoReconnect = true,
        nowMs = { 1_000 + testScheduler.currentTime },
        stallReconnectMs = 100,
        firstFrameTimeoutMs = null,
        stallCheckIntervalMs = 20,
      )
    }
    source.emitHeartbeat()
    advanceTimeBy(40)
    runCurrent()
    source.resetActivity()
    advanceTimeBy(20)
    runCurrent()
    assertEquals(1, source.connectCalls)
    advanceTimeBy(60)
    runCurrent()
    assertEquals(2, source.connectCalls)
    composition.close()
  }

  @Test
  fun `frame emission resets backoff even when Streaming state is conflated away`() = runTest {
    val source = FakeVideoStreamSource(refuseWith = "rejected")
    val delays = mutableListOf<Long>()
    val permits = Channel<Unit>(Channel.UNLIMITED)
    val composition = VirtualComposition(this)
    composition.setContent {
      rememberLiveVideoFrame(
        source,
        "emulator-5554",
        autoReconnect = true,
        reconnectInitialMs = 10,
        delayMs = { delay ->
          delays += delay
          permits.receive()
        },
        stallReconnectMs = null,
        firstFrameTimeoutMs = null,
      )
    }

    for (expected in listOf(10L, 20L, 40L)) {
      assertEquals(expected, delays.last())
      permits.trySend(Unit).getOrThrow()
      runCurrent()
    }
    assertEquals(80L, delays.last())

    source.becomeStreaming()
    source.recordFrameEmission()
    source.becomeUnavailable("dropped")
    assertEquals(VideoStreamState.Unavailable("dropped"), source.state.value)
    composition.tick()
    assertEquals(10L, delays.last())
    composition.close()
  }

  @Test
  fun `session ended never starts retry or watchdog reconnect`() = runTest {
    val source = FakeVideoStreamSource()
    val delays = mutableListOf<Long>()
    val permits = Channel<Unit>(Channel.UNLIMITED)
    val composition = VirtualComposition(this)
    composition.setContent {
      rememberLiveVideoFrame(
        source,
        "device",
        autoReconnect = true,
        reconnectInitialMs = 10,
        delayMs = {
          delays += it
          permits.receive()
        },
        nowMs = { testScheduler.currentTime },
        stallReconnectMs = 20,
        firstFrameTimeoutMs = 20,
        stallCheckIntervalMs = 10,
      )
    }
    assertEquals(1, source.connectCalls)
    source.endWith(VideoStreamEndReason.SessionEnded)
    composition.tick()
    advanceTimeBy(1_000)
    runCurrent()
    assertEquals(emptyList(), delays)
    assertEquals(1, source.connectCalls)
    assertEquals(VideoStreamState.Ended(VideoStreamEndReason.SessionEnded), source.state.value)
    composition.close()
  }

  @Test
  fun `device removed still retries with exponential backoff`() = runTest {
    val source = FakeVideoStreamSource(refuseWith = "offline")
    val delays = mutableListOf<Long>()
    val permits = Channel<Unit>(Channel.UNLIMITED)
    val composition = VirtualComposition(this)
    composition.setContent {
      rememberLiveVideoFrame(
        source,
        "device",
        autoReconnect = true,
        reconnectInitialMs = 10,
        delayMs = {
          delays += it
          permits.receive()
        },
        nowMs = { testScheduler.currentTime },
        stallReconnectMs = null,
        firstFrameTimeoutMs = null,
      )
    }
    source.becomeStreaming()
    composition.tick()
    delays.clear()
    source.endWith(VideoStreamEndReason.DeviceRemoved)
    composition.tick()
    assertEquals(listOf(10L), delays)
    assertEquals(1, source.connectCalls)
    permits.trySend(Unit).getOrThrow()
    runCurrent()
    assertEquals(2, source.connectCalls)
    // The refused retry changes state to Unavailable, which can repeat the current backoff.
    assertEquals(listOf(10L, 20L), delays.take(2))
    composition.close()
  }
}

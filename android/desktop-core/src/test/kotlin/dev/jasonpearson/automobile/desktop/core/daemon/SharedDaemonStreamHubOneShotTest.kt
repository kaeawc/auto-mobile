package dev.jasonpearson.automobile.desktop.core.daemon

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Test

/** A one-shot capture leased from the hub's shared stream (#17027). */
@OptIn(ExperimentalCoroutinesApi::class)
class SharedDaemonStreamHubOneShotTest {
  private val phone = DeviceStreamKey("emulator-5554", "uuid-a")

  @Test
  fun `a capture joins the pane's stream, skips its replay, and restores its cadence`() =
    runTest(UnconfinedTestDispatcher()) {
      val streams = mutableListOf<FakeObservationStream>()
      val hub =
        SharedDaemonStreamHub(
          telemetry = FakeTelemetryMultiplexer(),
          scope =
            CoroutineScope(
              backgroundScope.coroutineContext + UnconfinedTestDispatcher(testScheduler),
            ),
          observation =
            ObservationHubConfig(
              streamFactory = { FakeObservationStream().also { streams.add(it) } },
              reconnect = ObservationReconnectPolicy({ awaitCancellation() }, { true }),
            ),
        )
      val pane = hub.observationStream(phone).also { it.connect() }
      pane.setCadence(screenshotIntervalMs = 5_000L)
      val shared = streams.single()
      // The pane's last frame, one cadence interval old by the time the capture asks.
      shared.emitScreenshot(ScreenshotStreamUpdate(phone.deviceId, 100L, "stale", 1, 1))

      val capture = hub.observationStream(phone).also { it.connect() }
      val frame = async { capture.awaitFreshScreenshot(phone.deviceId) }

      assertEquals(1, streams.size)
      assertEquals(1, shared.observationRequestCount)
      assertEquals(FRESH_SCREENSHOT_INTERVAL_MS to null, shared.cadenceCalls.last())
      assertFalse(frame.isCompleted)

      val fresh = ScreenshotStreamUpdate(phone.deviceId, 200L, "fresh", 1, 1)
      shared.emitScreenshot(fresh)
      assertSame(fresh, frame.await())

      capture.dispose()
      assertEquals(5_000L to null, shared.cadenceCalls.last())
      assertEquals(mapOf(phone to 1), hub.observationSubscriptions.value)
      assertEquals(0, shared.disconnectCallCount)
      hub.close()
    }
}

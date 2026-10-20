package dev.jasonpearson.automobile.ctrlproxy

import android.content.Intent
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.protocol.FrameMetricsEventResponse
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import dev.jasonpearson.automobile.sdk.AutoMobileSDK
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class SdkTelemetryReceiversTest {
  private val context = RuntimeEnvironment.getApplication()
  private val json = Json { ignoreUnknownKeys = true }

  private class FakeTimer : TimeProvider {
    override fun currentTimeMillis() = 11_000L
  }

  @Test
  fun `frame metrics are stored and forwarded while the server runs`() = runTest {
    val store = FrameMetricsStore()
    val sent = mutableListOf<WebSocketResponse>()
    val receiver =
      FrameMetricsSnapshotReceiver(
        jsonLenient = json,
        frameMetricsStore = store,
        scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler)),
        isRunning = { true },
        broadcast = { sent += it },
      )

    receiver.onReceive(
      context,
      Intent(AutoMobileSDK.ACTION_FRAME_METRICS_SNAPSHOT)
        .putExtra(
          AutoMobileSDK.EXTRA_FRAME_METRICS_SNAPSHOT,
          """{"timestamp":5,"applicationId":"com.app","fps":59.5,"totalFrames":120}""",
        ),
    )

    assertEquals(5L, store.getLatest()?.timestamp)
    val response = sent.single() as FrameMetricsEventResponse
    assertEquals("com.app", response.frameMetrics.applicationId)
    assertEquals(120, response.frameMetrics.totalFrames)
  }

  @Test
  fun `frame metrics are stored but not forwarded when the server is down or the payload is bad`() =
    runTest {
      val store = FrameMetricsStore()
      val sent = mutableListOf<WebSocketResponse>()
      val receiver =
        FrameMetricsSnapshotReceiver(
          jsonLenient = json,
          frameMetricsStore = store,
          scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler)),
          isRunning = { false },
          broadcast = { sent += it },
        )

      receiver.onReceive(
        context,
        Intent(AutoMobileSDK.ACTION_FRAME_METRICS_SNAPSHOT)
          .putExtra(AutoMobileSDK.EXTRA_FRAME_METRICS_SNAPSHOT, """{"timestamp":7}"""),
      )
      receiver.onReceive(
        context,
        Intent(AutoMobileSDK.ACTION_FRAME_METRICS_SNAPSHOT)
          .putExtra(AutoMobileSDK.EXTRA_FRAME_METRICS_SNAPSHOT, "not json"),
      )
      receiver.onReceive(context, Intent("other.action"))

      assertEquals(7L, store.getLatest()?.timestamp)
      assertTrue(sent.isEmpty())
    }

  @Test
  fun `recomposition snapshots reach the store and malformed ones are ignored`() {
    val store = RecompositionStore()
    store.setEnabled(true)
    val receiver = RecompositionSnapshotReceiver(json, store)

    receiver.onReceive(
      context,
      Intent(AutoMobileSDK.ACTION_RECOMPOSITION_SNAPSHOT)
        .putExtra(
          AutoMobileSDK.EXTRA_RECOMPOSITION_SNAPSHOT,
          """{"timestamp":9,"applicationId":"com.app","entries":[]}""",
        ),
    )
    receiver.onReceive(
      context,
      Intent(AutoMobileSDK.ACTION_RECOMPOSITION_SNAPSHOT)
        .putExtra(AutoMobileSDK.EXTRA_RECOMPOSITION_SNAPSHOT, "{"),
    )

    assertTrue(store.isForPackage("com.app"))
  }

  @Test
  fun `a legacy navigation broadcast is queued with prefixed arguments and the injected clock`() {
    val processor = mockk<SdkEventBatchProcessor>()
    every { processor.enqueueNavigationEvent(any()) } returns true
    val receiver = NavigationEventReceiver({ processor }, FakeTimer())

    receiver.onReceive(
      context,
      Intent(AutoMobileSDK.ACTION_NAVIGATION_EVENT)
        .putExtra(AutoMobileSDK.EXTRA_DESTINATION, "Home")
        .putExtra(AutoMobileSDK.EXTRA_SOURCE, "COMPOSE")
        .putExtra(AutoMobileSDK.EXTRA_APPLICATION_ID, "com.app")
        .putExtra("arg_id", "7")
        .putExtra("meta_tag", "x"),
    )

    verify(exactly = 1) {
      processor.enqueueNavigationEvent(
        NavigationEventInput(
          destination = "Home",
          source = "COMPOSE",
          arguments = mapOf("id" to "7"),
          metadata = mapOf("tag" to "x"),
          applicationId = "com.app",
          timestamp = 11_000L,
        ),
      )
    }
  }

  @Test
  fun `other actions and incomplete navigation broadcasts are ignored`() {
    val processor = mockk<SdkEventBatchProcessor>(relaxed = true)
    val receiver = NavigationEventReceiver({ processor }, FakeTimer())

    receiver.onReceive(context, Intent("other.action"))
    receiver.onReceive(
      context,
      Intent(AutoMobileSDK.ACTION_NAVIGATION_EVENT)
        .putExtra(AutoMobileSDK.EXTRA_DESTINATION, "Home"),
    )
    receiver.onReceive(context, null)

    verify(exactly = 0) {
      processor.enqueueNavigationEvent(any())
    }
  }

  @Test
  fun `plain runtime navigation extras failures are contained`() {
    val intent = mockk<Intent>()
    every { intent.action } returns AutoMobileSDK.ACTION_NAVIGATION_EVENT
    every { intent.getStringExtra(any()) } throws RuntimeException("Parcel.readValue failed")
    val processor = mockk<SdkEventBatchProcessor>()

    NavigationEventReceiver({ processor }, FakeTimer()).onReceive(context, intent)

    verify(exactly = 0) {
      processor.enqueueNavigationEvent(any())
    }
  }
}

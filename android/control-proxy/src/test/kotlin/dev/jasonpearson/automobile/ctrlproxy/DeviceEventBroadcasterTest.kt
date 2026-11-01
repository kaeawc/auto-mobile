package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.protocol.CrashEvent
import dev.jasonpearson.automobile.protocol.HandledExceptionEvent
import dev.jasonpearson.automobile.protocol.LifecycleEventResponse
import dev.jasonpearson.automobile.protocol.NavigationEventResponse
import dev.jasonpearson.automobile.protocol.SdkLifecycleEvent
import dev.jasonpearson.automobile.protocol.SdkLogEvent
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class DeviceEventBroadcasterTest {
  private class FakeTimer : TimeProvider {
    override fun currentTimeMillis() = 9_999L
  }

  /** A socket that is up or down, records what it sends, and can fail the next send. */
  private class FakeTransport : DeviceEventTransport {
    var running = true
    var failWith: Throwable? = null
    val messages = mutableListOf<String>()
    val responses =
      mutableListOf<Triple<WebSocketResponse, WebSocketServer.BroadcastMode, Boolean>>()

    override fun isRunning() = running

    override fun connectionCount() = 1

    override suspend fun broadcast(message: String) {
      failWith?.let { throw it }
      messages += message
    }

    override suspend fun broadcast(
      response: WebSocketResponse,
      mode: WebSocketServer.BroadcastMode,
      waitForClient: Boolean,
    ) {
      failWith?.let { throw it }
      responses += Triple(response, mode, waitForClient)
    }
  }

  private val transport = FakeTransport()
  private val events = DeviceEventBroadcaster(transport, FakeTimer())

  private val packageEvent =
    PackageBroadcastEvent(
      action = "android.intent.action.PACKAGE_ADDED",
      packageName = "com.example.app",
      userId = 10,
      uid = 1_010_234,
      isSystem = false,
      removedForAllUsers = false,
    )
  private val navigation =
    TimestampedNavigationEvent(
      destination = "profile",
      source = "compose",
      arguments = emptyMap(),
      metadata = emptyMap(),
      timestamp = 1_234L,
      sequenceNumber = 7L,
    )
  private val crash =
    CrashReport(
      timestamp = 0L,
      exceptionClass = "java.lang.IllegalStateException",
      exceptionMessage = null,
      stackTrace = "trace",
      threadName = "main",
      currentScreen = null,
      packageName = "com.example.app",
      appVersion = null,
      deviceModel = "Pixel 8",
      deviceManufacturer = "Google",
      osVersion = "14",
      sdkInt = 34,
    )
  private val handled =
    HandledExceptionReport(
      timestamp = 1_234L,
      exceptionClass = "java.lang.IllegalStateException",
      exceptionMessage = null,
      stackTrace = "trace",
      customMessage = "handled",
      currentScreen = null,
      packageName = "com.example.app",
      appVersion = null,
      deviceModel = "Pixel 8",
      deviceManufacturer = "Google",
      osVersion = "14",
      sdkInt = 34,
    )
  private val lifecycle = SdkLifecycleEvent(timestamp = 1_234L, kind = "foreground")

  private suspend fun sendEveryKind() {
    events.packageEvent(packageEvent)
    events.navigationEvent(navigation)
    events.handledException(handled)
    events.crash(crash)
    events.sdkEvent(lifecycle)
  }

  @Test
  fun `nothing is sent while the socket is down`() = runTest {
    transport.running = false

    sendEveryKind()

    assertTrue(transport.messages.isEmpty())
    assertTrue(transport.responses.isEmpty())
  }

  @Test
  fun `package event is a frame stamped with the injected clock`() = runTest {
    events.packageEvent(packageEvent)

    assertEquals(
      packageEventFrame(
        PackageEventResult(
          timestamp = 9_999L,
          action = "android.intent.action.PACKAGE_ADDED",
          packageName = "com.example.app",
          userId = 10,
          uid = 1_010_234,
          isSystem = false,
          removedForAllUsers = false,
        ),
      ),
      transport.messages.single(),
    )
  }

  @Test
  fun `navigation and SDK events keep the caller's broadcast mode`() = runTest {
    events.navigationEvent(navigation, WebSocketServer.BroadcastMode.Sync, waitForClient = true)
    events.sdkEvent(lifecycle, WebSocketServer.BroadcastMode.Sync, waitForClient = true)
    events.navigationEvent(navigation)

    val (first, second, third) = transport.responses
    assertEquals(navigationEventResponse(navigation), first.first)
    assertEquals(WebSocketServer.BroadcastMode.Sync to true, first.second to first.third)
    assertTrue(second.first is LifecycleEventResponse)
    assertEquals(WebSocketServer.BroadcastMode.Sync to true, second.second to second.third)
    assertTrue(third.first is NavigationEventResponse)
    assertEquals(WebSocketServer.BroadcastMode.Async to false, third.second to third.third)
  }

  @Test
  fun `an SDK event with no client response is not sent`() = runTest {
    events.sdkEvent(SdkLogEvent(timestamp = 1L, level = 4, tag = "t", message = "m"))

    assertTrue(transport.responses.isEmpty())
  }

  @Test
  fun `failure events are sent async and fall back to the injected clock`() = runTest {
    events.crash(crash)
    events.handledException(handled)

    val (crashSent, handledSent) = transport.responses
    assertEquals(9_999L, (crashSent.first as CrashEvent).timestamp)
    assertEquals(1_234L, (handledSent.first as HandledExceptionEvent).timestamp)
    for ((_, mode, waitForClient) in transport.responses) {
      assertEquals(WebSocketServer.BroadcastMode.Async to false, mode to waitForClient)
    }
  }

  @Test
  fun `a failed send is dropped so the next event still goes out`() = runTest {
    transport.failWith = IllegalStateException("socket closed")
    sendEveryKind()

    transport.failWith = null
    events.navigationEvent(navigation)

    assertEquals(1, transport.responses.size)
  }

  @Test
  fun `cancellation is rethrown from every event kind`() = runTest {
    val cancellation = CancellationException("scope cancelled")
    transport.failWith = cancellation
    val sends: List<suspend () -> Unit> =
      listOf(
        { events.packageEvent(packageEvent) },
        { events.navigationEvent(navigation) },
        { events.handledException(handled) },
        { events.crash(crash) },
        { events.sdkEvent(lifecycle) },
      )
    for ((index, send) in sends.withIndex()) {
      try {
        send()
        fail("send $index swallowed cancellation")
      } catch (e: CancellationException) {
        assertSame(cancellation, e)
      }
    }
  }
}

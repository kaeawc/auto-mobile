package dev.jasonpearson.automobile.ctrlproxy

import android.content.Intent
import dev.jasonpearson.automobile.protocol.SdkCrashEvent
import dev.jasonpearson.automobile.protocol.SdkEventSerializer
import dev.jasonpearson.automobile.protocol.SdkHandledExceptionEvent
import dev.jasonpearson.automobile.sdk.crashes.AutoMobileCrashes
import dev.jasonpearson.automobile.sdk.failures.AutoMobileFailures
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class FailureReceiversTest {
  private val context = RuntimeEnvironment.getApplication()

  private class FakeHost : FailureReportHost {
    val handled = mutableListOf<HandledExceptionReport>()
    val crashes = mutableListOf<CrashReport>()

    override suspend fun onHandledException(report: HandledExceptionReport) {
      handled += report
    }

    override suspend fun onCrash(report: CrashReport) {
      crashes += report
    }
  }

  @Test
  fun `a protocol handled exception defaults a missing app and device info`() = runTest {
    val host = FakeHost()
    val receiver =
      HandledExceptionReceiver(CoroutineScope(UnconfinedTestDispatcher(testScheduler)), host)
    val json =
      SdkEventSerializer.toJson(
        SdkHandledExceptionEvent(
          timestamp = 7,
          exceptionClass = "java.lang.IllegalStateException",
          exceptionMessage = "bad",
          stackTrace = "trace",
        ),
      )

    receiver.onReceive(
      context,
      Intent(AutoMobileFailures.ACTION_HANDLED_EXCEPTION)
        .putExtra(SdkEventSerializer.EXTRA_SDK_EVENT_JSON, json),
    )

    val report = host.handled.single()
    assertEquals(7L, report.timestamp)
    assertEquals("unknown", report.packageName)
    assertEquals("unknown", report.deviceModel)
    assertEquals(0, report.sdkInt)
    assertEquals("bad", report.exceptionMessage)
  }

  @Test
  fun `legacy handled exception extras are used when no protocol payload is present`() = runTest {
    val host = FakeHost()
    val receiver =
      HandledExceptionReceiver(CoroutineScope(UnconfinedTestDispatcher(testScheduler)), host)

    receiver.onReceive(
      context,
      Intent(AutoMobileFailures.ACTION_HANDLED_EXCEPTION)
        .putExtra(AutoMobileFailures.EXTRA_EXCEPTION_CLASS, "E")
        .putExtra(AutoMobileFailures.EXTRA_STACK_TRACE, "st")
        .putExtra(AutoMobileFailures.EXTRA_PACKAGE_NAME, "com.app")
        .putExtra(AutoMobileFailures.EXTRA_SDK_INT, 34),
    )

    val report = host.handled.single()
    assertEquals("com.app", report.packageName)
    assertEquals(34, report.sdkInt)
    assertEquals(0L, report.timestamp)
    assertEquals("unknown", report.osVersion)
  }

  @Test
  fun `handled exception broadcasts missing required extras or the action are dropped`() = runTest {
    val host = FakeHost()
    val receiver =
      HandledExceptionReceiver(CoroutineScope(UnconfinedTestDispatcher(testScheduler)), host)

    receiver.onReceive(context, Intent(AutoMobileFailures.ACTION_HANDLED_EXCEPTION))
    receiver.onReceive(context, Intent("other.action"))
    receiver.onReceive(context, null)

    assertTrue(host.handled.isEmpty())
  }

  @Test
  fun `a protocol crash carries its thread name and device info`() = runTest {
    val host = FakeHost()
    val receiver = CrashReceiver(CoroutineScope(UnconfinedTestDispatcher(testScheduler)), host)
    val json =
      SdkEventSerializer.toJson(
        SdkCrashEvent(
          timestamp = 9,
          applicationId = "com.app",
          exceptionClass = "E",
          exceptionMessage = null,
          stackTrace = "st",
          threadName = "main",
        ),
      )

    receiver.onReceive(
      context,
      Intent(AutoMobileCrashes.ACTION_CRASH)
        .putExtra(SdkEventSerializer.EXTRA_SDK_EVENT_JSON, json),
    )

    val report = host.crashes.single()
    assertEquals("main", report.threadName)
    assertEquals("com.app", report.packageName)
    assertEquals("unknown", report.deviceManufacturer)
  }

  @Test
  fun `a legacy crash defaults its thread name and incomplete broadcasts are dropped`() = runTest {
    val host = FakeHost()
    val receiver = CrashReceiver(CoroutineScope(UnconfinedTestDispatcher(testScheduler)), host)

    receiver.onReceive(
      context,
      Intent(AutoMobileCrashes.ACTION_CRASH)
        .putExtra(AutoMobileCrashes.EXTRA_EXCEPTION_CLASS, "E")
        .putExtra(AutoMobileCrashes.EXTRA_STACK_TRACE, "st")
        .putExtra(AutoMobileCrashes.EXTRA_PACKAGE_NAME, "p"),
    )
    receiver.onReceive(
      context,
      Intent(AutoMobileCrashes.ACTION_CRASH).putExtra(AutoMobileCrashes.EXTRA_EXCEPTION_CLASS, "E"),
    )
    receiver.onReceive(context, null)

    assertEquals("unknown", host.crashes.single().threadName)
  }

  @Test
  fun `plain runtime extras failures are contained before dispatch`() = runTest {
    val intent = mockk<Intent>()
    every { intent.getStringExtra(any()) } throws RuntimeException("Parcel.readValue failed")
    val host = FakeHost()
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))

    every { intent.action } returns AutoMobileFailures.ACTION_HANDLED_EXCEPTION
    HandledExceptionReceiver(scope, host).onReceive(context, intent)
    every { intent.action } returns AutoMobileCrashes.ACTION_CRASH
    CrashReceiver(scope, host).onReceive(context, intent)

    assertTrue(host.handled.isEmpty())
    assertTrue(host.crashes.isEmpty())
  }
}

package dev.jasonpearson.automobile.ctrlproxy

import org.junit.Assert.assertEquals
import org.junit.Test

class CrashEventWireTest {

  private val crash =
    CrashReport(
      timestamp = 1234L,
      exceptionClass = "java.lang.IllegalStateException",
      exceptionMessage = "Unexpected state",
      stackTrace = "IllegalStateException: Unexpected state\n  at App.run(App.kt:42)",
      threadName = "main",
      currentScreen = "profile",
      packageName = "com.example.app",
      appVersion = "1.2.3",
      deviceModel = "Pixel 8",
      deviceManufacturer = "Google",
      osVersion = "14",
      sdkInt = 34,
    )

  private val handled =
    HandledExceptionReport(
      timestamp = 1234L,
      exceptionClass = "java.lang.IllegalStateException",
      exceptionMessage = "Unexpected state",
      stackTrace = "IllegalStateException: Unexpected state\n  at App.run(App.kt:42)",
      customMessage = "Handled by app",
      currentScreen = "profile",
      packageName = "com.example.app",
      appVersion = "1.2.3",
      deviceModel = "Pixel 8",
      deviceManufacturer = "Google",
      osVersion = "14",
      sdkInt = 34,
    )

  @Test
  fun `crash response retains the SDK crash timestamp and wire fields`() {
    val response = crashEventResponse(crash, nowMs = 9999L)

    assertEquals(1234L, response.timestamp)
    assertEquals("java.lang.IllegalStateException", response.event.exceptionClass)
    assertEquals("Unexpected state", response.event.message)
    assertEquals(
      "IllegalStateException: Unexpected state\n  at App.run(App.kt:42)",
      response.event.stackTrace,
    )
    assertEquals("main", response.event.threadName)
    assertEquals("profile", response.event.currentScreen)
    assertEquals("com.example.app", response.event.packageName)
    assertEquals("1.2.3", response.event.appVersion)
    val deviceInfo = requireNotNull(response.event.deviceInfo)
    assertEquals("Pixel 8", deviceInfo.model)
    assertEquals("Google", deviceInfo.manufacturer)
    assertEquals("14", deviceInfo.osVersion)
    assertEquals(34, deviceInfo.sdkInt)
  }

  @Test
  fun `handled exception response retains the SDK timestamp and wire fields`() {
    val response = handledExceptionEventResponse(handled, nowMs = 9999L)

    assertEquals(1234L, response.timestamp)
    assertEquals("java.lang.IllegalStateException", response.event.exceptionClass)
    assertEquals("Unexpected state", response.event.message)
    assertEquals(
      "IllegalStateException: Unexpected state\n  at App.run(App.kt:42)",
      response.event.stackTrace,
    )
    assertEquals("Handled by app", response.event.customMessage)
    assertEquals("profile", response.event.currentScreen)
    assertEquals("com.example.app", response.event.packageName)
    assertEquals("1.2.3", response.event.appVersion)
    val deviceInfo = requireNotNull(response.event.deviceInfo)
    assertEquals("Pixel 8", deviceInfo.model)
    assertEquals("Google", deviceInfo.manufacturer)
    assertEquals("14", deviceInfo.osVersion)
    assertEquals(34, deviceInfo.sdkInt)
  }

  @Test
  fun `both responses fall back to now when the legacy timestamp extra is zero or negative`() {
    for (reported in listOf(0L, -1L)) {
      assertEquals(9999L, crashEventResponse(crash.copy(timestamp = reported), 9999L).timestamp)
      assertEquals(
        9999L,
        handledExceptionEventResponse(handled.copy(timestamp = reported), 9999L).timestamp,
      )
    }
  }

  @Test
  fun `crashEventTimestamp keeps a positive reported time`() {
    assertEquals(1234L, crashEventTimestamp(reportedMs = 1234L, nowMs = 9999L))
  }

  @Test
  fun `crashEventTimestamp falls back to now for zero or negative`() {
    assertEquals(9999L, crashEventTimestamp(reportedMs = 0L, nowMs = 9999L))
    assertEquals(9999L, crashEventTimestamp(reportedMs = -1L, nowMs = 9999L))
  }
}

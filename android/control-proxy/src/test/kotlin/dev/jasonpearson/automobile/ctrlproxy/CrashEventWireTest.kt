package dev.jasonpearson.automobile.ctrlproxy

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class CrashEventWireTest {

  @Test
  fun `crash response retains the SDK crash timestamp`() {
    val response =
      crashEventResponse(
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
    val response =
      handledExceptionEventResponse(
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
  fun `crashEventTimestamp keeps a positive reported time`() {
    assertEquals(1234L, crashEventTimestamp(reportedMs = 1234L, nowMs = 9999L))
  }

  @Test
  fun `crashEventTimestamp falls back to now for zero or negative`() {
    assertEquals(9999L, crashEventTimestamp(reportedMs = 0L, nowMs = 9999L))
    assertEquals(9999L, crashEventTimestamp(reportedMs = -1L, nowMs = 9999L))
  }

  @Test
  fun `broadcastCrashEvent preserves the reported timestamp through the response helper`() {
    val body = broadcastBody("broadcastCrashEvent")

    assertTrue(
      "broadcastCrashEvent must call crashEventResponse with timestamp = crashEventTimestamp(timestamp, ...)",
      Regex(
          """\bcrashEventResponse\s*\(\s*timestamp\s*=\s*crashEventTimestamp\s*\(\s*timestamp\s*,""",
        )
        .containsMatchIn(body),
    )

    val bareClockTimestamp =
      Regex("""\btimestamp\s*=\s*System\s*\.\s*currentTimeMillis\s*\(\s*\)""")
    for (construction in Regex("""\bCrashEvent\s*\(""").findAll(body)) {
      val argumentsOpen = construction.range.last
      val arguments =
        body.substring(argumentsOpen, KotlinSourceScan.matchParen(body, argumentsOpen))
      assertFalse(
        "broadcastCrashEvent must not construct CrashEvent with timestamp = System.currentTimeMillis(); preserve the reported crash time",
        bareClockTimestamp.containsMatchIn(arguments),
      )
    }
  }

  @Test
  fun `broadcastHandledExceptionEvent preserves the reported timestamp through the response helper`() {
    val body = broadcastBody("broadcastHandledExceptionEvent")

    assertTrue(
      "broadcastHandledExceptionEvent must call handledExceptionEventResponse with timestamp = crashEventTimestamp(timestamp, ...)",
      Regex(
          """\bhandledExceptionEventResponse\s*\(\s*timestamp\s*=\s*crashEventTimestamp\s*\(\s*timestamp\s*,""",
        )
        .containsMatchIn(body),
    )

    val bareClockTimestamp =
      Regex("""\btimestamp\s*=\s*System\s*\.\s*currentTimeMillis\s*\(\s*\)""")
    for (construction in Regex("""\bHandledExceptionEvent\s*\(""").findAll(body)) {
      val argumentsOpen = construction.range.last
      val arguments =
        body.substring(argumentsOpen, KotlinSourceScan.matchParen(body, argumentsOpen))
      assertFalse(
        "broadcastHandledExceptionEvent must not construct HandledExceptionEvent with timestamp = System.currentTimeMillis(); preserve the reported handled exception time",
        bareClockTimestamp.containsMatchIn(arguments),
      )
    }
  }

  private fun broadcastBody(functionName: String): String {
    val source = KotlinSourceScan.maskLiteralsAndComments(locateCtrlProxySource().readText())
    val declaration = Regex("""\bfun\s+${Regex.escape(functionName)}\s*\(""").find(source)
    assertTrue("$functionName declaration not found in CtrlProxy.kt", declaration != null)
    val parenOpen = requireNotNull(declaration).range.last
    val parametersEnd = KotlinSourceScan.matchParen(source, parenOpen)
    val bodyOpen = source.indexOf('{', parametersEnd)
    assertTrue("$functionName body not found after its parameter list", bodyOpen >= 0)
    return source.substring(bodyOpen, KotlinSourceScan.matchBrace(source, bodyOpen))
  }

  private fun locateCtrlProxySource(): File {
    val rel = "src/main/kotlin/dev/jasonpearson/automobile/ctrlproxy/CtrlProxy.kt"
    val direct =
      listOf(File(rel), File("control-proxy/$rel"), File("android/control-proxy/$rel"))
        .firstOrNull { it.isFile }
    if (direct != null) return direct

    val userDir = System.getProperty("user.dir") ?: "."
    var dir: File? = File(userDir).absoluteFile
    while (dir != null) {
      for (candidate in
        listOf(
          File(dir, rel),
          File(dir, "control-proxy/$rel"),
          File(dir, "android/control-proxy/$rel"),
        )) {
        if (candidate.isFile) return candidate
      }
      dir = dir.parentFile
    }
    fail("Could not locate CtrlProxy.kt from user.dir=$userDir")
    error("unreachable")
  }
}

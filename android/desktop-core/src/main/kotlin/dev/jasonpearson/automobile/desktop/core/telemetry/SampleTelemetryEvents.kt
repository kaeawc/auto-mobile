package dev.jasonpearson.automobile.desktop.core.telemetry

import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue

internal fun generateFakeEvents(): List<TelemetryDisplayEvent> {
  val now = System.currentTimeMillis()
  return sampleTelemetry0(now) +
    sampleTelemetry1(now) +
    sampleTelemetry2(now) +
    sampleTelemetry3(now) +
    sampleTelemetry4(now) +
    sampleTelemetry5(now)
}

private fun sampleTelemetry0(now: Long): List<TelemetryDisplayEvent> =
  listOf(
    TelemetryDisplayEvent.Network(
      timestamp = now - 500,
      method = "GET",
      statusCode = 200,
      url = "https://api.example.com/users",
      durationMs = 42,
      host = "api.example.com",
      path = "/users",
      error = null,
      requestHeaders = mapOf("Accept" to "application/json", "Authorization" to "Bearer tok_xxx"),
      responseHeaders = mapOf("Content-Type" to "application/json", "X-Request-Id" to "abc-123"),
      requestBody = null,
      responseBody = """[{"id":1,"name":"Alice"},{"id":2,"name":"Bob"}]""",
      contentType = "application/json",
    ),
    TelemetryDisplayEvent.Network(
      timestamp = now - 1200,
      method = "POST",
      statusCode = 500,
      url = "https://api.example.com/upload",
      durationMs = 1530,
      host = "api.example.com",
      path = "/upload",
      error = "Internal Server Error",
      requestHeaders = mapOf("Content-Type" to "application/json"),
      responseHeaders = null,
      requestBody = """{"file":"data.csv","size":1024}""",
      responseBody = null,
      contentType = null,
    ),
    TelemetryDisplayEvent.Log(
      timestamp = now - 2000,
      level = 4,
      tag = "MainActivity",
      message = "Activity resumed",
    ),
  )

private fun sampleTelemetry1(now: Long): List<TelemetryDisplayEvent> =
  listOf(
    TelemetryDisplayEvent.Log(
      timestamp = now - 2500,
      level = 5,
      tag = "NetworkManager",
      message = "Slow response detected: 1530ms",
    ),
    TelemetryDisplayEvent.Log(
      timestamp = now - 3000,
      level = 6,
      tag = "CrashReporter",
      message = "Unhandled exception in coroutine",
    ),
    TelemetryDisplayEvent.Os(
      timestamp = now - 4000,
      category = "lifecycle",
      kind = "foreground",
      details = null,
    ),
  )

private fun sampleTelemetry2(now: Long): List<TelemetryDisplayEvent> =
  listOf(
    TelemetryDisplayEvent.Os(
      timestamp = now - 5500,
      category = "broadcast",
      kind = "LOCALE_CHANGED",
      details = mapOf("locale" to "en_US"),
    ),
    TelemetryDisplayEvent.Navigation(
      timestamp = now - 5800,
      destination = "HomeScreen",
      source = "sdk",
      arguments = mapOf("tab" to "discover"),
      metadata = null,
      triggeringInteraction = "tap on 'Home'",
      screenshotUri = null,
    ),
    TelemetryDisplayEvent.Log(
      timestamp = now - 6000,
      level = 4,
      tag = "CustomEvent",
      message = "button_click {screen:home, button:refresh}",
    ),
  )

private fun sampleTelemetry3(now: Long): List<TelemetryDisplayEvent> =
  listOf(
    TelemetryDisplayEvent.Log(
      timestamp = now - 7000,
      level = 4,
      tag = "CustomEvent",
      message = "purchase_completed {item:premium, price:9.99}",
    ),
    TelemetryDisplayEvent.Network(
      timestamp = now - 8000,
      method = "GET",
      statusCode = 404,
      url = "https://api.example.com/missing",
      durationMs = 15,
      host = "api.example.com",
      path = "/missing",
      error = null,
      requestHeaders = null,
      responseHeaders = null,
      requestBody = null,
      responseBody = null,
      contentType = null,
    ),
    TelemetryDisplayEvent.Failure(
      timestamp = now - 9000,
      type = "crash",
      occurrenceId = "occ-001",
      severity = "critical",
      title = "NullPointerException at UserRepository.kt:42",
      exceptionType = "java.lang.NullPointerException",
      screen = "ProfileScreen",
      stackTrace =
        listOf(
          StackTraceFrame(
            "com.example.app.UserRepository",
            "getUser",
            "UserRepository.kt",
            42,
            true,
          ),
          StackTraceFrame(
            "com.example.app.ProfileViewModel",
            "loadProfile",
            "ProfileViewModel.kt",
            28,
            true,
          ),
          StackTraceFrame("androidx.lifecycle.ViewModel", "init", null, null, false),
        ),
    ),
  )

private fun sampleTelemetry4(now: Long): List<TelemetryDisplayEvent> =
  listOf(
    TelemetryDisplayEvent.Failure(
      timestamp = now - 10000,
      type = "anr",
      occurrenceId = "occ-002",
      severity = "high",
      title = "Main thread blocked in NetworkManager.fetch",
      exceptionType = null,
      screen = "HomeScreen",
      stackTrace = null,
    ),
    TelemetryDisplayEvent.Failure(
      timestamp = now - 11000,
      type = "nonfatal",
      occurrenceId = "occ-003",
      severity = "medium",
      title = "IOException at CacheManager.kt:88",
      exceptionType = "java.io.IOException",
      screen = "SettingsScreen",
      stackTrace =
        listOf(
          StackTraceFrame(
            "com.example.app.CacheManager",
            "writeCache",
            "CacheManager.kt",
            88,
            true,
          ),
          StackTraceFrame("java.io.FileOutputStream", "write", null, null, false),
        ),
    ),
    TelemetryDisplayEvent.Storage(
      timestamp = now - 12000,
      fileName = "user_prefs.xml",
      key = "dark_mode",
      value = "true",
      valueType = "BOOLEAN",
      changeType = "modify",
      previousValue = "false",
    ),
  )

private fun sampleTelemetry5(now: Long): List<TelemetryDisplayEvent> =
  listOf(
    TelemetryDisplayEvent.Storage(
      timestamp = now - 13000,
      fileName = "session.xml",
      key = "auth_token",
      value = null,
      valueType = null,
      changeType = "remove",
      previousValue = "eyJhbGciOiJIUzI1NiJ9...",
    ),
    TelemetryDisplayEvent.Layout(
      timestamp = now - 14000,
      subType = "excessive_recomposition",
      composableName = "AnimatedCounter",
      recompositionCount = 15,
      durationMs = 8,
      likelyCause = "unstable_lambda",
      screenName = "HomeScreen",
      detailsJson = null,
    ),
    TelemetryDisplayEvent.Layout(
      timestamp = now - 15000,
      subType = "hierarchy_change",
      composableName = null,
      recompositionCount = null,
      durationMs = null,
      likelyCause = null,
      screenName = "SettingsScreen",
      detailsJson =
        """{"screenName":"SettingsScreen","windowCount":3,"foregroundActivity":"com.example.app.SettingsActivity"}""",
    ),
  )

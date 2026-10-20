package dev.jasonpearson.automobile.desktop.core.failures

internal fun mockFailureGroup2(now: Long): FailureGroup =
  FailureGroup(
    id = "anr-1",
    type = FailureType.ANR,
    signature = "ANR in HomeFragment.onResume",
    title = "ANR: Main thread blocked during DB query",
    message =
      "Application Not Responding: Main thread blocked for 5+ seconds during database query",
    firstOccurrence = now - 86400000 * 2,
    lastOccurrence = now - 7200000,
    totalCount = 8,
    uniqueSessions = 7,
    severity = FailureSeverity.High,
    deviceBreakdown =
      listOf(
        DeviceBreakdown("Pixel 7", "Android 14", 4, 50f),
        DeviceBreakdown("Pixel 6", "Android 13", 3, 37f),
        DeviceBreakdown("Samsung A54", "Android 13", 1, 13f),
      ),
    versionBreakdown =
      listOf(
        VersionBreakdown("2.4.1-debug", 6, 75f),
        VersionBreakdown("2.4.0", 2, 25f),
      ),
    screenBreakdown =
      listOf(
        ScreenBreakdown("Splash", 8, 0, 100f),
        ScreenBreakdown("Login", 8, 0, 100f),
        ScreenBreakdown("Home", 8, 8, 100f),
      ),
    failureScreens = mapOf("Home" to 8),
    stackTraceElements = mockFailureGroup2StackTraceElements(),
    toolCallInfo = null,
    affectedTests = mapOf("testHomeLoad" to 5, "testProfileEdit" to 3),
    recentCaptures = mockFailureGroup2RecentCaptures(now),
    sampleOccurrences = mockFailureGroup2SampleOccurrences(now),
  )

private fun mockFailureGroup2StackTraceElements() =
  listOf(
    StackTraceElement(
      "com.example.app.data.UserDao",
      "getAllUsers",
      "UserDao.kt",
      23,
      true,
    ),
    StackTraceElement(
      "com.example.app.HomeViewModel",
      "loadUsers",
      "HomeViewModel.kt",
      45,
      true,
    ),
    StackTraceElement(
      "com.example.app.HomeFragment",
      "onResume",
      "HomeFragment.kt",
      31,
      true,
    ),
    StackTraceElement(
      "androidx.fragment.app.Fragment",
      "performResume",
      "Fragment.java",
      3135,
      false,
    ),
  )

private fun mockFailureGroup2RecentCaptures(now: Long) =
  listOf(
    FailureCapture(
      "cap-4",
      CaptureType.Video,
      "/captures/anr-1/1.mp4",
      now - 7200000,
      "Pixel 7",
    ),
    FailureCapture(
      "cap-5",
      CaptureType.Video,
      "/captures/anr-1/2.mp4",
      now - 14400000,
      "Pixel 6",
    ),
  )

private fun mockFailureGroup2SampleOccurrences(now: Long) =
  listOf(
    FailureOccurrence(
      "occ-7",
      now - 7200000,
      "Pixel 7",
      "Android 14",
      "2.4.1-debug",
      "session-7",
      "Home",
      listOf("Splash", "Login", "Home"),
      "testHomeLoad",
      "/captures/anr-1/1.mp4",
      CaptureType.Video,
    ),
    FailureOccurrence(
      "occ-8",
      now - 14400000,
      "Pixel 6",
      "Android 13",
      "2.4.1-debug",
      "session-8",
      "Home",
      listOf("Splash", "Login", "Home"),
      "testProfileEdit",
      "/captures/anr-1/2.mp4",
      CaptureType.Video,
    ),
    FailureOccurrence(
      "occ-9",
      now - 21600000,
      "Samsung A54",
      "Android 13",
      "2.4.0",
      "session-9",
      "Home",
      listOf("Splash", "Login", "Home"),
      "testHomeLoad",
      null,
      null,
    ),
  )

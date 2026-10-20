package dev.jasonpearson.automobile.desktop.core.failures

internal fun mockFailureGroup1(now: Long): FailureGroup =
  FailureGroup(
    id = "crash-1",
    type = FailureType.Crash,
    signature = "NullPointerException at LoginViewModel.kt:42",
    title = "NullPointerException in LoginViewModel",
    message =
      "java.lang.NullPointerException: Attempt to invoke virtual method 'String com.example.User.getName()' on a null object reference",
    firstOccurrence = now - 86400000 * 3,
    lastOccurrence = now - 3600000,
    totalCount = 23,
    uniqueSessions = 18,
    severity = FailureSeverity.Critical,
    deviceBreakdown =
      listOf(
        DeviceBreakdown("Pixel 8", "Android 15", 9, 39f),
        DeviceBreakdown("Pixel 7", "Android 14", 6, 26f),
        DeviceBreakdown("Samsung S24", "Android 14", 5, 22f),
        DeviceBreakdown("OnePlus 12", "Android 14", 3, 13f),
      ),
    versionBreakdown =
      listOf(
        VersionBreakdown("2.4.1-debug", 15, 65f),
        VersionBreakdown("2.4.0", 6, 26f),
        VersionBreakdown("2.3.9", 2, 9f),
      ),
    screenBreakdown =
      listOf(
        ScreenBreakdown("Splash", 23, 0, 100f),
        ScreenBreakdown("Login", 23, 23, 100f),
      ),
    failureScreens = mapOf("Login" to 23),
    stackTraceElements = mockFailureGroup1StackTraceElements(),
    toolCallInfo = null,
    affectedTests = mapOf("testLoginFlow" to 15, "testSignupValidation" to 8),
    recentCaptures = mockFailureGroup1RecentCaptures(now),
    sampleOccurrences = mockFailureGroup1SampleOccurrences(now),
  )

private fun mockFailureGroup1StackTraceElements() =
  listOf(
    StackTraceElement(
      "com.example.app.LoginViewModel",
      "validateUser",
      "LoginViewModel.kt",
      42,
      true,
    ),
    StackTraceElement(
      "com.example.app.LoginViewModel",
      "onLoginClicked",
      "LoginViewModel.kt",
      28,
      true,
    ),
    StackTraceElement(
      "com.example.app.LoginFragment",
      "onClick",
      "LoginFragment.kt",
      67,
      true,
    ),
    StackTraceElement("android.view.View", "performClick", "View.java", 7448, false),
  )

private fun mockFailureGroup1RecentCaptures(now: Long) =
  listOf(
    FailureCapture(
      "cap-1",
      CaptureType.Screenshot,
      "/captures/crash-1/1.png",
      now - 3600000,
      "Pixel 8",
    ),
    FailureCapture(
      "cap-2",
      CaptureType.Screenshot,
      "/captures/crash-1/2.png",
      now - 7200000,
      "Samsung S24",
    ),
    FailureCapture(
      "cap-3",
      CaptureType.Video,
      "/captures/crash-1/3.mp4",
      now - 10800000,
      "Pixel 7",
    ),
  )

private fun mockFailureGroup1SampleOccurrences(now: Long) =
  listOf(
    mockCrashOccurrence1(now),
    mockCrashOccurrence2(now),
    mockCrashOccurrence3(now),
    mockCrashOccurrence4(now),
    mockCrashOccurrence5(now),
    mockCrashOccurrence6(now),
  )

private fun mockCrashOccurrence1(now: Long) =
  FailureOccurrence(
    "occ-1",
    now - 3600000,
    "Pixel 8",
    "Android 15",
    "2.4.1-debug",
    "session-1",
    "Login",
    listOf("Splash", "Login"),
    "testLoginFlow",
    "/captures/crash-1/1.png",
    CaptureType.Screenshot,
  )

private fun mockCrashOccurrence2(now: Long) =
  FailureOccurrence(
    "occ-2",
    now - 7200000,
    "Samsung S24",
    "Android 14",
    "2.4.1-debug",
    "session-2",
    "Login",
    listOf("Splash", "Login"),
    "testLoginFlow",
    "/captures/crash-1/2.png",
    CaptureType.Screenshot,
  )

private fun mockCrashOccurrence3(now: Long) =
  FailureOccurrence(
    "occ-3",
    now - 10800000,
    "Pixel 7",
    "Android 14",
    "2.4.0",
    "session-3",
    "Login",
    listOf("Splash", "Login"),
    "testSignupValidation",
    "/captures/crash-1/3.mp4",
    CaptureType.Video,
  )

private fun mockCrashOccurrence4(now: Long) =
  FailureOccurrence(
    "occ-4",
    now - 14400000,
    "OnePlus 12",
    "Android 14",
    "2.4.1-debug",
    "session-4",
    "Login",
    listOf("Splash", "Login"),
    "testLoginFlow",
    null,
    null,
  )

private fun mockCrashOccurrence5(now: Long) =
  FailureOccurrence(
    "occ-5",
    now - 18000000,
    "Pixel 8",
    "Android 15",
    "2.4.0",
    "session-5",
    "Login",
    listOf("Splash", "Login"),
    "testSignupValidation",
    null,
    null,
  )

private fun mockCrashOccurrence6(now: Long) =
  FailureOccurrence(
    "occ-6",
    now - 21600000,
    "Pixel 7",
    "Android 14",
    "2.3.9",
    "session-6",
    "Login",
    listOf("Splash", "Login"),
    "testLoginFlow",
    null,
    null,
  )

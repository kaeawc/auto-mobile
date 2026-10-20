package dev.jasonpearson.automobile.desktop.core.failures

internal fun mockFailureGroup4(now: Long): FailureGroup =
  FailureGroup(
    id = "crash-2",
    type = FailureType.Crash,
    signature = "IndexOutOfBoundsException at RecyclerView",
    title = "IndexOutOfBoundsException in MessageList",
    message =
      "java.lang.IndexOutOfBoundsException: Inconsistency detected. Invalid view holder adapter position",
    firstOccurrence = now - 86400000 * 5,
    lastOccurrence = now - 86400000,
    totalCount = 5,
    uniqueSessions = 5,
    severity = FailureSeverity.Low,
    deviceBreakdown =
      listOf(
        DeviceBreakdown("Pixel 8", "Android 15", 3, 60f),
        DeviceBreakdown("Pixel 7", "Android 14", 2, 40f),
      ),
    versionBreakdown = listOf(VersionBreakdown("2.4.1-debug", 5, 100f)),
    screenBreakdown =
      listOf(
        ScreenBreakdown("Home", 5, 0, 100f),
        ScreenBreakdown("Messages", 5, 5, 100f),
      ),
    failureScreens = mapOf("Messages" to 5),
    stackTraceElements = mockFailureGroup4StackTraceElements(),
    toolCallInfo = null,
    affectedTests = mapOf("testSendMessage" to 5),
    recentCaptures = emptyList(),
    sampleOccurrences = mockFailureGroup4SampleOccurrences(now),
  )

private fun mockFailureGroup4StackTraceElements() =
  listOf(
    StackTraceElement(
      "androidx.recyclerview.widget.RecyclerView",
      "findViewHolderForPosition",
      "RecyclerView.java",
      1345,
      false,
    ),
    StackTraceElement(
      "com.example.app.MessageListAdapter",
      "onBindViewHolder",
      "MessageListAdapter.kt",
      67,
      true,
    ),
  )

private fun mockFailureGroup4SampleOccurrences(now: Long) =
  listOf(
    FailureOccurrence(
      "occ-13",
      now - 86400000,
      "Pixel 8",
      "Android 15",
      "2.4.1-debug",
      "session-13",
      "Messages",
      listOf("Home", "Messages"),
      "testSendMessage",
      null,
      null,
    ),
    FailureOccurrence(
      "occ-14",
      now - 86400000 * 2,
      "Pixel 7",
      "Android 14",
      "2.4.1-debug",
      "session-14",
      "Messages",
      listOf("Home", "Messages"),
      "testSendMessage",
      null,
      null,
    ),
  )

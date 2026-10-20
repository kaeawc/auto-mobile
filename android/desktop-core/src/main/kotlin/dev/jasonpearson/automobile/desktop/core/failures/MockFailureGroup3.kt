package dev.jasonpearson.automobile.desktop.core.failures

internal fun mockFailureGroup3(now: Long): FailureGroup =
  FailureGroup(
    id = "tool-1",
    type = FailureType.ToolCallFailure,
    signature = "tapOn failed: Element not found",
    title = "tapOn: Element not found",
    message = "Element with text not found within timeout. Check element visibility and timing.",
    firstOccurrence = now - 86400000,
    lastOccurrence = now - 1800000,
    totalCount = 12,
    uniqueSessions = 10,
    severity = FailureSeverity.Medium,
    deviceBreakdown =
      listOf(
        DeviceBreakdown("iPhone 15 Pro", "iOS 17.2", 5, 42f),
        DeviceBreakdown("iPhone 14", "iOS 17.1", 4, 33f),
        DeviceBreakdown("Pixel 8", "Android 15", 3, 25f),
      ),
    versionBreakdown =
      listOf(
        VersionBreakdown("2.4.0", 8, 67f),
        VersionBreakdown("2.4.1-debug", 4, 33f),
      ),
    screenBreakdown =
      listOf(
        ScreenBreakdown("Home", 12, 0, 100f),
        ScreenBreakdown("Cart", 12, 0, 100f),
        ScreenBreakdown("Checkout", 12, 12, 100f),
      ),
    failureScreens = mapOf("Checkout" to 12),
    stackTraceElements = emptyList(),
    toolCallInfo = mockFailureGroup3ToolCallInfo(),
    affectedTests = mapOf("testFormSubmission" to 7, "testCheckout" to 5),
    recentCaptures = mockFailureGroup3RecentCaptures(now),
    sampleOccurrences = mockFailureGroup3SampleOccurrences(now),
  )

private fun mockFailureGroup3ToolCallInfo() =
  AggregatedToolCallInfo(
    toolName = "tapOn",
    errorCodes = mapOf("ELEMENT_NOT_FOUND" to 10, "TIMEOUT" to 2),
    parameterVariants =
      mapOf(
        "text" to listOf("Submit", "Complete Order", "Place Order"),
        "timeout" to listOf("5000", "10000"),
      ),
    durationStats =
      DurationStats(
        minMs = 5001,
        maxMs = 10234,
        avgMs = 6543,
        medianMs = 5500,
        p95Ms = 9800,
      ),
  )

private fun mockFailureGroup3RecentCaptures(now: Long) =
  listOf(
    FailureCapture(
      "cap-6",
      CaptureType.Screenshot,
      "/captures/tool-1/1.png",
      now - 1800000,
      "iPhone 15 Pro",
    ),
    FailureCapture(
      "cap-7",
      CaptureType.Screenshot,
      "/captures/tool-1/2.png",
      now - 3600000,
      "Pixel 8",
    ),
    FailureCapture(
      "cap-8",
      CaptureType.Screenshot,
      "/captures/tool-1/3.png",
      now - 7200000,
      "iPhone 14",
    ),
  )

private fun mockFailureGroup3SampleOccurrences(now: Long) =
  listOf(
    FailureOccurrence(
      "occ-10",
      now - 1800000,
      "iPhone 15 Pro",
      "iOS 17.2",
      "2.4.0",
      "session-10",
      "Checkout",
      listOf("Home", "Cart", "Checkout"),
      "testCheckout",
      "/captures/tool-1/1.png",
      CaptureType.Screenshot,
    ),
    FailureOccurrence(
      "occ-11",
      now - 3600000,
      "Pixel 8",
      "Android 15",
      "2.4.1-debug",
      "session-11",
      "Checkout",
      listOf("Home", "Cart", "Checkout"),
      "testFormSubmission",
      "/captures/tool-1/2.png",
      CaptureType.Screenshot,
    ),
    FailureOccurrence(
      "occ-12",
      now - 7200000,
      "iPhone 14",
      "iOS 17.1",
      "2.4.0",
      "session-12",
      "Checkout",
      listOf("Home", "Cart", "Checkout"),
      "testCheckout",
      "/captures/tool-1/3.png",
      CaptureType.Screenshot,
    ),
  )

package dev.jasonpearson.automobile.desktop.core.failures

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.runComposeUiTest
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class FailuresViewAllUiTest {
  @Test
  fun `captures expand and collapse`() =
    assertExpansion(FailureSection.Captures, "captures", "capture-6")

  @Test
  fun `screens expand and collapse`() =
    assertExpansion(FailureSection.Screens, "screens", "screen-6")

  @Test
  fun `devices expand and collapse`() =
    assertExpansion(FailureSection.Devices, "devices", "device-6")

  @Test
  fun `versions expand and collapse`() =
    assertExpansion(FailureSection.Versions, "versions", "version-6")

  @Test fun `tests expand and collapse`() = assertExpansion(FailureSection.Tests, "tests", "test-6")

  @Test
  fun `occurrences expand and collapse`() =
    assertExpansion(FailureSection.Occurrences, "occurrences", "occurrence-6")

  @Test
  fun `sample occurrences show loaded count without promising all occurrences`() =
    runComposeUiTest {
      setContent {
        MaterialTheme {
          FailureDetailView(
            fixture(FailureSection.Occurrences, totalCount = 42),
            {},
            {},
            {},
            { _, _ -> },
          )
        }
      }
      onNodeWithText("occurrence-6").assertDoesNotExist()
      onNodeWithText("Show 6 of 42 occurrences →").assertExists()
      onNodeWithText("View all 42 occurrences", substring = true).assertDoesNotExist()
      onNodeWithText("Show 6 of 42 occurrences →").performScrollTo().performClick()
      onNodeWithText("occurrence-6").performScrollTo().assertIsDisplayed()
      onNodeWithText("Show less →").assertExists()
    }

  @Test
  fun `sample occurrences at preview limit have no expansion link`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        FailureDetailView(
          fixture(FailureSection.Occurrences, totalCount = 42, rowCount = 5),
          {},
          {},
          {},
          { _, _ -> },
        )
      }
    }
    for (row in 1..5) {
      onNodeWithText("occurrence-$row").performScrollTo().assertIsDisplayed()
    }
    onNodeWithText("View all", substring = true).assertDoesNotExist()
    onNodeWithText("Show 6 of", substring = true).assertDoesNotExist()
    onNodeWithText("Show less", substring = true).assertDoesNotExist()
  }

  @Test
  fun `error codes expand and collapse`() =
    assertExpansion(FailureSection.ErrorCodes, "error codes", "code-6")

  @Test
  fun `parameters expand and collapse`() =
    assertExpansion(FailureSection.Parameters, "parameters", "parameter-6: ")

  @Test
  fun `switching failures resets expansion`() = runComposeUiTest {
    val failure = mutableStateOf(fixture(FailureSection.Devices))
    setContent {
      MaterialTheme { FailureDetailView(failure.value, {}, {}, {}, { _, _ -> }) }
    }
    onNodeWithText("View all 6 devices →").performScrollTo().performClick()
    onNodeWithText("device-6").assertExists()
    runOnIdle { failure.value = failure.value.copy(id = "other-failure") }
    onNodeWithText("device-6").assertDoesNotExist()
    onNodeWithText("View all 6 devices →").assertExists()
  }

  @Test
  fun `lists at the limit have no expansion link`() = runComposeUiTest {
    val failure = mutableStateOf(fixture(FailureSection.Devices))
    setContent {
      MaterialTheme {
        FailureDetailView(
          failure.value,
          {},
          {},
          {},
          { _, _ -> },
        )
      }
    }
    // Prove the selectors find rendered links before checking their absence at the limit.
    onNodeWithText("View all", substring = true).performScrollTo().performClick()
    onNodeWithText("Show less →").assertExists()
    runOnIdle {
      failure.value =
        failure.value.copy(id = "at-limit", deviceBreakdown = failure.value.deviceBreakdown.take(5))
    }
    onNodeWithText("device-5").assertExists()
    onNodeWithText("View all", substring = true).assertDoesNotExist()
    onNodeWithText("Show less →").assertDoesNotExist()
  }

  private fun assertExpansion(section: FailureSection, label: String, hidden: String) =
    runComposeUiTest {
      setContent {
        MaterialTheme { FailureDetailView(fixture(section), {}, {}, {}, { _, _ -> }) }
      }
      onNodeWithText(hidden).assertDoesNotExist()
      onNodeWithText("View all 6 $label →").performScrollTo().performClick()
      if (section == FailureSection.Captures) {
        // Bring the gallery into vertical view before scrolling its horizontal row.
        onNodeWithText("Captures (6)").performScrollTo()
      }
      onNodeWithText(hidden).performScrollTo().assertIsDisplayed()
      onNodeWithText("Show less →").performScrollTo().performClick()
      onNodeWithText(hidden).assertDoesNotExist()
      onNodeWithText("View all 6 $label →").assertExists()
    }

  private fun fixture(
    section: FailureSection,
    totalCount: Int = 6,
    rowCount: Int = 6,
  ): FailureGroup {
    val rows = (1..rowCount).toList()
    return FailureGroup(
      id = "failure",
      type = FailureType.ToolCallFailure,
      signature = "signature",
      title = "Failure",
      message = "message",
      firstOccurrence = 0L,
      lastOccurrence = 0L,
      totalCount = totalCount,
      uniqueSessions = 1,
      severity = FailureSeverity.High,
      deviceBreakdown =
        if (section == FailureSection.Devices)
          rows.map { DeviceBreakdown("device-$it", "Android", 7 - it, 10f) }
        else emptyList(),
      versionBreakdown =
        if (section == FailureSection.Versions)
          rows.map { VersionBreakdown("version-$it", 7 - it, 10f) }
        else emptyList(),
      screenBreakdown =
        if (section == FailureSection.Screens)
          rows.map { ScreenBreakdown("screen-$it", 7 - it, 0, 10f) }
        else emptyList(),
      failureScreens = emptyMap(),
      stackTraceElements = emptyList(),
      toolCallInfo =
        when (section) {
          FailureSection.ErrorCodes ->
            AggregatedToolCallInfo("tap", rows.associate { "code-$it" to 7 - it }, emptyMap(), null)
          FailureSection.Parameters ->
            AggregatedToolCallInfo(
              "tap",
              emptyMap(),
              rows.associate { "parameter-$it" to listOf("value-$it") },
              null,
            )
          else -> null
        },
      affectedTests =
        if (section == FailureSection.Tests) rows.associate { "test-$it" to 7 - it }
        else emptyMap(),
      recentCaptures =
        if (section == FailureSection.Captures)
          rows.map { FailureCapture("capture-$it", CaptureType.Screenshot, "", 0L, "capture-$it") }
        else emptyList(),
      sampleOccurrences =
        if (section == FailureSection.Occurrences)
          rows.map {
            FailureOccurrence(
              "occurrence-$it",
              0L,
              "occurrence-$it",
              "Android",
              "1",
              "session",
              null,
              emptyList(),
              null,
              null,
              null,
            )
          }
        else emptyList(),
    )
  }
}

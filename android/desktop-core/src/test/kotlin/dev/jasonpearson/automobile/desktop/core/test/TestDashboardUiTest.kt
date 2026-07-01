package dev.jasonpearson.automobile.desktop.core.test

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.domain.TestPlatform
import dev.jasonpearson.automobile.desktop.domain.TestRun
import dev.jasonpearson.automobile.desktop.domain.TestStatus
import dev.jasonpearson.automobile.desktop.domain.TestStep
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class TestDashboardUiTest {

  private val sampleTestRuns =
    listOf(
      TestRun(
        id = "run1",
        testId = "test1",
        testName = "testLoginFlow",
        status = TestStatus.Passed,
        startTime = 1705003600000L,
        durationMs = 4320,
        steps =
          listOf(
            TestStep(
              "s1",
              0,
              "launch",
              "com.app",
              null,
              "Splash",
              800,
              TestStatus.Passed,
            ),
            TestStep(
              "s2",
              1,
              "tap",
              "Login button",
              null,
              "Login",
              290,
              TestStatus.Passed,
            ),
          ),
        screensVisited = listOf("Splash", "Login", "Home"),
        deviceId = "pixel8",
        deviceName = "Pixel 8 API 35",
        platform = TestPlatform.Android,
      ),
      TestRun(
        id = "run2",
        testId = "test2",
        testName = "testSignupValidation",
        status = TestStatus.Failed,
        startTime = 1705003500000L,
        durationMs = 2890,
        steps = emptyList(),
        screensVisited = listOf("Splash", "Login", "Signup"),
        errorMessage = "AssertionError: Expected error toast not found",
        deviceId = "pixel8",
        deviceName = "Pixel 8 API 35",
        platform = TestPlatform.Android,
      ),
    )

  @Test
  fun `shows loading state`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        TestDashboardHome(
          testRuns = emptyList(),
          isLoading = true,
          error = null,
          onRecordTest = {},
          onTestRunClick = {},
        )
      }
    }
    onNodeWithText("Loading test data...").assertIsDisplayed()
  }

  @Test
  fun `shows error state`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        TestDashboardHome(
          testRuns = emptyList(),
          isLoading = false,
          error = "Connection refused",
          onRecordTest = {},
          onTestRunClick = {},
        )
      }
    }
    onNodeWithText("Connection refused").assertIsDisplayed()
  }

  @Test
  fun `shows empty state when no test runs`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        TestDashboardHome(
          testRuns = emptyList(),
          isLoading = false,
          error = null,
          onRecordTest = {},
          onTestRunClick = {},
        )
      }
    }
    onNodeWithText("No test runs yet").assertIsDisplayed()
    onNodeWithText("Record or run exploratory tests to see them here").assertIsDisplayed()
  }

  @Test
  fun `shows dashboard header`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        TestDashboardHome(
          testRuns = emptyList(),
          isLoading = false,
          error = null,
          onRecordTest = {},
          onTestRunClick = {},
        )
      }
    }
    onNodeWithText("Testing").assertIsDisplayed()
    onNodeWithText("Create, run, and analyze UI tests").assertIsDisplayed()
  }

  @Test
  fun `shows test run names when data is loaded`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        TestDashboardHome(
          testRuns = sampleTestRuns,
          isLoading = false,
          error = null,
          onRecordTest = {},
          onTestRunClick = {},
        )
      }
    }
    onNodeWithText("testLoginFlow").assertIsDisplayed()
    onNodeWithText("testSignupValidation").assertIsDisplayed()
  }

  @Test
  fun `shows test run duration`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        TestDashboardHome(
          testRuns = sampleTestRuns,
          isLoading = false,
          error = null,
          onRecordTest = {},
          onTestRunClick = {},
        )
      }
    }
    onNodeWithText("4.32s").assertIsDisplayed()
    onNodeWithText("2.89s").assertIsDisplayed()
  }

  @Test
  fun `shows flakiness score for flaky test`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        TestDashboardHome(
          testRuns = sampleTestRuns,
          isLoading = false,
          error = null,
          onRecordTest = {},
          onTestRunClick = {},
        )
      }
    }
    // testSignupValidation has testId=test2 which maps to flakinessScore=0.15f in TestMockData
    onNodeWithText("15% flaky").assertIsDisplayed()
  }

  @Test
  fun `shows filter chips`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        TestDashboardHome(
          testRuns = sampleTestRuns,
          isLoading = false,
          error = null,
          onRecordTest = {},
          onTestRunClick = {},
        )
      }
    }
    onNodeWithText("Recent").assertIsDisplayed()
    onNodeWithText("Popular").assertIsDisplayed()
    onNodeWithText("Both").assertIsDisplayed()
  }

  @Test
  fun `shows test runs header`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        TestDashboardHome(
          testRuns = sampleTestRuns,
          isLoading = false,
          error = null,
          onRecordTest = {},
          onTestRunClick = {},
        )
      }
    }
    onNodeWithText("Test Runs").assertIsDisplayed()
  }
}

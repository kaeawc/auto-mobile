package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.datasource.Result
import dev.jasonpearson.automobile.desktop.core.datasource.TestDataSource
import dev.jasonpearson.automobile.desktop.core.test.TestPlatform
import dev.jasonpearson.automobile.desktop.core.test.TestRun
import dev.jasonpearson.automobile.desktop.core.test.TestStatus
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class TestFacetTest {

  private fun column() = DeviceColumn(deviceId = "d", name = "Pixel", platform = Platform.Android)

  private fun run(
    id: String,
    name: String,
    status: TestStatus = TestStatus.Passed,
    startTime: Long = 0,
    durationMs: Int = 4000,
    deviceName: String = "Pixel 8 API 35",
  ) =
    TestRun(
      id = id,
      testId = "test-$id",
      testName = name,
      status = status,
      startTime = startTime,
      durationMs = durationMs,
      steps = emptyList(),
      screensVisited = emptyList(),
      deviceId = "d",
      deviceName = deviceName,
      platform = TestPlatform.Android,
    )

  private fun source(result: Result<List<TestRun>>) =
    object : TestDataSource {
      override suspend fun getTestRuns(): Result<List<TestRun>> = result
    }

  @Test
  fun `shows the empty state when the device has no runs`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        TestFacet(column = column(), dataSource = source(Result.Success(emptyList())))
      }
    }
    // The load resolves on Dispatchers.IO, which waitForIdle() does not await; wait on the node.
    waitUntil {
      onAllNodesWithText("No test runs for this device", substring = true)
        .fetchSemanticsNodes()
        .isNotEmpty()
    }
    onNodeWithText("No test runs for this device", substring = true).assertIsDisplayed()
  }

  @Test
  fun `renders a row per test run, most recent first`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        TestFacet(
          column = column(),
          dataSource =
            source(
              Result.Success(
                listOf(
                  run("1", "testLoginFlow", startTime = 100),
                  run("2", "testSignupValidation", status = TestStatus.Failed, startTime = 200),
                )
              )
            ),
        )
      }
    }
    // The load resolves on Dispatchers.IO, which waitForIdle() does not await; wait on the node.
    waitUntil {
      onAllNodesWithText("testLoginFlow", substring = true).fetchSemanticsNodes().isNotEmpty()
    }
    onNodeWithText("testLoginFlow", substring = true).assertIsDisplayed()
    onNodeWithText("testSignupValidation", substring = true).assertIsDisplayed()
    // The failed run carries a Failed status label.
    onNodeWithContentDescription("Test run testSignupValidation Failed").assertIsDisplayed()
  }

  @Test
  fun `surfaces a retryable error when the runs fail to load`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        TestFacet(
          column = column(),
          dataSource = source(Result.Error(RuntimeException("daemon down"))),
        )
      }
    }
    // The load resolves on Dispatchers.IO, which waitForIdle() does not await; wait on the node.
    waitUntil {
      onAllNodesWithText("daemon down", substring = true).fetchSemanticsNodes().isNotEmpty()
    }
    onNodeWithText("daemon down", substring = true).assertIsDisplayed()
    onNodeWithContentDescription("Retry loading test runs").assertIsDisplayed()
  }

  @Test
  fun `retry re-invokes the loader and renders the recovered runs`() = runComposeUiTest {
    val attempts = AtomicInteger(0)
    setContent {
      MaterialTheme {
        val recovering =
          object : TestDataSource {
            override suspend fun getTestRuns(): Result<List<TestRun>> =
              if (attempts.getAndIncrement() == 0) Result.Error(RuntimeException("daemon down"))
              else Result.Success(listOf(run("1", "testNavigationSmoke")))
          }
        TestFacet(column = column(), dataSource = recovering)
      }
    }
    // The load resolves on Dispatchers.IO, which waitForIdle() does not await; wait on the node.
    waitUntil {
      onAllNodesWithText("daemon down", substring = true).fetchSemanticsNodes().isNotEmpty()
    }

    onNodeWithContentDescription("Retry loading test runs").performClick()

    waitUntil {
      onAllNodesWithText("testNavigationSmoke", substring = true).fetchSemanticsNodes().isNotEmpty()
    }
    onNodeWithText("testNavigationSmoke", substring = true).assertIsDisplayed()
  }
}

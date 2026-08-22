package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.datasource.FakeNetworkRequestsDataSource
import dev.jasonpearson.automobile.desktop.core.datasource.NetworkRequestDetail
import dev.jasonpearson.automobile.desktop.core.datasource.NetworkRequestRow
import dev.jasonpearson.automobile.desktop.core.datasource.NetworkRequestsDataSource
import dev.jasonpearson.automobile.desktop.core.datasource.Result
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class NetworkFacetTest {

  private fun column() = DeviceColumn(deviceId = "d", name = "Pixel", platform = Platform.Android)

  private fun row(
    id: Long,
    host: String,
    path: String,
    method: String = "GET",
    status: Int = 200,
    duration: Long = 12,
  ) =
    NetworkRequestRow(
      id = id,
      method = method,
      host = host,
      path = path,
      statusCode = status,
      durationMs = duration,
      timestamp = 0,
      contentType = "application/json",
      error = null,
    )

  private fun detail(id: Long) =
    NetworkRequestDetail(
      id = id,
      method = "GET",
      url = "https://api.example.com/users",
      host = "api.example.com",
      path = "/users",
      statusCode = 200,
      durationMs = 12,
      protocol = "h2",
      contentType = "application/json",
      requestHeaders = mapOf("accept" to "application/json"),
      responseHeaders = mapOf("x-cache" to "HIT"),
      error = null,
    )

  @Test
  fun `shows the empty state when there is no captured traffic`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        NetworkFacet(
          column = column(),
          dataSource = FakeNetworkRequestsDataSource(requests = Result.Success(emptyList())),
        )
      }
    }
    // The load resolves on Dispatchers.IO, which waitForIdle() does not await; wait on the node.
    waitUntil {
      onAllNodesWithText("No network activity captured", substring = true)
        .fetchSemanticsNodes()
        .isNotEmpty()
    }
    onNodeWithText("No network activity captured", substring = true).assertIsDisplayed()
  }

  @Test
  fun `renders a row per captured request`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        NetworkFacet(
          column = column(),
          dataSource =
            FakeNetworkRequestsDataSource(
              requests = Result.Success(listOf(row(1, "api.example.com", "/users/{id}")))
            ),
        )
      }
    }
    // The load resolves on Dispatchers.IO, which waitForIdle() does not await; wait on the node.
    waitUntil {
      onAllNodesWithText("api.example.com/users/{id}", substring = true)
        .fetchSemanticsNodes()
        .isNotEmpty()
    }
    onNodeWithText("api.example.com/users/{id}", substring = true).assertIsDisplayed()
  }

  @Test
  fun `selecting a row shows its detail with headers`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        NetworkFacet(
          column = column(),
          dataSource =
            FakeNetworkRequestsDataSource(
              requests = Result.Success(listOf(row(1, "api.example.com", "/users"))),
              details = mapOf(1L to Result.Success(detail(1))),
            ),
        )
      }
    }
    // The load resolves on Dispatchers.IO, which waitForIdle() does not await; wait on the node.
    // Before selection the detail pane prompts for a selection.
    waitUntil {
      onAllNodesWithText("Select a request to inspect", substring = true)
        .fetchSemanticsNodes()
        .isNotEmpty()
    }
    onNodeWithText("Select a request to inspect", substring = true).assertIsDisplayed()

    onNodeWithContentDescription("Network request GET api.example.com/users").performClick()
    waitUntil {
      onAllNodesWithText("Request headers", substring = true).fetchSemanticsNodes().isNotEmpty()
    }

    onNodeWithText("Request headers", substring = true).assertIsDisplayed()
    onNodeWithText("x-cache", substring = true).assertIsDisplayed()
  }

  @Test
  fun `surfaces a retryable error when the requests fail to load`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        NetworkFacet(
          column = column(),
          dataSource =
            FakeNetworkRequestsDataSource(requests = Result.Error(RuntimeException("daemon down"))),
        )
      }
    }
    // The load resolves on Dispatchers.IO, which waitForIdle() does not await; wait on the node.
    waitUntil {
      onAllNodesWithText("daemon down", substring = true).fetchSemanticsNodes().isNotEmpty()
    }
    onNodeWithText("daemon down", substring = true).assertIsDisplayed()
    onNodeWithContentDescription("Retry loading network requests").assertIsDisplayed()
  }

  @Test
  fun `retry re-invokes the loader and renders the recovered rows`() = runComposeUiTest {
    val attempts = AtomicInteger(0)
    setContent {
      MaterialTheme {
        val recovering =
          object : dev.jasonpearson.automobile.desktop.core.datasource.NetworkRequestsDataSource {
            override suspend fun getRequests(): Result<List<NetworkRequestRow>> =
              if (attempts.getAndIncrement() == 0) Result.Error(RuntimeException("daemon down"))
              else Result.Success(listOf(row(1, "api.example.com", "/health")))

            override suspend fun getRequestDetail(id: Long): Result<NetworkRequestDetail> =
              Result.Success(detail(id))
          }
        NetworkFacet(column = column(), dataSource = recovering)
      }
    }
    // The load resolves on Dispatchers.IO, which waitForIdle() does not await; wait on the node.
    waitUntil {
      onAllNodesWithText("daemon down", substring = true).fetchSemanticsNodes().isNotEmpty()
    }

    onNodeWithContentDescription("Retry loading network requests").performClick()

    waitUntil {
      onAllNodesWithText("api.example.com/health", substring = true)
        .fetchSemanticsNodes()
        .isNotEmpty()
    }
    onNodeWithText("api.example.com/health", substring = true).assertIsDisplayed()
  }

  @Test
  fun `retry awaits the IO-dispatched reload before asserting recovered rows`() = runComposeUiTest {
    // Regression pin for #5422. NetworkFacet loads through withContext(Dispatchers.IO); the
    // continuation that writes the resolved state runs on a real IO thread that
    // runComposeUiTest's waitForIdle() does not await. A gated data source makes that visible:
    // waitForIdle() returns while the reload is still parked on the gate, so the recovered row is
    // absent — exactly the window the flaky assertion raced against — and a bounded waitUntil is
    // the wait that deterministically observes the completion.
    val gate = CountDownLatch(1)
    val attempts = AtomicInteger(0)
    setContent {
      MaterialTheme {
        val recovering =
          object : NetworkRequestsDataSource {
            override suspend fun getRequests(): Result<List<NetworkRequestRow>> =
              if (attempts.getAndIncrement() == 0) {
                Result.Error(RuntimeException("daemon down"))
              } else {
                gate.await()
                Result.Success(listOf(row(1, "api.example.com", "/health")))
              }

            override suspend fun getRequestDetail(id: Long): Result<NetworkRequestDetail> =
              Result.Success(detail(id))
          }
        NetworkFacet(column = column(), dataSource = recovering)
      }
    }
    waitUntil {
      onAllNodesWithText("daemon down", substring = true).fetchSemanticsNodes().isNotEmpty()
    }

    onNodeWithContentDescription("Retry loading network requests").performClick()

    // waitForIdle() is not enough: the gated reload is still in flight on Dispatchers.IO, yet
    // waitForIdle() has already returned. The recovered row must therefore be absent here.
    waitForIdle()
    onNodeWithText("api.example.com/health", substring = true).assertDoesNotExist()

    // Releasing the gate lets the IO reload complete; a bounded waitUntil awaits the recomposition.
    gate.countDown()
    waitUntil {
      onAllNodesWithText("api.example.com/health", substring = true)
        .fetchSemanticsNodes()
        .isNotEmpty()
    }
    onNodeWithText("api.example.com/health", substring = true).assertIsDisplayed()
  }

  @Test
  fun `detail pane surfaces a detail-load failure without blanking`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        NetworkFacet(
          column = column(),
          dataSource =
            FakeNetworkRequestsDataSource(
              requests = Result.Success(listOf(row(5, "api.example.com", "/slow"))),
              details = mapOf(5L to Result.Error(RuntimeException("detail unavailable"))),
            ),
        )
      }
    }
    // The load resolves on Dispatchers.IO, which waitForIdle() does not await; wait on the node.
    waitUntil {
      onAllNodesWithContentDescription("Network request GET api.example.com/slow")
        .fetchSemanticsNodes()
        .isNotEmpty()
    }
    onNodeWithContentDescription("Network request GET api.example.com/slow").performClick()
    waitUntil {
      onAllNodesWithText("detail unavailable", substring = true).fetchSemanticsNodes().isNotEmpty()
    }

    // The summary header stays visible; the error is shown inline in the detail pane.
    onNodeWithContentDescription("Selected request detail").assertIsDisplayed()
    onNodeWithText("detail unavailable", substring = true).assertIsDisplayed()
  }
}

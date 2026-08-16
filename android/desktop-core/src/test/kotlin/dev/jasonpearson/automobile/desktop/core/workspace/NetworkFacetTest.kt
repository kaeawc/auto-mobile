package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.datasource.NetworkEndpointRow
import dev.jasonpearson.automobile.desktop.core.datasource.Result
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class NetworkFacetTest {

  private fun column() = DeviceColumn(deviceId = "d", name = "Pixel", platform = Platform.Android)

  private fun row(host: String, path: String, method: String = "GET") =
    NetworkEndpointRow(
      scheme = "https",
      host = host,
      path = path,
      method = method,
      type = "application/json",
      success = 3,
      errors = 1,
      p50 = 10,
      p95 = 20,
    )

  @Test
  fun `shows the empty state when the graph has no captured traffic`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        NetworkFacet(column = column(), loadNetworkGraph = { Result.Success(emptyList()) })
      }
    }
    waitForIdle()
    onNodeWithText("No network activity captured", substring = true).assertIsDisplayed()
  }

  @Test
  fun `renders a row per captured endpoint`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        NetworkFacet(
          column = column(),
          loadNetworkGraph = {
            Result.Success(listOf(row("api.example.com", "/users/{id}")))
          },
        )
      }
    }
    waitForIdle()
    onNodeWithText("api.example.com/users/{id}", substring = true).assertIsDisplayed()
  }

  @Test
  fun `surfaces a retryable error when the graph fails to load`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        NetworkFacet(
          column = column(),
          loadNetworkGraph = { Result.Error(RuntimeException("daemon down")) },
        )
      }
    }
    waitForIdle()
    onNodeWithText("daemon down", substring = true).assertIsDisplayed()
    onNodeWithContentDescription("Retry loading network graph").assertIsDisplayed()
  }

  @Test
  fun `retry re-invokes the loader and renders the recovered rows`() = runComposeUiTest {
    val attempts = AtomicInteger(0)
    setContent {
      MaterialTheme {
        NetworkFacet(
          column = column(),
          loadNetworkGraph = {
            if (attempts.getAndIncrement() == 0) Result.Error(RuntimeException("daemon down"))
            else Result.Success(listOf(row("api.example.com", "/health")))
          },
        )
      }
    }
    waitForIdle()
    onNodeWithText("daemon down", substring = true).assertIsDisplayed()

    onNodeWithContentDescription("Retry loading network graph").performClick()
    waitForIdle()

    onNodeWithText("api.example.com/health", substring = true).assertIsDisplayed()
  }
}

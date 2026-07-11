package dev.jasonpearson.automobile.desktop.core.screenshot

import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.desktop.core.components.ErrorCard
import dev.jasonpearson.automobile.desktop.core.components.SearchBar
import dev.jasonpearson.automobile.desktop.core.shell.StatusBarBadge
import org.junit.Test

/**
 * Screenshot baselines for representative desktop components, captured in both light and dark
 * Material themes. This is a starter set that proves the [screenshotTest] pattern; extend it with
 * more components and dashboard states as coverage grows.
 *
 * Record the baselines (on the reference OS / CI) with:
 * ```
 * ./gradlew -p android :desktop-core:test --tests '*ComponentScreenshotTest' -Dscreenshot.record=true
 * ```
 */
class ComponentScreenshotTest {

  /** Wraps content in a themed, fixed-width surface so captures are deterministic. */
  @Composable
  private fun ThemedSurface(dark: Boolean, content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (dark) darkColorScheme() else lightColorScheme()) {
      Surface(modifier = Modifier.width(360.dp)) {
        Surface(modifier = Modifier.padding(12.dp), content = content)
      }
    }
  }

  @Test
  fun errorCardLight() =
    screenshotTest("error_card_light") {
      ThemedSurface(dark = false) {
        ErrorCard(title = "Something went wrong", message = "Please try again later.")
      }
    }

  @Test
  fun errorCardDark() =
    screenshotTest("error_card_dark") {
      ThemedSurface(dark = true) {
        ErrorCard(title = "Something went wrong", message = "Please try again later.")
      }
    }

  @Test
  fun errorCardWithActions() =
    screenshotTest("error_card_with_actions") {
      ThemedSurface(dark = true) {
        ErrorCard(
          title = "Connection lost",
          message = "The daemon is unreachable.",
          onRetry = {},
          onDismiss = {},
        )
      }
    }

  @Test
  fun searchBarEmpty() =
    screenshotTest("search_bar_empty") {
      ThemedSurface(dark = true) { SearchBar(query = "", onQueryChange = {}) }
    }

  @Test
  fun searchBarWithQuery() =
    screenshotTest("search_bar_with_query") {
      ThemedSurface(dark = true) {
        SearchBar(
          query = "MainActivity",
          onQueryChange = {},
          showRegexToggle = true,
          isRegexEnabled = true,
          onRegexToggle = {},
        )
      }
    }

  @Test
  fun statusBarBadge() =
    screenshotTest("status_bar_badge") {
      ThemedSurface(dark = true) {
        StatusBarBadge(count = 12, label = "Crashes", color = Color(0xFFF28B82))
      }
    }
}

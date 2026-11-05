package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStream
import dev.jasonpearson.automobile.desktop.core.daemon.allocatingClientProvider
import dev.jasonpearson.automobile.desktop.core.di.LocalAutoMobileGraph
import dev.jasonpearson.automobile.desktop.core.navigation.DaemonEdgeNavigator
import dev.jasonpearson.automobile.desktop.core.navigation.EdgeNavigator
import dev.jasonpearson.automobile.desktop.core.navigation.NavigationDashboard
import dev.jasonpearson.automobile.desktop.core.navigation.NavigationDashboardOptions
import dev.jasonpearson.automobile.desktop.core.navigation.ScreenshotLoader

@Composable
internal fun NavigationFacetOptions.NavigationContent(
  memory: NavigationMemory,
  stream: ObservationStream?,
  clientProvider: () -> dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient,
  screenshotLoader: ScreenshotLoader,
  edgeNavigator: EdgeNavigator? = null,
) {
  val graph = LocalAutoMobileGraph.current
  with(memory) {
    when (val current = state) {
      NavigationFacetState.Loading -> NavigationFacetNote("Resolving navigation graph…")
      NavigationFacetState.NoApp ->
        NavigationFacetNote("Open an app on this device to build its navigation graph")
      NavigationFacetState.Empty ->
        NavigationFacetNote(
          "No navigation graph recorded for this app yet",
          "Interact with the app to record its navigation graph.",
        )
      is NavigationFacetState.ConnectionError ->
        if (current.manualRetry) {
          NavigationFacetError(
            message = current.message,
            retryContentDescription = "Retry resolving navigation graph",
          ) {
            val restartCollector = navigationCollectorFailed
            navigationCollectorFailed = false
            streamError = null
            if (restartCollector) collectorAttempt++ else stream?.requestNavigationGraph()
          }
        } else {
          NavigationFacetNote(current.message, "Reconnecting to the AutoMobile daemon…")
        }
      is NavigationFacetState.Error ->
        NavigationFacetError(
          message = current.message,
          retryContentDescription = "Retry loading navigation graph",
        ) {
          attempt++
        }
      is NavigationFacetState.Resolved ->
        NavigationDashboard(
          options =
            NavigationDashboardOptions(
              providedGraph = current.graph,
              providedCurrentScreen = currentScreen,
              clientProvider = clientProvider,
              settingsProvider = graph.settingsProvider,
              selectedAppId = foregroundAppId,
              screenshotLoader = screenshotLoader,
              streamOnly = true,
              // Stream build identity tightens provenance to device + package + version + content
              // hash.
              // No known key keeps the existing device+package fallback.
              activeContext = buildKeys.activeContext(current.appId),
              edgeNavigator = edgeNavigator,
              // The daemon records the traversal under the active build; pull it now so a
              // speculative edge reads as verified without waiting for the next push (#16953).
              onEdgeNavigated = { stream?.requestNavigationGraph() },
            ),
        )
    }
  }
}

/** Centered note for the facet's transient (loading) or empty states. */
@Composable
internal fun NavigationFacetNote(text: String, hint: String? = null) {
  Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
      Text(text, color = MaterialTheme.colorScheme.outline)
      hint?.let {
        Text(it, color = MaterialTheme.colorScheme.outline.copy(alpha = 0.7f))
      }
    }
  }
}

/**
 * Error state with a Retry affordance; [retryContentDescription] names what the retry re-attempts.
 */
@Composable
internal fun NavigationFacetError(
  message: String,
  retryContentDescription: String,
  onRetry: () -> Unit,
) {
  Column(
    Modifier.fillMaxSize(),
    verticalArrangement = Arrangement.Center,
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    Text(message, color = MaterialTheme.colorScheme.error)
    Text(
      "Retry",
      color = MaterialTheme.colorScheme.primary,
      modifier =
        Modifier.padding(top = 8.dp).clickable(onClick = onRetry).semantics {
          contentDescription = retryContentDescription
        },
    )
  }
}

/**
 * The pane's navigator for transition navigate actions (#16953):
 * [NavigationFacetOptions.edgeNavigator] when given, else a daemon navigator whose client allocates
 * the pane's device to the desktop session first, exactly as a pane's input does (#10730). Null
 * without an input allocation.
 */
@Composable
internal fun rememberEdgeNavigator(
  options: NavigationFacetOptions,
  clientProvider: () -> dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient,
): EdgeNavigator? {
  val latestSessionUuidProvider by rememberUpdatedState(options.sessionUuidProvider)
  val allocated =
    remember(clientProvider, options.inputAllocation) {
      options.inputAllocation?.let { allocation ->
        allocatingClientProvider(clientProvider, { allocation }) { latestSessionUuidProvider() }
          ?.let { DaemonEdgeNavigator(it, options.ioDispatcher) }
      }
    }
  return options.edgeNavigator ?: allocated
}

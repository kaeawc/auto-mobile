package dev.jasonpearson.automobile.desktop.core.navigation

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import dev.jasonpearson.automobile.desktop.core.daemon.McpConnectionException
import dev.jasonpearson.automobile.desktop.core.daemon.NavigationGraphStreamUpdate
import dev.jasonpearson.automobile.desktop.core.datasource.NavigationGraph
import dev.jasonpearson.automobile.desktop.core.datasource.Result
import dev.jasonpearson.automobile.desktop.core.di.LocalAutoMobileGraph
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.core.settings.SettingsProvider
import java.io.IOException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerializationException

private val LOG = LoggerFactory.getLogger("NavigationDashboard")

@Composable
internal fun ProvidedNavigationGraph(
  state: NavigationDashboardState,
  options: NavigationDashboardOptions,
) {
  LaunchedEffect(options.providedGraph, options.providedCurrentScreen) {
    if (options.providedGraph != null) {
      state.navigationGraph = options.providedGraph
      state.currentObservedScreen = options.providedCurrentScreen
      state.isLoading = false
      state.error = null
    }
  }
}

@Composable
internal fun FetchNavigationGraph(
  state: NavigationDashboardState,
  options: NavigationDashboardOptions,
  ioDispatcher: CoroutineDispatcher,
) {
  val graph = LocalAutoMobileGraph.current
  LaunchedEffect(
    options.dataSourceMode,
    options.clientProvider,
    options.selectedAppId,
    options.streamOnly,
    options.providedGraph,
  ) {
    if (options.providedGraph != null) return@LaunchedEffect
    if (options.streamOnly) {
      state.isLoading = false
      return@LaunchedEffect
    }
    LOG.info(
      "Loading navigation data with mode: ${options.dataSourceMode}, appId: ${options.selectedAppId}, clientProvider=${if (options.clientProvider != null) "present" else "null"}",
    )
    state.isLoading = true
    state.error = null
    withContext(ioDispatcher) {
      try {
        val dataSource =
          graph.dataSourceFactory.createNavigationDataSource(
            options.dataSourceMode,
            options.clientProvider,
            options.selectedAppId,
          )
        state.applyResult(dataSource.getNavigationGraph())
      } catch (error: McpConnectionException) {
        state.failed(error)
      } catch (error: IOException) {
        state.failed(error)
      } catch (error: SerializationException) {
        state.failed(error)
      }
    }
  }
}

private fun NavigationDashboardState.applyResult(result: Result<NavigationGraph>) {
  when (result) {
    is Result.Success -> {
      LOG.info(
        "Navigation data loaded: ${result.data.screens.size} screens, ${result.data.transitions.size} transitions",
      )
      navigationGraph = result.data
      isLoading = false
    }
    is Result.Error -> {
      LOG.warn("Failed to load navigation data: ${result.message}")
      error = result.message
      isLoading = false
    }
    Result.Loading -> Unit // Keep loading state.
  }
}

@Composable
internal fun StreamNavigationGraph(
  state: NavigationDashboardState,
  options: NavigationDashboardOptions,
  ioDispatcher: CoroutineDispatcher,
  mainDispatcher: CoroutineDispatcher,
) {
  val stream = options.observationStreamClient
  LaunchedEffect(stream, options.providedGraph) {
    if (options.providedGraph != null) return@LaunchedEffect
    if (stream != null) withContext(ioDispatcher) { stream.requestNavigationGraph() }
  }
  LaunchedEffect(stream, options.selectedAppId, options.providedGraph) {
    if (options.providedGraph != null || stream == null) return@LaunchedEffect
    LOG.info("Starting navigation updates collection from stream client")
    stream.navigationUpdates.collect { update ->
      if (options.selectedAppId == null || update.appId == options.selectedAppId) {
        LOG.info(
          "Received navigation update - appId=${update.appId}, nodes=${update.nodes.size}, edges=${update.edges.size}, currentScreen=${update.currentScreen}",
        )
        val newAppId = update.appId
        val appChanged =
          state.lastObservedAppId != null && newAppId != null && newAppId != state.lastObservedAppId
        if (appChanged) {
          LOG.info(
            "Foreground app changed: ${state.lastObservedAppId} -> $newAppId, requesting nav graph",
          )
          stream.requestNavigationGraph(newAppId)
        }
        withContext(mainDispatcher) {
          state.applyStreamUpdate(update, options.settingsProvider, appChanged)
        }
      }
    }
  }
}

private fun NavigationDashboardState.applyStreamUpdate(
  update: NavigationGraphStreamUpdate,
  settings: SettingsProvider,
  appChanged: Boolean,
) {
  if (appChanged) {
    fogModeEnabled = false
    settings.fogModeEnabled = false
    fitToViewTrigger++
  }
  lastObservedAppId = update.appId
  navigationGraph = convertStreamUpdateToGraph(update)
  currentObservedScreen = update.currentScreen
  isLoading = false
  error = null
}

/** Convert a navigation graph stream update to the NavigationGraph format used by the UI. */
private fun convertStreamUpdateToGraph(update: NavigationGraphStreamUpdate): NavigationGraph {
  val screens =
    update.nodes.map { node ->
      ScreenNode(
        id = node.id.toString(),
        name = node.screenName,
        type = "Screen", // Default type
        packageName = update.appId ?: "",
        transitionCount = node.visitCount,
        discoveredAt = 0L, // Not available from stream
        screenshotUri = node.screenshotPath,
      )
    }

  val transitions =
    update.edges.map { edge ->
      ScreenTransition(
        id = edge.id.toString(),
        fromScreen = edge.from,
        toScreen = edge.to,
        trigger = edge.toolName ?: "unknown",
        element = null, // Not available from stream
        avgLatencyMs = 0, // Not available from stream
        failureRate = 0f, // Not available from stream
        traversalCount = edge.traversalCount,
      )
    }

  return NavigationGraph(screens = screens, transitions = transitions)
}

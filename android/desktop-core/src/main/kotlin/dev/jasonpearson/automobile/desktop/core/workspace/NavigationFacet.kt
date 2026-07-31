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
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStream
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStreamClient
import dev.jasonpearson.automobile.desktop.core.datasource.NavigationDataSource
import dev.jasonpearson.automobile.desktop.core.datasource.NavigationGraph
import dev.jasonpearson.automobile.desktop.core.datasource.RealNavigationDataSource
import dev.jasonpearson.automobile.desktop.core.datasource.Result
import dev.jasonpearson.automobile.desktop.core.di.LocalAutoMobileGraph
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.core.navigation.NavigationDashboard
import dev.jasonpearson.automobile.desktop.core.navigation.NavigationScreenshotLoader
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private val LOG = LoggerFactory.getLogger("NavigationFacet")

private sealed interface NavigationFacetState {
  /** No foreground app resolved yet, or the app-scoped pull is in flight. */
  data object Loading : NavigationFacetState

  /**
   * The stream is connected but reports no app has navigated yet (fresh daemon / onboarding): the
   * `navigation_update`'s appId is null. Distinct from [Loading] ("haven't heard from the stream
   * yet") so the first-run case doesn't hang on an indefinite spinner.
   */
  data object NoApp : NavigationFacetState

  /** The resolved app has no recorded navigation graph. */
  data object Empty : NavigationFacetState

  /** The observation stream never connected (e.g. daemon socket unavailable); retryable. */
  data class ConnectionError(val message: String) : NavigationFacetState

  data class Error(val message: String) : NavigationFacetState

  data class Resolved(val graph: NavigationGraph) : NavigationFacetState
}

/**
 * Docked-facet body for [Tool.Navigation]. Navigation is **app-scoped**, not device-scoped (Phase C
 * of the nav-graph model, #4837): the daemon persists one graph per app, so this facet renders the
 * app-level graph for whichever app is in the foreground on the pane's device.
 *
 * Mechanism — **app-scoped pull** (the contamination-safe option from #4909). A per-device
 * [ObservationStream] is connected while the facet is shown (mirroring [LogsFacet]'s
 * connect/dispose lifecycle, keyed on [DeviceColumn.deviceId]) purely to (a) satisfy that
 * per-device lifecycle and (b) resolve which app is in the foreground on this pane's device (from
 * the stream's `appId`). The graph itself is then **pulled** by app id via a [NavigationDataSource]
 * (default [RealNavigationDataSource], which reads the daemon's app-keyed
 * `automobile:navigation/graph?appId=…` resource). This is a stable snapshot: two panes observing
 * the *same* app pull the same app-keyed graph and therefore render identical data (correct under
 * the app-level model), and a foreign app's broadcast can never overwrite a pane's rendered graph
 * the way the raw stream did (#4838).
 *
 * Known caveat (deferred to the `(app, build)` phase, #4837): `NavigationGraphStreamUpdate` carries
 * an `appId` but no `deviceId`, so when two panes run *different* apps a foreground-app update
 * broadcast for one device can be misattributed to the other pane. Full disambiguation needs the
 * deviceId/build discriminator that lands in a later phase; we do not block on it here.
 *
 * [observationStreamFactory] and [navigationDataSourceProvider] are injected so the whole
 * lifecycle + loading/empty/error/resolved behavior is testable with a
 * [dev.jasonpearson.automobile.desktop.core.daemon.FakeObservationStream] and a fake data source,
 * with no socket or live MCP daemon.
 */
@Composable
fun NavigationFacet(
  column: DeviceColumn,
  observationStreamFactory: (String) -> ObservationStream = { ObservationStreamClient() },
  navigationDataSourceProvider: ((String) -> NavigationDataSource)? = null,
) {
  val graph = LocalAutoMobileGraph.current

  // Bumped by the connection-error Retry to tear down and recreate the stream. The full automatic
  // reconnect-on-recovery (backoff, no user action) is the shared workspace-facet reconnect
  // lifecycle tracked in #4868 — deliberately not built here; a manual retry is enough for now.
  var streamAttempt by remember(column.deviceId) { mutableStateOf(0) }

  var stream by remember(column.deviceId) { mutableStateOf<ObservationStream?>(null) }
  DisposableEffect(column.deviceId, streamAttempt) {
    val connected =
      observationStreamFactory(column.deviceId).also { it.connect(deviceId = column.deviceId) }
    // Prompt the daemon to emit the current foreground app so we can resolve which app's graph to
    // pull; the emitted update carries the appId.
    connected.requestNavigationGraph()
    stream = connected
    onDispose {
      connected.dispose()
      stream = null
    }
  }

  // A throw surfaced by either stream-collection flow (socket read error, parse failure) below.
  // Compose does NOT isolate exceptions thrown inside a LaunchedEffect — an unguarded `collect`
  // that throws propagates to the Recomposer root and crashes the app. So both collectors funnel
  // any non-cancellation throw into this state, which the state-gating effect turns into a
  // retryable ConnectionError instead of a crash. Reset per stream attempt so Retry clears it.
  var streamError by remember(column.deviceId, streamAttempt) { mutableStateOf<String?>(null) }

  // Foreground app for THIS pane's device, resolved from the nav stream. Keyed on streamAttempt as
  // well as deviceId so a reconnect (Retry) DISCARDS the pre-outage app: otherwise a stream that
  // drops after resolving app A, while the user switches to app B, would immediately re-pull and
  // flash stale A on retry (and stay on A if B's first update carries no appId). On reconnect this
  // resets to null so the facet returns to Resolving/NoApp and re-resolves from the fresh stream.
  var foregroundAppId by remember(column.deviceId, streamAttempt) { mutableStateOf<String?>(null) }
  // The active screen reported alongside the resolved app. Carried into NavigationDashboard so the
  // canvas's Fog toggle + auto-focus (both gated on a non-null current screen) work under the
  // app-scoped-pull path, which otherwise bypasses the dashboard's own stream collector. Reset on
  // reconnect alongside foregroundAppId so it can't outlive the app it belonged to.
  var currentScreen by remember(column.deviceId, streamAttempt) { mutableStateOf<String?>(null) }
  // True once the connected stream has reported that no app has navigated yet (appId == null).
  // Distinguishes the onboarding "no app" case (-> NoApp) from "haven't heard yet" (-> Loading).
  var noNavigationApp by remember(column.deviceId, streamAttempt) { mutableStateOf(false) }
  LaunchedEffect(stream) {
    val current = stream ?: return@LaunchedEffect
    try {
      current.navigationUpdates.collect { update ->
        val appId = update.appId
        if (appId != null) {
          foregroundAppId = appId
          currentScreen = update.currentScreen
          noNavigationApp = false
        } else if (foregroundAppId == null) {
          // Stream says the current app is null and we've never resolved one — onboarding case.
          noNavigationApp = true
        }
      }
    } catch (c: CancellationException) {
      // Normal cancellation on dispose / device change — must propagate.
      throw c
    } catch (e: Exception) {
      LOG.warn("Navigation stream collection failed: ${e.message}", e)
      streamError = e.message ?: "Navigation stream error"
    }
  }

  // Mirror the stream's connection state so a socket that never connects surfaces a retryable
  // connection-error instead of an indefinite "Resolving…". Reset per stream attempt so a stale
  // Disconnected doesn't leak across a reconnect.
  var connectionState by
    remember(column.deviceId, streamAttempt) {
      mutableStateOf<ConnectionState>(ConnectionState.Connecting)
    }
  LaunchedEffect(stream) {
    val current = stream ?: return@LaunchedEffect
    try {
      current.connectionState.collect { connectionState = it }
    } catch (c: CancellationException) {
      throw c
    } catch (e: Exception) {
      LOG.warn("Connection-state collection failed: ${e.message}", e)
      streamError = e.message ?: "Connection-state stream error"
    }
  }

  val sourceProvider =
    navigationDataSourceProvider
      ?: { appId ->
        RealNavigationDataSource(clientProvider = { graph.autoMobileClient }, appId = appId)
      }

  var attempt by remember(column.deviceId) { mutableStateOf(0) }
  var state by
    remember(column.deviceId) { mutableStateOf<NavigationFacetState>(NavigationFacetState.Loading) }

  LaunchedEffect(
    column.deviceId,
    foregroundAppId,
    attempt,
    connectionState,
    streamError,
    noNavigationApp,
  ) {
    // A stream failure is retryable *regardless of whether an app already resolved*. Handling it
    // only when foregroundAppId == null would let a socket EOF after resolution
    // (Disconnected("Stream ended")) silently retain a dead stream and miss later foreground-app
    // changes. So surface the retryable ConnectionError on any Disconnected/Error (or a
    // mid-collect throw captured in streamError); Retry recreates the stream (streamAttempt) and
    // re-resolves. Automatic reconnect-on-recovery (backoff, no user action) is #4868 — not built
    // here. Note: transient Connecting/Reconnecting are NOT failures and fall through.
    val failureMessage =
      streamError
        ?: when (val cs = connectionState) {
          is ConnectionState.Disconnected -> cs.reason ?: "Not connected to the AutoMobile daemon"
          is ConnectionState.Error -> cs.message
          else -> null
        }
    if (failureMessage != null) {
      state = NavigationFacetState.ConnectionError(failureMessage)
      return@LaunchedEffect
    }

    val appId = foregroundAppId
    if (appId == null) {
      // Stream is healthy but no foreground app resolved yet. We resolve the appId *from* the
      // stream, so never pull with a null app id (that would surface the wrong/global graph). If
      // the stream has explicitly reported "no current app" show the NoApp guidance; otherwise
      // we simply haven't heard yet, so stay in Loading.
      state = if (noNavigationApp) NavigationFacetState.NoApp else NavigationFacetState.Loading
      return@LaunchedEffect
    }
    state = NavigationFacetState.Loading
    // Read off the UI thread: the resource read hits the daemon and would otherwise block
    // recomposition. Injected test data sources run inline (deterministic). The pull is wrapped so
    // a throwing data source becomes a retryable Error state rather than crashing the Recomposer.
    state =
      try {
        when (
          val result = withContext(Dispatchers.IO) { sourceProvider(appId).getNavigationGraph() }
        ) {
          is Result.Success ->
            if (result.data.screens.isEmpty()) NavigationFacetState.Empty
            else NavigationFacetState.Resolved(result.data)
          is Result.Error ->
            NavigationFacetState.Error(result.message ?: "Failed to load navigation graph")
          // A one-shot read resolves to Success/Error; treat a stray Loading as retryable.
          Result.Loading -> NavigationFacetState.Error("Navigation graph is still loading")
        }
      } catch (c: CancellationException) {
        throw c
      } catch (e: Exception) {
        LOG.warn("Navigation graph pull failed: ${e.message}", e)
        NavigationFacetState.Error(e.message ?: "Failed to load navigation graph")
      }
  }

  val clientProvider = remember { { graph.autoMobileClient } }
  // Remembered per device so its LRU cache survives facet toggles.
  val screenshotLoader =
    remember(column.deviceId) { NavigationScreenshotLoader(clientProvider = clientProvider) }

  when (val current = state) {
    NavigationFacetState.Loading -> NavigationFacetNote("Resolving navigation graph…")
    NavigationFacetState.NoApp ->
      NavigationFacetNote("Open an app on this device to build its navigation graph")
    NavigationFacetState.Empty ->
      NavigationFacetNote("No navigation graph recorded for this app yet")
    is NavigationFacetState.ConnectionError ->
      // Retry tears down and recreates the stream, re-attempting connect + appId resolution.
      NavigationFacetError(
        message = current.message,
        retryContentDescription = "Retry connecting to the AutoMobile daemon",
      ) {
        streamAttempt++
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
        providedGraph = current.graph,
        providedCurrentScreen = currentScreen,
        clientProvider = clientProvider,
        settingsProvider = graph.settingsProvider,
        selectedAppId = foregroundAppId,
        screenshotLoader = screenshotLoader,
        streamOnly = true,
      )
  }
}

/** Centered single-line note for the facet's transient (loading) or empty states. */
@Composable
private fun NavigationFacetNote(text: String) {
  Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
    Text(text, color = MaterialTheme.colorScheme.outline)
  }
}

/**
 * Error state with a Retry affordance; [retryContentDescription] names what the retry re-attempts.
 */
@Composable
private fun NavigationFacetError(
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

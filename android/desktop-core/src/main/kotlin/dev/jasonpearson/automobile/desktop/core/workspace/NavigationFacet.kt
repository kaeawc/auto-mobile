package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStream
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStreamClient
import dev.jasonpearson.automobile.desktop.core.datasource.NavigationDataSource
import dev.jasonpearson.automobile.desktop.core.datasource.NavigationGraph
import dev.jasonpearson.automobile.desktop.core.datasource.RealNavigationDataSource
import dev.jasonpearson.automobile.desktop.core.datasource.Result
import dev.jasonpearson.automobile.desktop.core.di.LocalAutoMobileGraph
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.core.navigation.DefaultNavigationScreenshotLoaderRegistry
import dev.jasonpearson.automobile.desktop.core.navigation.ScreenshotLoader
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private val LOG = LoggerFactory.getLogger("NavigationFacet")

/**
 * How long to wait, after connecting, for the daemon to deliver a navigation payload before giving
 * up. Backstops a "connected but silently no payload" daemon response (e.g. the on-demand export
 * throws and is swallowed to null — daemon-side fix tracked in #4918) so the facet doesn't sit on
 * "Resolving…" forever.
 */
private const val RESOLVE_TIMEOUT_MS = 10_000L

internal sealed interface NavigationFacetState {
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

  /** A stream failure; transport failures recover automatically, payload failures need a retry. */
  data class ConnectionError(val message: String, val manualRetry: Boolean = false) :
    NavigationFacetState

  data class Error(val message: String) : NavigationFacetState

  /**
   * A rendered graph, tagged with the [appId] it belongs to. The tag lets a live re-pull retain the
   * on-screen graph only when it's the SAME app (a generation refresh); an in-place app switch (A
   * -> B) must instead hide A's graph and show Loading until B's snapshot arrives.
   */
  data class Resolved(val appId: String, val graph: NavigationGraph) : NavigationFacetState
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
 * [observationStreamFactory], [backoffDelay], [socketAvailable], and [navigationDataSourceProvider]
 * are injected so reconnect and app-resolution behavior is testable with a
 * [dev.jasonpearson.automobile.desktop.core.daemon.FakeObservationStream] and a fake data source,
 * with no socket or live MCP daemon.
 */
@Composable
fun NavigationFacet(
  column: DeviceColumn,
  options: NavigationFacetOptions = NavigationFacetOptions(),
) {
  val graph = LocalAutoMobileGraph.current

  val observation =
    rememberReconnectingObservationState(
      ReconnectingObservationOptions(
        deviceId = column.deviceId,
        streamFactory = { options.observationStreamFactory(column.deviceId) },
        backoffDelay = options.backoffDelay,
        socketAvailable = options.socketAvailable,
      ),
    )
  val stream = observation.stream

  val memory = rememberNavigationMemory(column, stream, observation.connectionGeneration)
  with(memory) {
    return with(options) {

      // The helper retains one stream across reconnects. This local generation invalidates the
      // screenshot tokens whenever a previously connected stream loses its connection.

      // A manual retry is still useful for a connected stream that never delivers a payload, or for
      // a
      // collector that threw. Neither failure changes the connection state watched by the helper.

      // A throw surfaced by either stream-collection flow (socket read error, parse failure) below.
      // Compose does NOT isolate exceptions thrown inside a LaunchedEffect — an unguarded `collect`
      // that throws propagates to the Recomposer root and crashes the app. So both collectors
      // funnel
      // any non-cancellation throw into this state, which the state-gating effect turns into a
      // retryable ConnectionError instead of a crash. Manual Retry clears it.

      // Immutable tracker updates trigger recomposition when this device's active build changes.

      // Foreground app for THIS pane's device. The connection collector clears it on a drop, before
      // the same stream instance reconnects, so the pre-outage app cannot flash or be re-pulled.

      // The active screen reported alongside the resolved app. Carried into NavigationDashboard so
      // the
      // canvas's Fog toggle + auto-focus (both gated on a non-null current screen) work under the
      // app-scoped-pull path, which otherwise bypasses the dashboard's own stream collector. Reset
      // on
      // reconnect alongside foregroundAppId so it can't outlive the app it belonged to.

      // True once the connected stream has reported that no app has navigated yet (appId == null).
      // Distinguishes the onboarding "no app" case (-> NoApp) from "haven't heard yet" (->
      // Loading).

      // Incremented on every navigation_update carrying an app so the app-scoped pull re-runs even
      // when
      // foregroundAppId is unchanged — otherwise a same-app update (app A discovers a new
      // screen/transition) would only re-assign the identical appId and the graph would never grow
      // live until retry/app-switch/reopen. Keyed into the pull effect below alongside appId.

      CollectNavigation(stream)

      CollectBuildContext(stream)

      // Mirror the stream's connection state and reset app resolution on the first loss of each
      // healthy connection. The helper's generation also catches a reconnect whose intermediate
      // drop
      // was conflated away by StateFlow. Do not restart the navigation collector on this
      // generation:
      // its SharedFlow replays the last payload, which could restore the stale pre-outage app.

      val latestConnectionGeneration = rememberUpdatedState(observation.connectionGeneration)
      CollectConnection(memory, stream, latestConnectionGeneration)

      // Resolution-timeout backstop: if the socket is Connected but no navigation payload resolves
      // within resolveTimeoutMs (no appId, no "no app" signal, no failure), give up and surface a
      // retryable ConnectionError instead of sitting on "Resolving…" forever. This covers any
      // "connected but silently no payload" cause; the specific daemon bug (on-demand export throws
      // and is swallowed to null) is tracked as a daemon-side fix in #4918. The effect is cancelled
      // (and thus never false-fires) the moment an app resolves, the stream reports "no app",
      // disconnects/errors, or app resolution resets — all of which change its keys.
      LaunchedEffect(stream, connectionState, foregroundAppId, noNavigationApp, streamError) {
        if (streamError != null) return@LaunchedEffect
        if (foregroundAppId != null || noNavigationApp) return@LaunchedEffect
        if (connectionState !is ConnectionState.Connected) return@LaunchedEffect
        resolveTimeout()
        // Still unresolved after the window (any resolution would have cancelled this effect).
        streamError = "No navigation data received from the daemon"
      }

      // Foreground-app-change fog reset for the provided-graph path. NavigationDashboard's stream
      // collector disables fog on every A -> B foreground switch, but the provided-graph path
      // bypasses
      // that collector; and because the switch remounts the dashboard via the Loading transition,
      // B's
      // fresh dashboard would otherwise read the persisted fog setting and inherit A's fog focus.
      // Reset the persisted setting here, where the switch is observed, so B starts with fog
      // disabled
      // (full graph). First resolution (null -> A) keeps A's persisted preference.

      LaunchedEffect(foregroundAppId) {
        val app = foregroundAppId ?: return@LaunchedEffect
        val previous = fogResetApp
        if (previous != null && previous != app) {
          graph.settingsProvider.fogModeEnabled = false
        }
        fogResetApp = app
      }

      val sourceProvider =
        navigationDataSourceProvider
          ?: { appId ->
            RealNavigationDataSource(clientProvider = { graph.autoMobileClient }, appId = appId)
          }

      // Per-screen screenshot-liveness tokens for the resolved app (#5088). Reset when the app
      // changes
      // (a fresh app's nodes start unversioned). Bumped for the screen the device just navigated to
      // on
      // a same-app refresh — the node the daemon re-captured a screenshot for — then stamped onto
      // the
      // pulled graph so the canvas drops that node's stale cached thumbnail and re-fetches. Read
      // and
      // written only from the pull effect below, which runs sequentially on the composition thread,
      // so
      // a plain map needs no synchronization.
      val screenshotVersions =
        remember(column.deviceId, resetGeneration, foregroundAppId) { mutableMapOf<String, Int>() }

      PullNavigation(memory, column, sourceProvider, screenshotVersions)

      val clientProvider = remember { { graph.autoMobileClient } }
      // Resolve the loader from a scope that outlives this facet's composition (a session-scoped
      // registry by default) so its LRU cache survives facet open/close toggles — a body-scoped
      // `remember` here would drop the cache every time the facet leaves composition. The default
      // provider is itself remembered so its identity is stable across recompositions, letting the
      // loader `remember` key on it (re-resolving only on an actual provider swap or device change)
      // without re-invoking it on every recomposition.
      val loaderProvider =
        screenshotLoaderProvider
          ?: remember(clientProvider) {
            { deviceId: String ->
              DefaultNavigationScreenshotLoaderRegistry.forDevice(deviceId, clientProvider)
            }
          }
      val screenshotLoader =
        remember(column.deviceId, loaderProvider) { loaderProvider(column.deviceId) }

      NavigationContent(memory, stream, clientProvider, screenshotLoader)
    }
  }
}

/**
 * Stamp each node's accumulated screenshot-liveness token (#5088) onto a freshly pulled [graph].
 * [versions] maps screen name -> the number of re-captures observed for that node this session; a
 * node absent from it keeps version 0. Only nodes the daemon actually re-captured therefore change
 * key, so the canvas drops and re-fetches exactly those thumbnails rather than the whole graph.
 * Returns [graph] unchanged when nothing has been re-captured yet (the common first-pull case).
 */
internal fun stampScreenshotVersions(
  graph: NavigationGraph,
  versions: Map<String, Int>,
): NavigationGraph =
  if (versions.isEmpty()) {
    graph
  } else {
    graph.copy(screens = graph.screens.map { it.copy(screenshotVersion = versions[it.name] ?: 0) })
  }

data class NavigationFacetOptions(
  val sessionUuidProvider: () -> String? = { null },
  val observationStreamFactory: (String) -> ObservationStream = {
    ObservationStreamClient(sessionUuidProvider = sessionUuidProvider)
  },
  val navigationDataSourceProvider: ((String) -> NavigationDataSource)? = null,
  val backoffDelay: suspend (attempt: Int) -> Unit = { attempt ->
    delay(reconnectBackoffMs(attempt))
  },
  val socketAvailable: () -> Boolean = { ObservationStreamClient.socketExists() },
  val resolveTimeout: suspend () -> Unit = { delay(RESOLVE_TIMEOUT_MS) },
  val connectionStateCollectorGate: suspend (ConnectionState) -> Unit = {},
  val screenshotLoaderProvider: ((String) -> ScreenshotLoader)? = null,
  val ioDispatcher: kotlinx.coroutines.CoroutineDispatcher = Dispatchers.IO,
)

internal data class NavigationMemory(
  private val attemptState: androidx.compose.runtime.MutableState<Int>,
  private val stateState: androidx.compose.runtime.MutableState<NavigationFacetState>,
  private val resetGenerationState: androidx.compose.runtime.MutableState<Int>,
  private val collectorAttemptState: androidx.compose.runtime.MutableState<Int>,
  private val navigationCollectorFailedState: androidx.compose.runtime.MutableState<Boolean>,
  private val streamErrorState: androidx.compose.runtime.MutableState<String?>,
  private val buildKeysState: androidx.compose.runtime.MutableState<NavigationBuildKeyTracker>,
  private val foregroundAppIdState: androidx.compose.runtime.MutableState<String?>,
  private val currentScreenState: androidx.compose.runtime.MutableState<String?>,
  private val noNavigationAppState: androidx.compose.runtime.MutableState<Boolean>,
  private val updateGenerationState: androidx.compose.runtime.MutableState<Int>,
  private val connectionStateState: androidx.compose.runtime.MutableState<ConnectionState>,
  private val wasConnectedState: androidx.compose.runtime.MutableState<Boolean>,
  private val dropHandledState: androidx.compose.runtime.MutableState<Boolean>,
  private val observedConnectionGenerationState: androidx.compose.runtime.MutableState<Int>,
  private val fogResetAppState: androidx.compose.runtime.MutableState<String?>,
) {
  var attempt by attemptState
  var state by stateState
  var resetGeneration by resetGenerationState
  var collectorAttempt by collectorAttemptState
  var navigationCollectorFailed by navigationCollectorFailedState
  var streamError by streamErrorState
  var buildKeys by buildKeysState
  var foregroundAppId by foregroundAppIdState
  var currentScreen by currentScreenState
  var noNavigationApp by noNavigationAppState
  var updateGeneration by updateGenerationState
  var connectionState by connectionStateState
  var wasConnected by wasConnectedState
  var dropHandled by dropHandledState
  var observedConnectionGeneration by observedConnectionGenerationState
  var fogResetApp by fogResetAppState
}

@Composable
private fun rememberNavigationMemory(
  column: DeviceColumn,
  stream: ObservationStream?,
  connectionGeneration: Int,
): NavigationMemory {
  val attemptState = remember(column.deviceId) { mutableStateOf(0) }
  val stateState =
    remember(column.deviceId) {
      mutableStateOf<NavigationFacetState>(NavigationFacetState.Loading)
    }
  val resetGenerationState = remember(column.deviceId) { mutableStateOf(0) }
  val collectorAttemptState = remember(column.deviceId) { mutableStateOf(0) }
  val navigationCollectorFailedState = remember(column.deviceId) { mutableStateOf(false) }
  val streamErrorState = remember(column.deviceId) { mutableStateOf<String?>(null) }
  val buildKeysState =
    remember(column.deviceId, stream) {
      mutableStateOf(NavigationBuildKeyTracker(column.deviceId))
    }
  val foregroundAppIdState = remember(column.deviceId) { mutableStateOf<String?>(null) }
  val currentScreenState = remember(column.deviceId) { mutableStateOf<String?>(null) }
  val noNavigationAppState = remember(column.deviceId) { mutableStateOf(false) }
  val updateGenerationState = remember(column.deviceId) { mutableStateOf(0) }
  val connectionStateState =
    remember(column.deviceId) {
      mutableStateOf<ConnectionState>(ConnectionState.Connecting)
    }
  val wasConnectedState = remember(stream, collectorAttemptState.value) { mutableStateOf(false) }
  val dropHandledState = remember(stream, collectorAttemptState.value) { mutableStateOf(false) }
  val observedConnectionGenerationState = remember(stream) { mutableStateOf(connectionGeneration) }
  val fogResetAppState = remember(column.deviceId) { mutableStateOf<String?>(null) }
  return NavigationMemory(
    attemptState,
    stateState,
    resetGenerationState,
    collectorAttemptState,
    navigationCollectorFailedState,
    streamErrorState,
    buildKeysState,
    foregroundAppIdState,
    currentScreenState,
    noNavigationAppState,
    updateGenerationState,
    connectionStateState,
    wasConnectedState,
    dropHandledState,
    observedConnectionGenerationState,
    fogResetAppState,
  )
}

@Composable
private fun NavigationMemory.CollectNavigation(stream: ObservationStream?) {
  LaunchedEffect(stream, collectorAttempt) {
    val current = stream ?: return@LaunchedEffect
    try {
      current.navigationUpdates.collect { update ->
        // An update queued during an outage belongs to the old connection, not the new app.
        if (current.connectionState.value !is ConnectionState.Connected) return@collect
        val appId = update.appId
        if (appId != null) {
          foregroundAppId = appId
          currentScreen = update.currentScreen
          noNavigationApp = false
          // Force a re-pull of the app-scoped snapshot for this update (see updateGeneration).
          updateGeneration++
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
      navigationCollectorFailed = true
      streamError = e.message ?: "Navigation stream error"
    }
  }
}

@Composable
private fun NavigationMemory.CollectBuildContext(stream: ObservationStream?) {
  LaunchedEffect(stream, collectorAttempt) {
    val current = stream ?: return@LaunchedEffect
    try {
      coroutineScope {
        launch {
          current.buildContextUpdates.collect { update ->
            if (current.connectionState.value is ConnectionState.Connected) {
              buildKeys = buildKeys.updated(update)
            }
          }
        }
        launch {
          current.deviceEvents.collect { event ->
            buildKeys =
              buildKeys.onDeviceEvent(event, current.buildContextUpdates.replayCache.lastOrNull())
          }
        }
      }
    } catch (c: CancellationException) {
      throw c
    } catch (e: Exception) {
      LOG.warn("Navigation build context collection failed: ${e.message}", e)
      navigationCollectorFailed = true
      streamError = e.message ?: "Navigation build context stream error"
    }
  }
}

@Composable
private fun NavigationFacetOptions.CollectConnection(
  memory: NavigationMemory,
  stream: ObservationStream?,
  latestConnectionGeneration: androidx.compose.runtime.State<Int>,
) {
  with(memory) {
    LaunchedEffect(stream, collectorAttempt) {
      val current = stream ?: return@LaunchedEffect

      try {
        coroutineScope {
          launch {
            snapshotFlow { latestConnectionGeneration.value }
              .collect { generation ->
                if (observedConnectionGeneration != generation) {
                  if (dropHandled) {
                    // The connection collector already cleared the old app for this outage.
                    dropHandled = false
                  } else if (wasConnected) {
                    clearOldApp(current)
                    // A fast drop and reconnect can leave StateFlow value-equal to the prior
                    // Connected state, so the connection collector has no new value to request
                    // from.
                    if (current.connectionState.value is ConnectionState.Connected) {
                      current.requestNavigationGraph()
                    }
                  }
                  observedConnectionGeneration = generation
                }
              }
          }
          current.connectionState.collect { next ->
            connectionStateCollectorGate(next)
            applyConnectionState(current, next)
          }
        }
      } catch (c: CancellationException) {
        throw c
      } catch (e: Exception) {
        LOG.warn("Connection-state collection failed: ${e.message}", e)
        streamError = e.message ?: "Connection-state stream error"
      }
    }
  }
}

private fun NavigationMemory.clearOldApp(current: ObservationStream) {

  buildKeys = buildKeys.reset(current.buildContextUpdates.replayCache.lastOrNull())
  foregroundAppId = null
  currentScreen = null
  noNavigationApp = false
  updateGeneration = 0
  resetGeneration++
  state = NavigationFacetState.Loading
}

@Composable
private fun NavigationFacetOptions.PullNavigation(
  memory: NavigationMemory,
  column: DeviceColumn,
  sourceProvider: (String) -> NavigationDataSource,
  screenshotVersions: MutableMap<String, Int>,
) {
  with(memory) {
    LaunchedEffect(
      column.deviceId,
      foregroundAppId,
      attempt,
      connectionState,
      streamError,
      noNavigationApp,
      updateGeneration,
      resetGeneration,
    ) {
      // A stream failure is retryable *regardless of whether an app already resolved*. Handling it
      // only when foregroundAppId == null would let a socket EOF after resolution
      // (Disconnected("Stream ended")) silently retain a dead stream and miss later foreground-app
      // changes. So surface the retryable ConnectionError on any Disconnected/Error (or a
      // mid-collect throw captured in streamError). The shared lifecycle reconnects transport
      // failures automatically; transient Connecting/Reconnecting are not failures.
      val appId = appIdForPull() ?: return@LaunchedEffect
      // Retain the on-screen graph during a pull ONLY for a same-app refresh (a new
      // updateGeneration for the already-displayed app): the graph then grows in place rather than
      // blanking on every navigation step. For the FIRST pull of an app OR an in-place app switch
      // (A -> B, appId changed) we must hide the old graph and show Loading until the new snapshot
      // arrives — otherwise B would render stale A while getNavigationGraph(B) runs. A superseded
      // in-flight pull is cancelled by LaunchedEffect when the keys change (its
      // CancellationException
      // propagates, so it never writes stale state).
      val displayed = state
      val sameAppRefresh = displayed is NavigationFacetState.Resolved && displayed.appId == appId
      if (!sameAppRefresh) {
        state = NavigationFacetState.Loading
      }
      // Read off the UI thread: the resource read hits the daemon and would otherwise block
      // recomposition. Injected test data sources run inline (deterministic). The pull is wrapped
      // so
      // a throwing data source becomes a retryable Error state rather than crashing the Recomposer.
      state =
        try {
          when (
            val result = withContext(ioDispatcher) { sourceProvider(appId).getNavigationGraph() }
          ) {
            is Result.Success ->
              resolvedNavigationGraph(appId, result.data, sameAppRefresh, screenshotVersions)
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
  }
}

private fun NavigationMemory.applyConnectionState(
  current: ObservationStream,
  next: ConnectionState,
) {
  if (next !is ConnectionState.Connected) {
    if (wasConnected) clearOldApp(current)
    // A failed first connect is also an observed drop: its later successful
    // connection must not clear a fresh app update a second time.
    if (wasConnected || next is ConnectionState.Disconnected || next is ConnectionState.Error) {
      dropHandled = true
    }
  }
  if (next is ConnectionState.Connected && !wasConnected) {
    // Every new connection needs a fresh foreground-app payload, including after EOF.
    current.requestNavigationGraph()
  }
  wasConnected = next is ConnectionState.Connected
  connectionState = next
}

private fun NavigationMemory.appIdForPull(): String? {
  val failureMessage =
    streamError
      ?: when (val cs = connectionState) {
        is ConnectionState.Disconnected -> cs.reason ?: "Not connected to the AutoMobile daemon"
        is ConnectionState.Error -> cs.message
        else -> null
      }
  if (failureMessage != null) {
    state = NavigationFacetState.ConnectionError(failureMessage, manualRetry = streamError != null)
    return null
  }

  val appId = foregroundAppId
  if (appId == null) {
    // Stream is healthy but no foreground app resolved yet. We resolve the appId *from* the
    // stream, so never pull with a null app id (that would surface the wrong/global graph). If
    // the stream has explicitly reported "no current app" show the NoApp guidance; otherwise
    // we simply haven't heard yet, so stay in Loading.
    state = if (noNavigationApp) NavigationFacetState.NoApp else NavigationFacetState.Loading
    return null
  }

  return appId
}

private fun NavigationMemory.resolvedNavigationGraph(
  appId: String,
  data: NavigationGraph,
  sameAppRefresh: Boolean,
  screenshotVersions: MutableMap<String, Int>,
): NavigationFacetState {
  return if (data.screens.isEmpty()) NavigationFacetState.Empty
  else {
    // A live same-app refresh means the device just navigated; the daemon re-captured a
    // screenshot for the destination screen under its existing stable URI. Bump that
    // node's liveness token so the canvas invalidates its cached thumbnail (#5088). The
    // first pull of an app (sameAppRefresh == false) carries no re-capture, so its
    // nodes
    // keep version 0 and load normally.
    if (sameAppRefresh) {
      val recaptured = currentScreen
      if (recaptured != null) {
        screenshotVersions[recaptured] = (screenshotVersions[recaptured] ?: 0) + 1
      }
    }
    NavigationFacetState.Resolved(
      appId,
      stampScreenshotVersions(data, screenshotVersions),
    )
  }
}

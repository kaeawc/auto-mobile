package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.daemon.DaemonBootstrap
import dev.jasonpearson.automobile.desktop.core.daemon.DesktopDaemonSession
import dev.jasonpearson.automobile.desktop.core.daemon.DesktopDaemonSessionBinding
import dev.jasonpearson.automobile.desktop.core.daemon.DesktopDaemonSessionState
import dev.jasonpearson.automobile.desktop.core.daemon.FailuresPushSocketClient
import dev.jasonpearson.automobile.desktop.core.daemon.FailuresPushSocketOptions
import dev.jasonpearson.automobile.desktop.core.daemon.FailuresRetryDelay
import dev.jasonpearson.automobile.desktop.core.daemon.FakeObservationStream
import dev.jasonpearson.automobile.desktop.core.daemon.FakeTelemetryPushClient
import dev.jasonpearson.automobile.desktop.core.daemon.McpDaemonClient
import dev.jasonpearson.automobile.desktop.core.daemon.RecordingDaemonTransport
import dev.jasonpearson.automobile.desktop.core.daemon.rememberDesktopDaemonSession
import dev.jasonpearson.automobile.desktop.core.daemon.rememberPaneSessionUuidProvider
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import dev.jasonpearson.automobile.desktop.core.datasource.DefaultDataSourceFactory
import dev.jasonpearson.automobile.desktop.core.di.AutoMobileGraphProvider
import dev.jasonpearson.automobile.desktop.core.di.LocalAutoMobileGraph
import dev.jasonpearson.automobile.desktop.core.platform.AppVersion
import dev.jasonpearson.automobile.desktop.core.platform.AppVersionProvider
import dev.jasonpearson.automobile.desktop.core.settings.FakeSettingsProvider
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient
import dev.jasonpearson.automobile.desktop.core.update.FakeUpdateController
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.awaitCancellation

/**
 * #10231: the app root recomposes on every workspace state change (a pane-divider drag delta, a
 * focus change, a tool toggle). The session provider handed to the Logs, Performance and Failures
 * facets and the focused pane's control stream must not change identity on those, or each of them
 * reconnects its socket. Drives the real [rememberDesktopDaemonSession] over the in-memory
 * transport under virtual time, with counting client factories in place of sockets.
 */
@OptIn(ExperimentalTestApi::class)
class PaneSessionProviderStabilityTest {
  private val pixel = DesktopDaemonSessionBinding("dev-1", "android")
  private val pixelFold = DesktopDaemonSessionBinding("dev-2", "android")

  private class Counts {
    var logs = 0
    var performance = 0
    var failures = 0
    var control = 0

    fun snapshot() = listOf(logs, performance, failures, control)
  }

  private class Root(
    val transport: RecordingDaemonTransport = RecordingDaemonTransport(),
    val binding: MutableState<DesktopDaemonSessionBinding?>,
    val device: MutableState<String>,
    /** Stands in for any root state the workspace changes without touching the session. */
    val unrelatedRootState: MutableState<Int> = mutableIntStateOf(0),
    val counts: Counts = Counts(),
  )

  @Test
  fun `root recomposition with unchanged inputs reconnects nothing`() = runComposeUiTest {
    val root = startedRoot()
    assertEquals(listOf(1, 1, 1, 1), root.counts.snapshot())

    repeat(5) { recomposeRoot(root) }

    assertEquals(listOf(1, 1, 1, 1), root.counts.snapshot())
  }

  @Test
  fun `a device change reconnects only the device-scoped streams, once`() = runComposeUiTest {
    val root = startedRoot()

    root.binding.value = pixelFold
    root.device.value = "dev-2"
    mainClock.advanceTimeByFrame()
    repeat(3) { recomposeRoot(root) }

    // Logs, Performance and the control stream are per-device; the Failures push is global.
    assertEquals(listOf(2, 2, 1, 2), root.counts.snapshot())
  }

  @Test
  fun `a lapsed session that re-registers reconnects each consumer exactly once`() =
    runComposeUiTest {
      val root = startedRoot()

      // Daemon restart: the heartbeat is refused and the re-bind is refused once, so the session
      // is unregistered for one tick, then re-registers.
      root.transport.failNext("daemon/heartbeat")
      root.transport.failNext("tools/call:setActiveDevice")
      tick()
      assertEquals(listOf(1, 1, 1, 1), root.counts.snapshot())
      tick()
      repeat(3) { recomposeRoot(root) }

      assertEquals(listOf(2, 2, 2, 2), root.counts.snapshot())
    }

  private fun ComposeUiTest.startedRoot(): Root {
    val root = Root(binding = mutableStateOf(pixel), device = mutableStateOf("dev-1"))
    val graph = fakeGraph()
    setContent {
      CompositionLocalProvider(LocalAutoMobileGraph provides graph) {
        MaterialTheme { rootContent(root) }
      }
    }
    mainClock.autoAdvance = false
    mainClock.advanceTimeByFrame()
    // The first frame binds the device, registering the session; the next composes the facets.
    mainClock.advanceTimeByFrame()
    return root
  }

  private fun ComposeUiTest.recomposeRoot(root: Root) {
    root.unrelatedRootState.value++
    mainClock.advanceTimeByFrame()
  }

  private fun ComposeUiTest.tick() {
    mainClock.advanceTimeBy(HEARTBEAT_MS)
    mainClock.advanceTimeByFrame()
  }

  @Composable
  private fun rootContent(root: Root) {
    val state = rememberSession(root)
    // Read in the same scope as the session hook, like the real root's workspaceState read, so the
    // hook returns a fresh state object on every unrelated change.
    root.unrelatedRootState.value
    // The panes sit behind their own restartable scope, like the real WorkspaceShell: a
    // non-restartable composable such as rememberWorkspaceDeviceControl invalidates its enclosing
    // scope, which must not be the root that rebuilds the provider.
    panes(root, providerFor(state))
  }

  @Composable
  private fun panes(root: Root, provider: () -> String?) {
    val column =
      DeviceColumn(deviceId = root.device.value, name = "Pixel", platform = Platform.Android)
    LogsFacet(
      column = column,
      sessionUuidProvider = provider,
      telemetryClientFactory = {
        root.counts.logs++
        FakeTelemetryPushClient()
      },
    )
    PerformanceFacet(
      column = column,
      sessionUuidProvider = provider,
      observationStreamFactory = {
        root.counts.performance++
        FakeObservationStream()
      },
      backoffDelay = { awaitCancellation() },
      socketAvailable = { true },
    )
    FailuresFacet(
      column = column,
      sessionUuidProvider = provider,
      dataSourceMode = DataSourceMode.Real,
      pushClientFactory = { sessionUuidProvider ->
        root.counts.failures++
        idleFailuresClient(sessionUuidProvider)
      },
    )
    rememberWorkspaceDeviceControl(
      column = column,
      clientProvider = { null },
      enabled = true,
      sessionUuidProvider = provider,
      streamFactory = {
        root.counts.control++
        FakeObservationStream()
      },
    )
  }

  @Composable
  private fun rememberSession(root: Root): DesktopDaemonSessionState =
    rememberDesktopDaemonSession(
      socketPath = "in-memory",
      binding = root.binding,
      sessionFactory = {
        DesktopDaemonSession(McpDaemonClient(root.transport, sessionUuid = "desktop-session"))
      },
      ioDispatcher = Dispatchers.Unconfined,
    )

  @Composable
  private fun providerFor(state: DesktopDaemonSessionState): () -> String? =
    rememberPaneSessionUuidProvider(state)

  private fun idleFailuresClient(sessionUuidProvider: (() -> String?)?) =
    FailuresPushSocketClient(
      openSocket = { error("the idle failures client never opens a socket") },
      retryDelay = FailuresRetryDelay { awaitCancellation() },
      scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined),
      socketAvailable = { false },
      options =
        FailuresPushSocketOptions(
          sessionUuidProvider = sessionUuidProvider,
          socketPath = { "fake-failures.sock" },
        ),
    )

  private fun fakeGraph(): AutoMobileGraphProvider {
    val client = FakeAutoMobileClient()
    return object : AutoMobileGraphProvider {
      override val autoMobileClient = client
      override val daemonBootstrap = DaemonBootstrap.inactive()
      override val settingsProvider = FakeSettingsProvider()
      override val dataSourceFactory = DefaultDataSourceFactory(client)
      override val updateController = FakeUpdateController()
      override val appVersionProvider = AppVersionProvider { AppVersion.Dev }
    }
  }

  private companion object {
    const val HEARTBEAT_MS = 2_000L
  }
}

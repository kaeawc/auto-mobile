package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.DaemonBootstrap
import dev.jasonpearson.automobile.desktop.core.daemon.FakeObservationStream
import dev.jasonpearson.automobile.desktop.core.daemon.PerformanceStreamUpdate
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceFactory
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import dev.jasonpearson.automobile.desktop.core.datasource.DefaultDataSourceFactory
import dev.jasonpearson.automobile.desktop.core.datasource.PerformanceDataSource
import dev.jasonpearson.automobile.desktop.core.datasource.Result
import dev.jasonpearson.automobile.desktop.core.di.AutoMobileGraphProvider
import dev.jasonpearson.automobile.desktop.core.di.LocalAutoMobileGraph
import dev.jasonpearson.automobile.desktop.core.performance.PerformanceRun
import dev.jasonpearson.automobile.desktop.core.platform.AppVersion
import dev.jasonpearson.automobile.desktop.core.platform.AppVersionProvider
import dev.jasonpearson.automobile.desktop.core.settings.FakeSettingsProvider
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient
import dev.jasonpearson.automobile.desktop.core.update.FakeUpdateController
import java.util.Collections
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Each Performance pane loads its own device's audit history, once per device epoch. */
@OptIn(ExperimentalTestApi::class)
class PerformanceFacetEpochTest {

  /** Device ids of every audit-history load, in order. */
  private val loads = Collections.synchronizedList(mutableListOf<String?>())

  private fun recordingGraph(): AutoMobileGraphProvider {
    val client = FakeAutoMobileClient()
    val defaults = DefaultDataSourceFactory(client)
    val factory =
      object : DataSourceFactory by defaults {
        override fun createPerformanceDataSource(
          mode: DataSourceMode,
          clientProvider: (() -> AutoMobileClient)?,
          deviceId: String?,
        ): PerformanceDataSource =
          object : PerformanceDataSource {
            override suspend fun getPerformanceRun(): Result<PerformanceRun> {
              loads += deviceId
              return Result.Error(IllegalStateException("no audit history for $deviceId"))
            }
          }
      }
    return object : AutoMobileGraphProvider {
      override val autoMobileClient = client
      override val daemonBootstrap = DaemonBootstrap.inactive()
      override val settingsProvider = FakeSettingsProvider()
      override val dataSourceFactory = factory
      override val updateController = FakeUpdateController()
      override val appVersionProvider = AppVersionProvider { AppVersion.Dev }
    }
  }

  private fun column(deviceId: String, epoch: String) =
    DeviceColumn(
      deviceId = deviceId,
      name = deviceId,
      platform = Platform.Android,
      deviceSessionUuid = epoch,
    )

  private fun perfUpdate(deviceId: String) =
    PerformanceStreamUpdate(
      deviceId = deviceId,
      timestamp = 1_000L,
      fps = 30f,
      frameTimeMs = 16f,
      jankFrames = 0,
      droppedFrames = 0,
      memoryUsageMb = 100f,
      cpuUsagePercent = 10f,
      touchLatencyMs = null,
      timeToInteractiveMs = null,
      screenName = null,
      isResponsive = true,
      recompositionCount = null,
      recompositionRate = null,
    )

  private fun loadsFor(deviceId: String) = synchronized(loads) { loads.count { it == deviceId } }

  @Test
  fun `a new epoch reloads only its own pane's history and drops its live run`() =
    runComposeUiTest {
      val graph = recordingGraph()
      val epochA = mutableStateOf("epoch-a1")
      val streams = mutableMapOf<String, MutableList<FakeObservationStream>>()
      fun streamFor(deviceId: String) =
        FakeObservationStream().also { streams.getOrPut(deviceId) { mutableListOf() } += it }
      setContent {
        CompositionLocalProvider(LocalAutoMobileGraph provides graph) {
          MaterialTheme {
            Column {
              PerformanceFacet(
                column = column("device-A", epochA.value),
                observationStreamFactory = ::streamFor,
                backoffDelay = {},
                socketAvailable = { true },
              )
              PerformanceFacet(
                column = column("device-B", "epoch-b1"),
                observationStreamFactory = ::streamFor,
                backoffDelay = {},
                socketAvailable = { true },
              )
            }
          }
        }
      }
      waitUntil { loadsFor("device-A") >= 1 && loadsFor("device-B") >= 1 }
      waitForIdle()
      // Each pane reads only its own device; connecting may refresh it, so count from here.
      val loadsA = loadsFor("device-A")
      val loadsB = loadsFor("device-B")
      assertTrue("no unscoped history read", synchronized(loads) { null !in loads })

      runOnIdle { streams.getValue("device-A").last().emitPerformance(perfUpdate("device-A")) }
      onNodeWithText("Frame Rate").assertIsDisplayed()

      runOnIdle { epochA.value = "epoch-a2" }

      waitUntil { loadsFor("device-A") > loadsA }
      waitForIdle()
      assertEquals(loadsB, loadsFor("device-B"))
      assertEquals(2, streams.getValue("device-A").size)
      assertEquals(1, streams.getValue("device-B").size)
      waitForIdle()
      assertTrue(
        "the retired epoch's live run must not survive into the new epoch",
        onAllNodesWithText("Frame Rate").fetchSemanticsNodes().isEmpty(),
      )
    }
}

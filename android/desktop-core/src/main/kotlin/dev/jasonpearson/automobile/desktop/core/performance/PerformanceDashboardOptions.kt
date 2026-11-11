package dev.jasonpearson.automobile.desktop.core.performance

import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStream
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode

data class PerformanceDashboardOptions(
  val onNavigateToScreen: (String) -> Unit = {},
  val onNavigateToTest: (String) -> Unit = {},
  val dataSourceMode: DataSourceMode = DataSourceMode.Fake,
  val clientProvider: (() -> AutoMobileClient)? = null,
  val observationStreamClient: ObservationStream? = null,
  val deviceId: String? = null,
  /**
   * The pane's device epoch. A new epoch of the same [deviceId] drops the shown run and reloads
   * audit history scoped to this epoch, so a rebooted device shows neither the previous epoch's
   * live metrics nor its audits.
   */
  val deviceSessionUuid: String? = null,
  val connectionGeneration: Int = 0,
  val initialFps: Float? = null,
  val initialFrameTimeMs: Float? = null,
  val initialJankFrames: Int? = null,
  val initialMemoryMb: Float? = null,
  val initialTouchLatencyMs: Float? = null,
  val initialRecompositionRate: Float? = null,
  val ioDispatcher: kotlinx.coroutines.CoroutineDispatcher = kotlinx.coroutines.Dispatchers.IO,
)

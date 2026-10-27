package dev.jasonpearson.automobile.desktop.core.performance

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import dev.jasonpearson.automobile.desktop.core.di.LocalAutoMobileGraph
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory

internal class PerformanceDashboardState(initialRun: PerformanceRun?) {
  var currentScreen by mutableStateOf(PerformanceScreen.Overview)
  var selectedMetric by mutableStateOf<PerformanceMetric?>(null)
  var currentRun by mutableStateOf(initialRun)
  var isLoading by mutableStateOf(initialRun == null)
  var error by mutableStateOf<String?>(null)
  var realtimeMetricsHistory by mutableStateOf<List<MetricDataPoint>>(emptyList())
}

@Composable
internal fun rememberInitialPerformanceRun(options: PerformanceDashboardOptions): PerformanceRun? =
  with(options) {
    remember(
      initialFps,
      initialFrameTimeMs,
      initialJankFrames,
      initialMemoryMb,
      initialTouchLatencyMs,
      initialRecompositionRate,
    ) {
      if (initialFps != null || initialMemoryMb != null) {
        val timestamp = System.currentTimeMillis()
        PerformanceRun(
          id = "live-run-$timestamp",
          name = "Live Performance Data",
          timestamp = timestamp,
          durationMs = 0,
          deviceName = "Unknown",
          overallHealth = HealthStatus.Healthy,
          metrics = initialPerformanceMetrics(options, timestamp),
          anomalies = emptyList(),
          screensAnalyzed = emptyList(),
        )
      } else null
    }
  }

@Composable
internal fun ResetPerformanceGenerationEffect(
  options: PerformanceDashboardOptions,
  state: PerformanceDashboardState,
) {
  var observedGeneration by remember(options.observationStreamClient) { mutableStateOf(0) }
  LaunchedEffect(options.observationStreamClient, options.connectionGeneration) {
    if (observedGeneration != 0 && observedGeneration != options.connectionGeneration) {
      state.currentRun = null
      state.realtimeMetricsHistory = emptyList()
      state.currentScreen = PerformanceScreen.Overview
      state.selectedMetric = null
      state.isLoading = true
      state.error = null
    }
    observedGeneration = options.connectionGeneration
  }
}

@Composable
internal fun CollectPerformanceMetricsEffect(
  options: PerformanceDashboardOptions,
  state: PerformanceDashboardState,
) {
  LaunchedEffect(options.observationStreamClient) {
    val stream = options.observationStreamClient ?: return@LaunchedEffect
    LoggerFactory.getLogger("PerformanceDashboard")
      .info("Starting performance updates collection from stream client")
    stream.performanceUpdates.collect { update ->
      LoggerFactory.getLogger("PerformanceDashboard")
        .info(
          "Received performance update - fps=${update.fps}, jankFrames=${update.jankFrames}, touchLatencyMs=${update.touchLatencyMs}, ttiMs=${update.timeToInteractiveMs}, screenName=${update.screenName}",
        )
      val newPoint = MetricDataPoint(update.timestamp, update.fps, update.screenName)
      state.realtimeMetricsHistory = (state.realtimeMetricsHistory + newPoint).takeLast(120)
      val run = state.currentRun ?: emptyLivePerformanceRun(update.deviceId)
      val metrics = updatePerformanceMetrics(run.metrics, update)
      state.currentRun =
        run.copy(metrics = metrics, overallHealth = calculateOverallHealth(metrics))
    }
  }
}

private fun emptyLivePerformanceRun(deviceId: String?): PerformanceRun =
  PerformanceRun(
    id = "live-run-${System.currentTimeMillis()}",
    name = "Live Performance Data",
    timestamp = System.currentTimeMillis(),
    durationMs = 0,
    deviceName = deviceId ?: "Unknown",
    overallHealth = HealthStatus.Healthy,
    metrics = emptyList(),
    anomalies = emptyList(),
    screensAnalyzed = emptyList(),
  )

@Composable
internal fun LoadPerformanceRunEffect(
  options: PerformanceDashboardOptions,
  state: PerformanceDashboardState,
) {
  val graph = LocalAutoMobileGraph.current
  LaunchedEffect(
    options.dataSourceMode,
    options.clientProvider,
    options.deviceId,
    options.connectionGeneration,
  ) {
    if (state.currentRun != null) {
      state.isLoading = false
      return@LaunchedEffect
    }
    state.isLoading = true
    state.error = null
    kotlinx.coroutines.withContext(options.ioDispatcher) {
      try {
        val source =
          graph.dataSourceFactory.createPerformanceDataSource(
            options.dataSourceMode,
            options.clientProvider,
            options.deviceId,
          )
        when (val result = source.getPerformanceRun()) {
          is dev.jasonpearson.automobile.desktop.core.datasource.Result.Success -> {
            if (state.currentRun == null) state.currentRun = result.data
            state.isLoading = false
          }
          is dev.jasonpearson.automobile.desktop.core.datasource.Result.Error -> {
            state.error = result.message
            state.isLoading = false
          }
          is dev.jasonpearson.automobile.desktop.core.datasource.Result.Loading -> Unit
        }
      } catch (error: dev.jasonpearson.automobile.desktop.core.daemon.McpConnectionException) {
        state.error = error.message ?: "Unknown error"
        state.isLoading = false
      }
    }
  }
}

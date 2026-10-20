package dev.jasonpearson.automobile.desktop.core.performance

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStreamClient
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import dev.jasonpearson.automobile.desktop.core.tabs.PanelHeader
import dev.jasonpearson.automobile.desktop.core.tabs.VerticalCollapsibleTab
import dev.jasonpearson.automobile.desktop.core.tabs.VerticalTabOptions

/**
 * Vertical panel wrapper for PerformanceDashboard with collapse support. Shows FPS/memory summary
 * when collapsed.
 */
data class PerformancePanelOptions(
  val isCollapsed: Boolean,
  val onToggle: () -> Unit,
  val widthPx: Float,
  val onWidthChange: (Float) -> Unit,
  val currentFps: Float?,
  val currentFrameTimeMs: Float?,
  val currentJankFrames: Int?,
  val currentMemoryMb: Float?,
  val currentTouchLatencyMs: Float?,
  val currentRecompositionRate: Float? = null,
  val updateCounter: Int = 0,
  val onNavigateToScreen: (String) -> Unit = {},
  val onNavigateToTest: (String) -> Unit = {},
  val dataSourceMode: DataSourceMode = DataSourceMode.Fake,
  val clientProvider: (() -> AutoMobileClient)? = null,
  val observationStreamClient: ObservationStreamClient? = null,
)

@Composable
fun PerformanceVerticalPanel(
  options: PerformancePanelOptions,
  modifier: Modifier = Modifier,
) {
  val isCollapsed = options.isCollapsed
  val onToggle = options.onToggle
  val widthPx = options.widthPx
  val onWidthChange = options.onWidthChange
  val currentFps = options.currentFps
  val currentFrameTimeMs = options.currentFrameTimeMs
  val currentJankFrames = options.currentJankFrames
  val currentMemoryMb = options.currentMemoryMb
  val currentTouchLatencyMs = options.currentTouchLatencyMs
  val currentRecompositionRate = options.currentRecompositionRate
  val updateCounter = options.updateCounter
  val onNavigateToScreen = options.onNavigateToScreen
  val onNavigateToTest = options.onNavigateToTest
  val dataSourceMode = options.dataSourceMode
  val clientProvider = options.clientProvider
  val observationStreamClient = options.observationStreamClient

  VerticalCollapsibleTab(
    options =
      VerticalTabOptions(
        title = "Performance",
        isCollapsed = isCollapsed,
        onToggle = onToggle,
        widthPx = widthPx,
        onWidthChange = onWidthChange,
        resizeHandleOnLeft = true,
        collapsedContent = {
          PerformanceSummary(
            options = PerformanceMetrics(options),
          )
        },
      ),
  ) {
    Column(modifier = modifier.fillMaxSize()) {
      PanelHeader(
        title = "Performance",
        onCollapse = onToggle,
      )
      PerformanceDashboard(
        PerformanceDashboardOptions(
          onNavigateToScreen = onNavigateToScreen,
          onNavigateToTest = onNavigateToTest,
          dataSourceMode = dataSourceMode,
          clientProvider = clientProvider,
          observationStreamClient = observationStreamClient,
          initialFps = currentFps,
          initialFrameTimeMs = currentFrameTimeMs,
          initialJankFrames = currentJankFrames,
          initialMemoryMb = currentMemoryMb,
          initialTouchLatencyMs = currentTouchLatencyMs,
          initialRecompositionRate = currentRecompositionRate,
        ),
      )
    }
  }
}

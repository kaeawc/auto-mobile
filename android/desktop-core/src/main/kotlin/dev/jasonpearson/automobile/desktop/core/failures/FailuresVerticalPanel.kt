package dev.jasonpearson.automobile.desktop.core.failures

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.FailuresPushSocketClient
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import dev.jasonpearson.automobile.desktop.core.tabs.PanelHeader
import dev.jasonpearson.automobile.desktop.core.tabs.VerticalCollapsibleTab
import dev.jasonpearson.automobile.desktop.core.tabs.VerticalTabOptions

/**
 * Vertical panel wrapper for FailuresDashboard with collapse support. Shows a badge with failure
 * count when collapsed.
 */
data class FailuresVerticalPanelOptions(
  val isCollapsed: Boolean,
  val onToggle: () -> Unit,
  val widthPx: Float,
  val onWidthChange: (Float) -> Unit,
  val dateRangeLabel: String,
  val crashCount: Int,
  val anrCount: Int,
  val toolFailureCount: Int,
  val nonFatalCount: Int,
  val onNavigateToScreen: (String) -> Unit = {},
  val onNavigateToTest: (String) -> Unit = {},
  val onNavigateToSource: (fileName: String, lineNumber: Int) -> Unit = { _, _ -> },
  val onNewFailureNotification: ((FailureNotification) -> Unit)? = null,
  val initialSelectedFailureId: String? = null,
  val onFailureSelected: (() -> Unit)? = null,
  val onDateRangeChanged: ((DateRange) -> Unit)? = null,
  val onFailureCountsChanged:
    ((crashCount: Int, anrCount: Int, toolFailureCount: Int, nonFatalCount: Int) -> Unit)? =
    null,
  val initialDateRange: DateRange = DateRange.TwentyFourHours,
  val dataSourceMode: DataSourceMode = DataSourceMode.Fake,
  val clientProvider: (() -> AutoMobileClient)? = null,
  val streamingDataSource: StreamingFailuresDataSourceInterface? = null,
  val sessionUuidProvider: (() -> String?)? = null,
  val failuresPushClient: FailuresPushSocketClient? = null,
  val modifier: Modifier = Modifier,
)

@Composable
fun FailuresVerticalPanel(options: FailuresVerticalPanelOptions) {
  with(options) {
    VerticalCollapsibleTab(
      options =
        VerticalTabOptions(
          title = "Failures",
          isCollapsed = isCollapsed,
          onToggle = onToggle,
          widthPx = widthPx,
          onWidthChange = onWidthChange,
          resizeHandleOnLeft = true,
          collapsedContent = {
            FailuresCollapsedContent(
              dev.jasonpearson.automobile.desktop.core.failures.FailuresCollapsedState(
                dateRangeLabel = dateRangeLabel,
                crashCount = crashCount,
                anrCount = anrCount,
                toolFailureCount = toolFailureCount,
                nonFatalCount = nonFatalCount,
              ),
            )
          },
        ),
    ) {
      Column(modifier = modifier.fillMaxSize()) {
        PanelHeader(
          title = "Failures",
          onCollapse = onToggle,
        )
        FailuresDashboard(
          options =
            FailuresDashboardOptions(
              onNavigateToScreen = onNavigateToScreen,
              onNavigateToTest = onNavigateToTest,
              onNavigateToSource = onNavigateToSource,
              onNewFailureNotification = onNewFailureNotification,
              initialSelectedFailureId = initialSelectedFailureId,
              onFailureSelected = onFailureSelected,
              initialDateRange = initialDateRange,
              onDateRangeChanged = onDateRangeChanged,
              onFailureCountsChanged = onFailureCountsChanged,
              dataSourceMode = dataSourceMode,
              clientProvider = clientProvider,
              streamingDataSource = streamingDataSource,
              failuresPushClient = failuresPushClient,
              sessionUuidProvider = sessionUuidProvider,
            ),
          modifier = Modifier.fillMaxSize(),
        )
      }
    }
  }
}

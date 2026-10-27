package dev.jasonpearson.automobile.desktop.core.failures

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.FailuresPushSocketClient
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import dev.jasonpearson.automobile.desktop.core.datasource.Result
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme
import kotlin.math.min
import kotlinx.coroutines.delay

private val LOG = LoggerFactory.getLogger("FailuresDashboard")

internal fun createFailuresDashboardPushClient(sessionUuidProvider: (() -> String?)? = null) =
  FailuresPushSocketClient(sessionUuidProvider = sessionUuidProvider)

/** Main Failures dashboard showing crashes, ANRs, and tool call failures */
@Composable
fun FailuresDashboard(
  modifier: Modifier = Modifier,
  options: FailuresDashboardOptions = FailuresDashboardOptions(),
) {
  val memory = rememberFailuresMemory(options.initialSelectedFailureId)
  with(memory) {
    return with(options) {
      val scope = rememberCoroutineScope()

      // Retry counter - incrementing triggers LaunchedEffect to reload

      val sources = rememberFailureSources()
      val fakeDataSource = sources.fake
      val currentDataSource = sources.current
      val activeStreamingSource = sources.streaming
      // Data state

      // Streaming state

      // Push socket client for real-time updates - use provided or create local
      val pushClient = rememberDashboardPushClient()
      val isLocalPushClient = failuresPushClient == null

      // Load data when data source changes or retry is triggered
      LoadFailures(memory, currentDataSource)

      // Handle pending selected failure ID (for deep linking from notifications)
      SelectPendingFailure(memory)

      // Real-time notifications via streaming (with automatic reconnection)
      CollectFailureNotifications(memory, activeStreamingSource)

      // Real-time failure groups updates via streaming
      CollectFailureGroups(memory, activeStreamingSource)

      // Connect to push socket for real-time updates in real mode (only for local client)
      DisposableEffect(pushClient, isLocalPushClient) {
        if (isLocalPushClient) pushClient?.connect()
        onDispose {
          if (isLocalPushClient) pushClient?.dispose()
        }
      }

      // Listen for push notifications and refresh data
      RefreshPushedFailures(memory, pushClient, currentDataSource)

      FailuresBody(memory, sources, pushClient, scope, modifier)
    }
  }
}

// Maximum number of buckets we can reasonably display
private const val MAX_DISPLAYABLE_BUCKETS = 100

/**
 * Get valid aggregation options for a date range Must produce at least 2 buckets and no more than
 * MAX_DISPLAYABLE_BUCKETS
 */
internal fun getValidAggregations(dateRange: DateRange): List<TimeAggregation> {
  return TimeAggregation.entries.filter { agg ->
    val buckets = dateRange.durationMs / agg.durationMs
    buckets >= 2 && buckets <= MAX_DISPLAYABLE_BUCKETS
  }
}

/** Get the next smaller date range for drill-down */
internal fun getNextSmallerDateRange(current: DateRange): DateRange? {
  return when (current) {
    DateRange.ThirtyDays -> DateRange.SevenDays
    DateRange.SevenDays -> DateRange.ThreeDays
    DateRange.ThreeDays -> DateRange.TwentyFourHours
    DateRange.TwentyFourHours -> DateRange.OneHour
    DateRange.OneHour -> null // Can't go smaller
  }
}

/** Get the best default aggregation for a date range */
internal fun getBestAggregation(
  dateRange: DateRange,
  currentAgg: TimeAggregation,
): TimeAggregation {
  val valid = getValidAggregations(dateRange)
  // If current is valid, keep it
  if (currentAgg in valid) return currentAgg
  // Otherwise pick the coarsest (largest) valid granularity
  return valid.lastOrNull() ?: TimeAggregation.Minute
}

@Composable
internal fun FailureListView(
  failures: List<FailureGroup>,
  filterType: FailureType?,
  onFilterChanged: (FailureType?) -> Unit,
  onFailureSelected: (FailureGroup) -> Unit,
  options: FailureListOptions,
) {
  val memory = rememberFailureListMemory(options.initialDateRange)
  with(memory) {
    return with(options) {
      val colors = SharedTheme.globalColors
      val filteredFailures =
        if (filterType != null) {
          failures.filter { it.type == filterType }
        } else {
          failures
        }

      // Auto-switch aggregation when date range changes and current agg is invalid
      val validAggregations = remember(dateRange) { getValidAggregations(dateRange) }
      UpdateAggregation(memory)

      // Timeline data state

      // Load timeline data
      LoadFailureTimeline(memory)

      // Refresh timeline when push notifications arrive (real mode only)
      RefreshFailureTimeline(memory)

      Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        // Date range and aggregation selectors - stack when narrow
        BoxWithConstraints(modifier = Modifier.fillMaxWidth()) {
          val isNarrow = maxWidth < 400.dp

          if (isNarrow) {
            // Stack vertically when narrow
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
              // Date range selector
              DateRangeSelector()

              // Aggregation selector
              AggregationSelector(validAggregations)
            }
          } else {
            // Side by side when wide
            Row(
              modifier = Modifier.fillMaxWidth(),
              horizontalArrangement = Arrangement.SpaceBetween,
              verticalAlignment = Alignment.CenterVertically,
            ) {
              // Date range selector
              DateRangeSelector()

              // Aggregation selector (only show valid options)
              AggregationSelector(validAggregations)
            }
          }
        }

        Spacer(Modifier.height(16.dp))

        // Fake mode: Trigger failure button
        FakeFailureBanner()

        // Streaming error banner (non-fatal, shown as warning)
        FailureStreamingWarning()

        // Error banner
        FailureLoadError()

        FailureTimeline()
        // Filter chips - responsive to width
        FailureTypeFilters(filterType, onFilterChanged)

        // Issues header
        Text(
          if (isLoading) "Issues (loading...)" else "Issues (${filteredFailures.size})",
          fontSize = 13.sp,
          fontWeight = FontWeight.Medium,
          color = colors.text.normal.copy(alpha = 0.7f),
          modifier = Modifier.padding(bottom = 8.dp),
        )

        // Failure list
        FailureIssues(filteredFailures, onFailureSelected)
      }
    }
  }
}

internal data class BreakdownItem(
  val label: String,
  val sublabel: String?,
  val count: Int,
  val percentage: Float,
)

data class FailuresDashboardOptions(
  val onNavigateToScreen: (String) -> Unit = {},
  val onNavigateToTest: (String) -> Unit = {},
  val onNavigateToSource: (fileName: String, lineNumber: Int) -> Unit = { _, _ -> },
  val onNewFailureNotification: ((FailureNotification) -> Unit)? = null,
  val initialSelectedFailureId: String? = null,
  val onFailureSelected: (() -> Unit)? = null,
  val initialDateRange: DateRange = DateRange.TwentyFourHours,
  val onDateRangeChanged: ((DateRange) -> Unit)? = null,
  val onFailureCountsChanged:
    ((crashCount: Int, anrCount: Int, toolFailureCount: Int, nonFatalCount: Int) -> Unit)? =
    null,
  val clientProvider: (() -> AutoMobileClient)? = null,
  val streamingDataSource: StreamingFailuresDataSourceInterface? = null,
  val dataSourceMode: DataSourceMode = DataSourceMode.Fake,
  val sessionUuidProvider: (() -> String?)? = null,
  val failuresPushClient: FailuresPushSocketClient? = null,
  val pushClientFactory: ((() -> String?)?) -> FailuresPushSocketClient = {
    createFailuresDashboardPushClient(sessionUuidProvider = it)
  },
)

internal data class FailureListOptions(
  val isLoading: Boolean,
  val errorMessage: String?,
  val streamingError: String?,
  val onRetry: () -> Unit,
  val dataSource: FailuresDataSource,
  val dataSourceMode: DataSourceMode,
  val fakeDataSource: FakeFailuresDataSource?,
  val onTriggerFakeFailure: () -> Unit,
  val pushClient: FailuresPushSocketClient? = null,
  val initialDateRange: DateRange = DateRange.TwentyFourHours,
  val onDateRangeChanged: ((DateRange) -> Unit)? = null,
  val onFailureCountsChanged:
    ((crashCount: Int, anrCount: Int, toolFailureCount: Int, nonFatalCount: Int) -> Unit)? =
    null,
)

internal data class FailureStatStyle(
  val emoji: String? = null,
  val delta: String? = null,
  val deltaPositive: Boolean = false,
  val showLabel: Boolean = true,
)

internal data class FailureDetailMemory(
  private val expandedStateState: androidx.compose.runtime.MutableState<ExpandableListState>,
) {
  var expandedState by expandedStateState
}

@Composable
internal fun rememberFailureDetailMemory(failure: FailureGroup): FailureDetailMemory {
  val expandedStateState = remember(failure.id) { mutableStateOf(ExpandableListState()) }
  return FailureDetailMemory(expandedStateState)
}

internal data class FailureListMemory(
  private val dateRangeState: androidx.compose.runtime.MutableState<DateRange>,
  private val timeAggregationState: androidx.compose.runtime.MutableState<TimeAggregation>,
  private val timelineDataState: androidx.compose.runtime.MutableState<TimelineData?>,
  private val timelineLoadingState: androidx.compose.runtime.MutableState<Boolean>,
) {
  var dateRange by dateRangeState
  var timeAggregation by timeAggregationState
  var timelineData by timelineDataState
  var timelineLoading by timelineLoadingState
}

@Composable
private fun rememberFailureListMemory(initialDateRange: DateRange): FailureListMemory {
  val dateRangeState = remember { mutableStateOf(initialDateRange) }
  val timeAggregationState = remember { mutableStateOf(TimeAggregation.Hour) }
  val timelineDataState = remember { mutableStateOf<TimelineData?>(null) }
  val timelineLoadingState = remember { mutableStateOf(true) }
  return FailureListMemory(
    dateRangeState,
    timeAggregationState,
    timelineDataState,
    timelineLoadingState,
  )
}

internal data class FailuresMemory(
  private val retryCounterState: androidx.compose.runtime.MutableState<Int>,
  private val failureGroupsState: androidx.compose.runtime.MutableState<List<FailureGroup>>,
  private val isLoadingState: androidx.compose.runtime.MutableState<Boolean>,
  private val errorMessageState: androidx.compose.runtime.MutableState<String?>,
  private val selectedFailureState: androidx.compose.runtime.MutableState<FailureGroup?>,
  private val filterTypeState: androidx.compose.runtime.MutableState<FailureType?>,
  private val pendingSelectedFailureIdState: androidx.compose.runtime.MutableState<String?>,
  private val streamingErrorState: androidx.compose.runtime.MutableState<String?>,
  private val reconnectAttemptState: androidx.compose.runtime.MutableState<Int>,
) {
  var retryCounter by retryCounterState
  var failureGroups by failureGroupsState
  var isLoading by isLoadingState
  var errorMessage by errorMessageState
  var selectedFailure by selectedFailureState
  var filterType by filterTypeState
  var pendingSelectedFailureId by pendingSelectedFailureIdState
  var streamingError by streamingErrorState
  var reconnectAttempt by reconnectAttemptState
}

internal data class FailureSources(
  val fake: FakeFailuresDataSource?,
  val current: FailuresDataSource,
  val streaming: StreamingFailuresDataSourceInterface?,
)

@Composable
private fun FailuresDashboardOptions.CollectFailureNotifications(
  memory: FailuresMemory,
  activeStreamingSource: StreamingFailuresDataSourceInterface?,
) {
  with(memory) {
    LaunchedEffect(activeStreamingSource, reconnectAttempt) {
      if (activeStreamingSource == null) return@LaunchedEffect

      try {
        streamingError = null
        activeStreamingSource.notificationsFlow().collect { result ->
          when (result) {
            is Result.Success -> {
              // Reset reconnect attempt on success
              reconnectAttempt = 0
              streamingError = null

              // Only notify for the most recent notification (by timestamp)
              val mostRecent = result.data.maxByOrNull { it.timestamp }
              if (mostRecent != null) {
                onNewFailureNotification?.invoke(mostRecent)
              }
            }
            is Result.Error -> {
              streamingError = result.message
            }
            is Result.Loading -> {
              /* waiting for data */
            }
          }
        }
      } catch (cancellation: kotlinx.coroutines.CancellationException) {
        throw cancellation
      } catch (e: Exception) {
        LOG.warn("Failure notification stream failed; retrying: ${e.message}", e)
        streamingError = e.message
        // Exponential backoff for reconnection
        val backoffMs = min(1000L * (1 shl reconnectAttempt), 30000L)
        delay(backoffMs)
        reconnectAttempt++
      }
    }
  }
}

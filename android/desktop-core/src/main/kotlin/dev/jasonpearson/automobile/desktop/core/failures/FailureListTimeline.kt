package dev.jasonpearson.automobile.desktop.core.failures

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import dev.jasonpearson.automobile.desktop.core.datasource.Result
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme
import kotlinx.coroutines.flow.collectLatest

@Composable
internal fun FailureListOptions.UpdateAggregation(memory: FailureListMemory) {
  with(memory) {
    LaunchedEffect(dateRange) {
      val bestAgg = getBestAggregation(dateRange, timeAggregation)
      if (bestAgg != timeAggregation) {
        timeAggregation = bestAgg
      }
      // Notify parent of date range change
      onDateRangeChanged?.invoke(dateRange)
    }
  }
}

@Composable
internal fun FailureListOptions.LoadFailureTimeline(memory: FailureListMemory) {
  with(memory) {
    LaunchedEffect(dataSource, dateRange, timeAggregation) {
      timelineLoading = true
      when (val result = dataSource.getTimelineData(dateRange, timeAggregation)) {
        is Result.Success -> {
          timelineData = result.data
          timelineLoading = false
          // Report failure counts to parent
          val data = result.data
          val crashCount = data.dataPoints.sumOf { it.crashes }
          val anrCount = data.dataPoints.sumOf { it.anrs }
          val toolFailureCount = data.dataPoints.sumOf { it.toolFailures }
          val nonFatalCount = data.dataPoints.sumOf { it.nonfatals }
          onFailureCountsChanged?.invoke(crashCount, anrCount, toolFailureCount, nonFatalCount)
        }
        is Result.Error -> {
          timelineData = null
          timelineLoading = false
        }
        is Result.Loading -> {
          /* keep loading state */
        }
      }
    }
  }
}

@Composable
internal fun FailureListOptions.RefreshFailureTimeline(memory: FailureListMemory) {
  with(memory) {
    LaunchedEffect(pushClient, dataSource, dateRange, timeAggregation, dataSourceMode) {
      if (dataSourceMode == DataSourceMode.Real && pushClient != null) {
        pushClient.failureNotifications.collectLatest {
          // Refresh timeline when we receive a push notification
          when (val result = dataSource.getTimelineData(dateRange, timeAggregation)) {
            is Result.Success -> {
              timelineData = result.data
              // Report updated failure counts to parent
              val data = result.data
              val crashCount = data.dataPoints.sumOf { it.crashes }
              val anrCount = data.dataPoints.sumOf { it.anrs }
              val toolFailureCount = data.dataPoints.sumOf { it.toolFailures }
              val nonFatalCount = data.dataPoints.sumOf { it.nonfatals }
              onFailureCountsChanged?.invoke(crashCount, anrCount, toolFailureCount, nonFatalCount)
            }
            is Result.Error -> {
              // Don't clear timeline on refresh failures
            }
            is Result.Loading -> {
              /* keep current state */
            }
          }
        }
      }
    }
  }
}

@Composable
internal fun FailureListMemory.FailureTimeline() {
  val colors = SharedTheme.globalColors
  // Event Trends section
  val canDrillDown = getNextSmallerDateRange(dateRange) != null
  val currentTimelineData = timelineData
  if (currentTimelineData != null) {
    EventTrendsSection(
      data = currentTimelineData,
      dateRange = dateRange,
      aggregation = timeAggregation,
      onBarClick =
        if (canDrillDown) {
          {
            // Drill down to smaller time range
            val nextRange = getNextSmallerDateRange(dateRange)
            if (nextRange != null) {
              dateRange = nextRange
            }
          }
        } else null,
    )
  } else if (timelineLoading) {
    Box(
      modifier =
        Modifier.fillMaxWidth()
          .height(140.dp)
          .background(colors.text.normal.copy(alpha = 0.03f), RoundedCornerShape(8.dp)),
      contentAlignment = Alignment.Center,
    ) {
      Text(
        "Loading timeline...",
        fontSize = 12.sp,
        color = colors.text.normal.copy(alpha = 0.5f),
      )
    }
  }

  Spacer(Modifier.height(16.dp))
}

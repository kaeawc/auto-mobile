package dev.jasonpearson.automobile.desktop.core.failures

import dev.jasonpearson.automobile.desktop.core.datasource.Result
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow

/**
 * Combines MCP polling for initial load with Unix socket streaming for real-time updates.
 *
 * Initial data is fetched via MCP (more complete data with full failure groups). Real-time
 * notifications and updates come via Unix socket streaming.
 */
class CompositeFailuresDataSource(
    private val mcpDataSource: FailuresDataSource?,
    private val streamingDataSource: StreamingFailuresDataSourceInterface?,
) : FailuresDataSource, StreamingFailuresDataSourceInterface {

  /**
   * Get failure groups via MCP for initial/complete data. Falls back to streaming if MCP is not
   * available and streaming implements FailuresDataSource.
   */
  override suspend fun getFailureGroups(): Result<List<FailureGroup>> {
    // Prefer MCP for initial load (more complete data)
    mcpDataSource?.getFailureGroups()?.let { result ->
      if (result is Result.Success) {
        return result
      }
    }

    // Fall back to streaming if available and implements FailuresDataSource
    (streamingDataSource as? FailuresDataSource)?.getFailureGroups()?.let { result ->
      return result
    }

    // Return empty if neither is available
    return Result.Success(emptyList())
  }

  /**
   * Get timeline data via MCP for initial/complete data. Falls back to streaming if MCP is not
   * available and streaming implements FailuresDataSource.
   */
  override suspend fun getTimelineData(
      dateRange: DateRange,
      aggregation: TimeAggregation,
  ): Result<TimelineData> {
    // Prefer MCP for timeline data
    mcpDataSource?.getTimelineData(dateRange, aggregation)?.let { result ->
      if (result is Result.Success) {
        return result
      }
    }

    // Fall back to streaming if available and implements FailuresDataSource
    (streamingDataSource as? FailuresDataSource)?.getTimelineData(dateRange, aggregation)?.let {
        result ->
      return result
    }

    // Return empty if neither is available
    return Result.Success(
        TimelineData(
            dataPoints = emptyList(),
            previousPeriodTotals = PeriodTotals(0, 0, 0),
        )
    )
  }

  /**
   * Real-time notification flow from Unix socket. Returns empty flow if streaming is not available.
   */
  override fun notificationsFlow(): Flow<Result<List<FailureNotification>>> {
    return streamingDataSource?.notificationsFlow() ?: emptyFlow()
  }

  /**
   * Real-time failure groups updates from Unix socket. Returns empty flow if streaming is not
   * available.
   */
  override fun failureGroupsFlow(): Flow<Result<FailureGroupsWithTotals>> {
    return streamingDataSource?.failureGroupsFlow() ?: emptyFlow()
  }

  /** Whether streaming is available for real-time updates. */
  val hasStreaming: Boolean
    get() = streamingDataSource != null
}

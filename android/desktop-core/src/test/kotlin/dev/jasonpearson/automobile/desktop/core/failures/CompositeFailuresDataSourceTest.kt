package dev.jasonpearson.automobile.desktop.core.failures

import dev.jasonpearson.automobile.desktop.core.datasource.Result
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CompositeFailuresDataSourceTest {

  @Test
  fun `getFailureGroups uses MCP when available and successful`() = runBlocking {
    val mcpGroups = listOf(createTestFailureGroup("mcp-1"))
    val streamingGroups = listOf(createTestFailureGroup("streaming-1"))

    val mcpDataSource =
      FakeFailuresDataSourceImpl(getFailureGroupsResult = Result.Success(mcpGroups))
    val streamingDataSource =
      FakeStreamingFailuresDataSource(getFailureGroupsResult = Result.Success(streamingGroups))

    val composite = CompositeFailuresDataSource(mcpDataSource, streamingDataSource)
    val result = composite.getFailureGroups()

    assertTrue(result is Result.Success)
    assertEquals(mcpGroups, (result as Result.Success).data)
  }

  @Test
  fun `getFailureGroups falls back to streaming when MCP fails`() = runBlocking {
    val streamingGroups = listOf(createTestFailureGroup("streaming-1"))

    val mcpDataSource =
      FakeFailuresDataSourceImpl(
        getFailureGroupsResult = Result.Error(RuntimeException("MCP unavailable"))
      )
    val streamingDataSource =
      FakeStreamingFailuresDataSource(getFailureGroupsResult = Result.Success(streamingGroups))

    val composite = CompositeFailuresDataSource(mcpDataSource, streamingDataSource)
    val result = composite.getFailureGroups()

    assertTrue(result is Result.Success)
    assertEquals(streamingGroups, (result as Result.Success).data)
  }

  @Test
  fun `getFailureGroups returns empty when neither source available`() = runBlocking {
    val composite = CompositeFailuresDataSource(null, null)
    val result = composite.getFailureGroups()

    assertTrue(result is Result.Success)
    assertTrue((result as Result.Success).data.isEmpty())
  }

  @Test
  fun `getTimelineData uses MCP when available`() = runBlocking {
    val mcpTimeline =
      TimelineData(
        dataPoints = listOf(TimelineDataPoint("1h", 5, 2, 1, 0)),
        previousPeriodTotals = PeriodTotals(crashes = 3, anrs = 1, toolFailures = 0, nonfatals = 0),
      )

    val mcpDataSource =
      FakeFailuresDataSourceImpl(getTimelineDataResult = Result.Success(mcpTimeline))

    val composite = CompositeFailuresDataSource(mcpDataSource, null)
    val result = composite.getTimelineData(DateRange.OneHour, TimeAggregation.Minute)

    assertTrue(result is Result.Success)
    assertEquals(mcpTimeline, (result as Result.Success).data)
  }

  @Test
  fun `getTimelineData returns empty when no sources available`() = runBlocking {
    val composite = CompositeFailuresDataSource(null, null)
    val result = composite.getTimelineData(DateRange.OneHour, TimeAggregation.Minute)

    assertTrue(result is Result.Success)
    val data = (result as Result.Success).data
    assertTrue(data.dataPoints.isEmpty())
    assertEquals(0, data.previousPeriodTotals.crashes)
  }

  @Test
  fun `notificationsFlow returns streaming flow when available`() = runBlocking {
    val notification = createTestNotification(1)
    val streamingDataSource =
      FakeStreamingFailuresDataSource(
        notificationsFlowResult = flowOf(Result.Success(listOf(notification)))
      )

    val composite = CompositeFailuresDataSource(null, streamingDataSource)
    val results = composite.notificationsFlow().toList()

    assertEquals(1, results.size)
    assertTrue(results[0] is Result.Success)
    assertEquals(listOf(notification), (results[0] as Result.Success).data)
  }

  @Test
  fun `notificationsFlow returns empty flow when streaming not available`() = runBlocking {
    val composite = CompositeFailuresDataSource(null, null)
    val results = composite.notificationsFlow().toList()

    assertTrue(results.isEmpty())
  }

  @Test
  fun `failureGroupsFlow returns streaming flow when available`() = runBlocking {
    val groups = listOf(createTestFailureGroup("test-1"))
    val totals = FailureTotals(crashes = 1, anrs = 0, toolFailures = 0, nonfatals = 0)
    val streamingDataSource =
      FakeStreamingFailuresDataSource(
        failureGroupsFlowResult = flowOf(Result.Success(FailureGroupsWithTotals(groups, totals)))
      )

    val composite = CompositeFailuresDataSource(null, streamingDataSource)
    val results = composite.failureGroupsFlow().toList()

    assertEquals(1, results.size)
    assertTrue(results[0] is Result.Success)
    assertEquals(groups, (results[0] as Result.Success).data.groups)
  }

  @Test
  fun `hasStreaming returns true when streaming source provided`() {
    val composite = CompositeFailuresDataSource(null, FakeStreamingFailuresDataSource())
    assertTrue(composite.hasStreaming)
  }

  @Test
  fun `hasStreaming returns false when streaming source is null`() {
    val composite = CompositeFailuresDataSource(null, null)
    assertFalse(composite.hasStreaming)
  }

  // Helper classes

  private class FakeFailuresDataSourceImpl(
    private val getFailureGroupsResult: Result<List<FailureGroup>> = Result.Success(emptyList()),
    private val getTimelineDataResult: Result<TimelineData> =
      Result.Success(
        TimelineData(
          emptyList(),
          PeriodTotals(crashes = 0, anrs = 0, toolFailures = 0, nonfatals = 0),
        )
      ),
  ) : FailuresDataSource {
    override suspend fun getFailureGroups(): Result<List<FailureGroup>> = getFailureGroupsResult

    override suspend fun getTimelineData(
      dateRange: DateRange,
      aggregation: TimeAggregation,
    ): Result<TimelineData> = getTimelineDataResult
  }

  private class FakeStreamingFailuresDataSource(
    private val getFailureGroupsResult: Result<List<FailureGroup>> = Result.Success(emptyList()),
    private val getTimelineDataResult: Result<TimelineData> =
      Result.Success(
        TimelineData(
          emptyList(),
          PeriodTotals(crashes = 0, anrs = 0, toolFailures = 0, nonfatals = 0),
        )
      ),
    private val notificationsFlowResult: Flow<Result<List<FailureNotification>>> = emptyFlow(),
    private val failureGroupsFlowResult: Flow<Result<FailureGroupsWithTotals>> = emptyFlow(),
  ) : FailuresDataSource, StreamingFailuresDataSourceInterface {

    override suspend fun getFailureGroups(): Result<List<FailureGroup>> = getFailureGroupsResult

    override suspend fun getTimelineData(
      dateRange: DateRange,
      aggregation: TimeAggregation,
    ): Result<TimelineData> = getTimelineDataResult

    override fun notificationsFlow(): Flow<Result<List<FailureNotification>>> =
      notificationsFlowResult

    override fun failureGroupsFlow(): Flow<Result<FailureGroupsWithTotals>> =
      failureGroupsFlowResult
  }

  private fun createTestFailureGroup(id: String) =
    FailureGroup(
      id = id,
      type = FailureType.Crash,
      signature = "Test signature",
      title = "Test title",
      message = "Test message",
      firstOccurrence = 0L,
      lastOccurrence = 0L,
      totalCount = 1,
      uniqueSessions = 1,
      severity = FailureSeverity.Medium,
      deviceBreakdown = emptyList(),
      versionBreakdown = emptyList(),
      screenBreakdown = emptyList(),
      failureScreens = emptyMap(),
      stackTraceElements = emptyList(),
      toolCallInfo = null,
      affectedTests = emptyMap(),
      recentCaptures = emptyList(),
      sampleOccurrences = emptyList(),
    )

  private fun createTestNotification(id: Int) =
    FailureNotification(
      id = id,
      occurrenceId = "occ-$id",
      groupId = "group-$id",
      type = FailureType.Crash,
      severity = FailureSeverity.Medium,
      title = "Test notification $id",
      timestamp = System.currentTimeMillis(),
      acknowledged = false,
    )
}

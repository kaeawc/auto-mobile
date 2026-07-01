package dev.jasonpearson.automobile.desktop.core.failures

import dev.jasonpearson.automobile.desktop.core.datasource.Result
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class FailuresViewModelTest {

  private val testDispatcher = UnconfinedTestDispatcher()
  private val testScope = TestScope(testDispatcher)

  private fun createTestFailureGroup(id: String, type: FailureType = FailureType.Crash) =
      FailureGroup(
          id = id,
          type = type,
          signature = "Test signature $id",
          title = "Test title $id",
          message = "Test message $id",
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

  @Test
  fun `initial state transitions to Content on success`() = testScope.runTest {
    val groups = listOf(createTestFailureGroup("g1"), createTestFailureGroup("g2"))
    val dataSource = FakeFailuresDataSourceImpl(Result.Success(groups))
    val vm = FailuresViewModel(dataSource, this)

    val state = vm.state.value
    assertTrue("Expected Content but was $state", state is FailuresUiState.Content)
    val content = state as FailuresUiState.Content
    assertEquals(2, content.failureGroups.size)
    assertNull(content.selectedFailure)
    assertNull(content.filterType)
  }

  @Test
  fun `transitions to Error on data source error`() = testScope.runTest {
    val dataSource = FakeFailuresDataSourceImpl(Result.Error(RuntimeException("Server down")))
    val vm = FailuresViewModel(dataSource, this)

    val state = vm.state.value
    assertTrue("Expected Error but was $state", state is FailuresUiState.Error)
    assertEquals("Server down", (state as FailuresUiState.Error).message)
  }

  @Test
  fun `transitions to Error on exception`() = testScope.runTest {
    val dataSource = ThrowingFailuresDataSource(RuntimeException("Crash"))
    val vm = FailuresViewModel(dataSource, this)

    val state = vm.state.value
    assertTrue("Expected Error but was $state", state is FailuresUiState.Error)
    assertEquals("Crash", (state as FailuresUiState.Error).message)
  }

  @Test
  fun `SelectFailure updates selectedFailure`() = testScope.runTest {
    val group = createTestFailureGroup("g1")
    val dataSource = FakeFailuresDataSourceImpl(Result.Success(listOf(group)))
    val vm = FailuresViewModel(dataSource, this)

    vm.onAction(FailuresAction.SelectFailure(group))

    val state = vm.state.value as FailuresUiState.Content
    assertEquals(group, state.selectedFailure)
  }

  @Test
  fun `ClearSelection clears selectedFailure`() = testScope.runTest {
    val group = createTestFailureGroup("g1")
    val dataSource = FakeFailuresDataSourceImpl(Result.Success(listOf(group)))
    val vm = FailuresViewModel(dataSource, this)

    vm.onAction(FailuresAction.SelectFailure(group))
    vm.onAction(FailuresAction.ClearSelection)

    val state = vm.state.value as FailuresUiState.Content
    assertNull(state.selectedFailure)
  }

  @Test
  fun `FilterByType sets filterType`() = testScope.runTest {
    val groups =
        listOf(
            createTestFailureGroup("g1", FailureType.Crash),
            createTestFailureGroup("g2", FailureType.ANR),
        )
    val dataSource = FakeFailuresDataSourceImpl(Result.Success(groups))
    val vm = FailuresViewModel(dataSource, this)

    vm.onAction(FailuresAction.FilterByType(FailureType.ANR))

    val state = vm.state.value as FailuresUiState.Content
    assertEquals(FailureType.ANR, state.filterType)
  }

  @Test
  fun `FilterByType with null clears filter`() = testScope.runTest {
    val groups = listOf(createTestFailureGroup("g1"))
    val dataSource = FakeFailuresDataSourceImpl(Result.Success(groups))
    val vm = FailuresViewModel(dataSource, this)

    vm.onAction(FailuresAction.FilterByType(FailureType.Crash))
    vm.onAction(FailuresAction.FilterByType(null))

    val state = vm.state.value as FailuresUiState.Content
    assertNull(state.filterType)
  }

  @Test
  fun `SelectFailureById finds and selects failure`() = testScope.runTest {
    val groups =
        listOf(
            createTestFailureGroup("g1"),
            createTestFailureGroup("g2"),
        )
    val dataSource = FakeFailuresDataSourceImpl(Result.Success(groups))
    val vm = FailuresViewModel(dataSource, this)

    vm.onAction(FailuresAction.SelectFailureById("g2"))

    val state = vm.state.value as FailuresUiState.Content
    assertEquals("g2", state.selectedFailure?.id)
  }

  @Test
  fun `SelectFailureById with unknown id does not select`() = testScope.runTest {
    val groups = listOf(createTestFailureGroup("g1"))
    val dataSource = FakeFailuresDataSourceImpl(Result.Success(groups))
    val vm = FailuresViewModel(dataSource, this)

    vm.onAction(FailuresAction.SelectFailureById("nonexistent"))

    val state = vm.state.value as FailuresUiState.Content
    assertNull(state.selectedFailure)
  }

  @Test
  fun `Refresh reloads data`() = testScope.runTest {
    val dataSource =
        FakeFailuresDataSourceImpl(Result.Success(listOf(createTestFailureGroup("g1"))))
    val vm = FailuresViewModel(dataSource, this)

    dataSource.result =
        Result.Success(
            listOf(
                createTestFailureGroup("g1"),
                createTestFailureGroup("g2"),
                createTestFailureGroup("g3"),
            )
        )
    vm.onAction(FailuresAction.Refresh)

    val state = vm.state.value as FailuresUiState.Content
    assertEquals(3, state.failureGroups.size)
  }

  @Test
  fun `UpdateGroups replaces failure groups in Content state`() = testScope.runTest {
    val dataSource =
        FakeFailuresDataSourceImpl(Result.Success(listOf(createTestFailureGroup("g1"))))
    val vm = FailuresViewModel(dataSource, this)

    val newGroups = listOf(createTestFailureGroup("g2"), createTestFailureGroup("g3"))
    vm.onAction(FailuresAction.UpdateGroups(newGroups))

    val state = vm.state.value as FailuresUiState.Content
    assertEquals(2, state.failureGroups.size)
    assertEquals("g2", state.failureGroups[0].id)
  }

  @Test
  fun `UpdateGroups sets Content from Error state`() = testScope.runTest {
    val dataSource = FakeFailuresDataSourceImpl(Result.Error(RuntimeException("initial error")))
    val vm = FailuresViewModel(dataSource, this)
    assertTrue(vm.state.value is FailuresUiState.Error)

    val groups = listOf(createTestFailureGroup("g1"))
    vm.onAction(FailuresAction.UpdateGroups(groups))

    val state = vm.state.value as FailuresUiState.Content
    assertEquals(1, state.failureGroups.size)
  }

  // -- Fakes --

  private class FakeFailuresDataSourceImpl(
      var result: Result<List<FailureGroup>>,
  ) : FailuresDataSource {
    override suspend fun getFailureGroups(): Result<List<FailureGroup>> = result

    override suspend fun getTimelineData(
        dateRange: DateRange,
        aggregation: TimeAggregation,
    ): Result<TimelineData> = Result.Success(TimelineData(emptyList(), PeriodTotals(0, 0, 0, 0)))
  }

  private class ThrowingFailuresDataSource(
      private val exception: Exception,
  ) : FailuresDataSource {
    override suspend fun getFailureGroups(): Result<List<FailureGroup>> = throw exception

    override suspend fun getTimelineData(
        dateRange: DateRange,
        aggregation: TimeAggregation,
    ): Result<TimelineData> = throw exception
  }
}

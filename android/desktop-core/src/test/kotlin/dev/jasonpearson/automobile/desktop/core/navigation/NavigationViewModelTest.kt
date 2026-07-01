package dev.jasonpearson.automobile.desktop.core.navigation

import dev.jasonpearson.automobile.desktop.core.datasource.NavigationDataSource
import dev.jasonpearson.automobile.desktop.core.datasource.NavigationGraph
import dev.jasonpearson.automobile.desktop.core.datasource.Result
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class NavigationViewModelTest {

  private val testDispatcher = UnconfinedTestDispatcher()
  private val testScope = TestScope(testDispatcher)

  private val testScreens =
    listOf(
      ScreenNode("s1", "Login", "Composable", "com.app", 2, 0L),
      ScreenNode("s2", "Home", "Composable", "com.app", 3, 1000L),
    )
  private val testTransitions =
    listOf(ScreenTransition("t1", "Login", "Home", "tap", "Login Button", 100, 0.01f))
  private val testGraph = NavigationGraph(screens = testScreens, transitions = testTransitions)

  @Test
  fun `initial state is Loading then transitions to Content on success`() = testScope.runTest {
    val dataSource = FakeNavigationDataSourceImpl(Result.Success(testGraph))
    val vm = NavigationViewModel(dataSource, this)

    val state = vm.state.value
    assertTrue("Expected Content but was $state", state is NavigationUiState.Content)
    val content = state as NavigationUiState.Content
    assertEquals(2, content.graph.screens.size)
    assertEquals(1, content.graph.transitions.size)
    assertEquals(NavigationSection.FlowMap, content.currentSection)
  }

  @Test
  fun `transitions to Error state on data source error`() = testScope.runTest {
    val dataSource = FakeNavigationDataSourceImpl(Result.Error(RuntimeException("Network error")))
    val vm = NavigationViewModel(dataSource, this)

    val state = vm.state.value
    assertTrue("Expected Error but was $state", state is NavigationUiState.Error)
    assertEquals("Network error", (state as NavigationUiState.Error).message)
  }

  @Test
  fun `transitions to Error state on exception`() = testScope.runTest {
    val dataSource = ThrowingNavigationDataSource(RuntimeException("Boom"))
    val vm = NavigationViewModel(dataSource, this)

    val state = vm.state.value
    assertTrue("Expected Error but was $state", state is NavigationUiState.Error)
    assertEquals("Boom", (state as NavigationUiState.Error).message)
  }

  @Test
  fun `SelectScreen action updates selectedScreenId and section`() = testScope.runTest {
    val dataSource = FakeNavigationDataSourceImpl(Result.Success(testGraph))
    val vm = NavigationViewModel(dataSource, this)

    vm.onAction(NavigationAction.SelectScreen("s1"))

    val state = vm.state.value as NavigationUiState.Content
    assertEquals("s1", state.selectedScreenId)
    assertEquals(NavigationSection.ScreenDetail, state.currentSection)
  }

  @Test
  fun `SelectScreenByName action finds screen by name`() = testScope.runTest {
    val dataSource = FakeNavigationDataSourceImpl(Result.Success(testGraph))
    val vm = NavigationViewModel(dataSource, this)

    vm.onAction(NavigationAction.SelectScreenByName("Home"))

    val state = vm.state.value as NavigationUiState.Content
    assertEquals("s2", state.selectedScreenId)
    assertEquals(NavigationSection.ScreenDetail, state.currentSection)
  }

  @Test
  fun `SelectScreenByName with unknown name does not change state`() = testScope.runTest {
    val dataSource = FakeNavigationDataSourceImpl(Result.Success(testGraph))
    val vm = NavigationViewModel(dataSource, this)

    vm.onAction(NavigationAction.SelectScreenByName("NonExistent"))

    val state = vm.state.value as NavigationUiState.Content
    assertEquals(null, state.selectedScreenId)
    assertEquals(NavigationSection.FlowMap, state.currentSection)
  }

  @Test
  fun `BackToFlowMap resets section and selection`() = testScope.runTest {
    val dataSource = FakeNavigationDataSourceImpl(Result.Success(testGraph))
    val vm = NavigationViewModel(dataSource, this)

    vm.onAction(NavigationAction.SelectScreen("s1"))
    vm.onAction(NavigationAction.BackToFlowMap)

    val state = vm.state.value as NavigationUiState.Content
    assertEquals(null, state.selectedScreenId)
    assertEquals(NavigationSection.FlowMap, state.currentSection)
  }

  @Test
  fun `Refresh reloads data from source`() = testScope.runTest {
    val dataSource = FakeNavigationDataSourceImpl(Result.Success(testGraph))
    val vm = NavigationViewModel(dataSource, this)

    // Change to a new graph on next call
    val updatedGraph =
      NavigationGraph(
        screens = listOf(ScreenNode("s3", "Settings", "Composable", "com.app", 1, 2000L)),
        transitions = emptyList(),
      )
    dataSource.result = Result.Success(updatedGraph)

    vm.onAction(NavigationAction.Refresh)

    val state = vm.state.value as NavigationUiState.Content
    assertEquals(1, state.graph.screens.size)
    assertEquals("Settings", state.graph.screens.first().name)
  }

  @Test
  fun `UpdateGraph updates graph in Content state`() = testScope.runTest {
    val dataSource = FakeNavigationDataSourceImpl(Result.Success(testGraph))
    val vm = NavigationViewModel(dataSource, this)

    val newGraph =
      NavigationGraph(
        screens = listOf(ScreenNode("s3", "Settings", "Composable", "com.app", 1, 2000L)),
        transitions = emptyList(),
      )
    vm.onAction(NavigationAction.UpdateGraph(newGraph))

    val state = vm.state.value as NavigationUiState.Content
    assertEquals(1, state.graph.screens.size)
    assertEquals("Settings", state.graph.screens.first().name)
  }

  @Test
  fun `UpdateGraph sets Content from non-Content state`() = testScope.runTest {
    val dataSource = FakeNavigationDataSourceImpl(Result.Error(RuntimeException("initial error")))
    val vm = NavigationViewModel(dataSource, this)
    assertTrue(vm.state.value is NavigationUiState.Error)

    vm.onAction(NavigationAction.UpdateGraph(testGraph))

    val state = vm.state.value as NavigationUiState.Content
    assertEquals(2, state.graph.screens.size)
  }

  // -- Fakes --

  private class FakeNavigationDataSourceImpl(var result: Result<NavigationGraph>) :
    NavigationDataSource {
    override suspend fun getNavigationGraph(): Result<NavigationGraph> = result
  }

  private class ThrowingNavigationDataSource(private val exception: Exception) :
    NavigationDataSource {
    override suspend fun getNavigationGraph(): Result<NavigationGraph> = throw exception
  }
}

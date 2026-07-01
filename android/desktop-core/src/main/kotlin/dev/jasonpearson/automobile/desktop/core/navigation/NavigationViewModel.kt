package dev.jasonpearson.automobile.desktop.core.navigation

import dev.jasonpearson.automobile.desktop.core.datasource.NavigationDataSource
import dev.jasonpearson.automobile.desktop.core.datasource.NavigationGraph
import dev.jasonpearson.automobile.desktop.core.datasource.Result
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

private val LOG = LoggerFactory.getLogger("NavigationViewModel")

/** UI state for the Navigation dashboard. */
sealed interface NavigationUiState {
  data object Loading : NavigationUiState

  data class Content(
      val graph: NavigationGraph,
      val selectedScreenId: String? = null,
      val currentSection: NavigationSection = NavigationSection.FlowMap,
  ) : NavigationUiState

  data class Error(val message: String) : NavigationUiState
}

/** Actions the Navigation dashboard can dispatch. */
sealed interface NavigationAction {
  data object Refresh : NavigationAction

  data class SelectScreen(val screenId: String) : NavigationAction

  data class SelectScreenByName(val screenName: String) : NavigationAction

  data object BackToFlowMap : NavigationAction

  data class UpdateGraph(val graph: NavigationGraph) : NavigationAction
}

/** One-shot effects emitted by the NavigationViewModel. */
sealed interface NavigationEffect {
  data class OpenSource(val fileName: String, val lineNumber: Int) : NavigationEffect
}

/**
 * ViewModel for the Navigation dashboard. Manages loading, state transitions, and screen selection
 * independent of Compose.
 */
class NavigationViewModel(
    private val dataSource: NavigationDataSource,
    private val scope: CoroutineScope,
) {
  private val _state = MutableStateFlow<NavigationUiState>(NavigationUiState.Loading)
  val state: StateFlow<NavigationUiState> = _state.asStateFlow()

  private val _effect = Channel<NavigationEffect>(Channel.BUFFERED)
  val effect = _effect.receiveAsFlow()

  init {
    load()
  }

  fun onAction(action: NavigationAction) {
    when (action) {
      is NavigationAction.Refresh -> load()
      is NavigationAction.SelectScreen -> selectScreen(action.screenId)
      is NavigationAction.SelectScreenByName -> selectScreenByName(action.screenName)
      is NavigationAction.BackToFlowMap -> backToFlowMap()
      is NavigationAction.UpdateGraph -> updateGraph(action.graph)
    }
  }

  private fun load() {
    _state.value = NavigationUiState.Loading
    scope.launch {
      try {
        when (val result = dataSource.getNavigationGraph()) {
          is Result.Success -> {
            LOG.info(
                "Navigation data loaded: ${result.data.screens.size} screens, ${result.data.transitions.size} transitions"
            )
            _state.value = NavigationUiState.Content(graph = result.data)
          }
          is Result.Error -> {
            LOG.warn("Failed to load navigation data: ${result.message}")
            _state.value = NavigationUiState.Error(message = result.message ?: "Unknown error")
          }
          is Result.Loading -> {
            // Keep loading state
          }
        }
      } catch (e: Exception) {
        LOG.error("Exception loading navigation data", e)
        _state.value = NavigationUiState.Error(message = e.message ?: "Unknown error")
      }
    }
  }

  private fun selectScreen(screenId: String) {
    _state.update { current ->
      (current as? NavigationUiState.Content)?.copy(
          selectedScreenId = screenId,
          currentSection = NavigationSection.ScreenDetail,
      ) ?: current
    }
  }

  private fun selectScreenByName(screenName: String) {
    _state.update { current ->
      if (current is NavigationUiState.Content) {
        val screen = current.graph.screens.find { it.name == screenName }
        if (screen != null) {
          current.copy(
              selectedScreenId = screen.id,
              currentSection = NavigationSection.ScreenDetail,
          )
        } else {
          current
        }
      } else {
        current
      }
    }
  }

  private fun backToFlowMap() {
    _state.update { current ->
      (current as? NavigationUiState.Content)?.copy(
          selectedScreenId = null,
          currentSection = NavigationSection.FlowMap,
      ) ?: current
    }
  }

  private fun updateGraph(graph: NavigationGraph) {
    _state.update { current ->
      if (current is NavigationUiState.Content) {
        current.copy(graph = graph)
      } else {
        NavigationUiState.Content(graph = graph)
      }
    }
  }
}

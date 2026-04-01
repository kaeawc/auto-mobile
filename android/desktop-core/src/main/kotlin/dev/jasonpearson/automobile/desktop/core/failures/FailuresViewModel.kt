package dev.jasonpearson.automobile.desktop.core.failures

import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch

private val LOG = LoggerFactory.getLogger("FailuresViewModel")

/**
 * UI state for the Failures dashboard.
 */
sealed interface FailuresUiState {
    data object Loading : FailuresUiState
    data class Content(
        val failureGroups: List<FailureGroup>,
        val selectedFailure: FailureGroup? = null,
        val filterType: FailureType? = null,
    ) : FailuresUiState
    data class Error(val message: String) : FailuresUiState
}

/**
 * Actions the Failures dashboard can dispatch.
 */
sealed interface FailuresAction {
    data object Refresh : FailuresAction
    data class SelectFailure(val failure: FailureGroup) : FailuresAction
    data object ClearSelection : FailuresAction
    data class FilterByType(val type: FailureType?) : FailuresAction
    data class SelectFailureById(val failureId: String) : FailuresAction
    data class UpdateGroups(val groups: List<FailureGroup>) : FailuresAction
}

/**
 * One-shot effects emitted by the FailuresViewModel.
 */
sealed interface FailuresEffect {
    data class OpenStackTrace(val fileName: String, val lineNumber: Int) : FailuresEffect
    data class NavigateToScreen(val screenName: String) : FailuresEffect
    data class NavigateToTest(val testName: String) : FailuresEffect
}

/**
 * ViewModel for the Failures dashboard. Manages loading, filtering, and selection
 * independent of Compose.
 */
class FailuresViewModel(
    private val dataSource: FailuresDataSource,
    private val scope: CoroutineScope,
) {
    private val _state = MutableStateFlow<FailuresUiState>(FailuresUiState.Loading)
    val state: StateFlow<FailuresUiState> = _state.asStateFlow()

    private val _effect = Channel<FailuresEffect>(Channel.BUFFERED)
    val effect = _effect.receiveAsFlow()

    init {
        load()
    }

    fun onAction(action: FailuresAction) {
        when (action) {
            is FailuresAction.Refresh -> load()
            is FailuresAction.SelectFailure -> selectFailure(action.failure)
            is FailuresAction.ClearSelection -> clearSelection()
            is FailuresAction.FilterByType -> filterByType(action.type)
            is FailuresAction.SelectFailureById -> selectFailureById(action.failureId)
            is FailuresAction.UpdateGroups -> updateGroups(action.groups)
        }
    }

    private fun load() {
        _state.value = FailuresUiState.Loading
        scope.launch {
            try {
                when (val result = dataSource.getFailureGroups()) {
                    is DataSourceResult.Success -> {
                        LOG.info("Failures loaded: ${result.data.size} groups")
                        _state.value = FailuresUiState.Content(failureGroups = result.data)
                    }
                    is DataSourceResult.Error -> {
                        LOG.warn("Failed to load failures: ${result.message}")
                        _state.value = FailuresUiState.Error(message = result.message)
                    }
                }
            } catch (e: Exception) {
                LOG.error("Exception loading failures", e)
                _state.value = FailuresUiState.Error(message = e.message ?: "Unknown error")
            }
        }
    }

    private fun selectFailure(failure: FailureGroup) {
        val current = _state.value
        if (current is FailuresUiState.Content) {
            _state.value = current.copy(selectedFailure = failure)
        }
    }

    private fun clearSelection() {
        val current = _state.value
        if (current is FailuresUiState.Content) {
            _state.value = current.copy(selectedFailure = null)
        }
    }

    private fun filterByType(type: FailureType?) {
        val current = _state.value
        if (current is FailuresUiState.Content) {
            _state.value = current.copy(filterType = type)
        }
    }

    private fun selectFailureById(failureId: String) {
        val current = _state.value
        if (current is FailuresUiState.Content) {
            val target = current.failureGroups.find { it.id == failureId }
            if (target != null) {
                _state.value = current.copy(selectedFailure = target)
            }
        }
    }

    private fun updateGroups(groups: List<FailureGroup>) {
        val current = _state.value
        if (current is FailuresUiState.Content) {
            _state.value = current.copy(failureGroups = groups)
        } else {
            _state.value = FailuresUiState.Content(failureGroups = groups)
        }
    }
}

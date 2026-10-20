package dev.jasonpearson.automobile.desktop.core.failures

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.desktop.core.daemon.FailuresPushSocketClient
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import dev.jasonpearson.automobile.desktop.core.datasource.Result
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

@Composable
internal fun rememberFailuresMemory(initialSelectedFailureId: String?): FailuresMemory {
  val retryCounterState = remember { mutableIntStateOf(0) }
  val failureGroupsState = remember { mutableStateOf<List<FailureGroup>>(emptyList()) }
  val isLoadingState = remember { mutableStateOf(true) }
  val errorMessageState = remember { mutableStateOf<String?>(null) }
  val selectedFailureState = remember { mutableStateOf<FailureGroup?>(null) }
  val filterTypeState = remember { mutableStateOf<FailureType?>(null) }
  val pendingSelectedFailureIdState = remember { mutableStateOf(initialSelectedFailureId) }
  val streamingErrorState = remember { mutableStateOf<String?>(null) }
  val reconnectAttemptState = remember { mutableIntStateOf(0) }
  return FailuresMemory(
    retryCounterState,
    failureGroupsState,
    isLoadingState,
    errorMessageState,
    selectedFailureState,
    filterTypeState,
    pendingSelectedFailureIdState,
    streamingErrorState,
    reconnectAttemptState,
  )
}

@Composable
internal fun FailuresDashboardOptions.rememberFailureSources(): FailureSources {
  // For fake mode: track the FakeFailuresDataSource for trigger button
  // Key by dataSourceMode so it's recreated when mode toggles
  val fakeDataSource =
    remember(dataSourceMode) {
      if (dataSourceMode == DataSourceMode.Fake) FakeFailuresDataSource() else null
    }

  // Create data sources
  val mockDataSource = remember { MockFailuresDataSource() }
  val mcpDataSource =
    remember(clientProvider) {
      clientProvider?.let { McpFailuresDataSource(it) }
    }
  val emptyDataSource = remember { EmptyFailuresDataSource() }

  val currentDataSource: FailuresDataSource =
    when {
      dataSourceMode == DataSourceMode.Fake -> fakeDataSource ?: mockDataSource
      mcpDataSource != null -> mcpDataSource
      else -> emptyDataSource // Show empty data in Real mode when MCP not available
    }

  // Determine streaming source (fake or provided)
  val activeStreamingSource: StreamingFailuresDataSourceInterface? =
    when {
      dataSourceMode == DataSourceMode.Fake -> fakeDataSource
      else -> streamingDataSource
    }

  return FailureSources(fakeDataSource, currentDataSource, activeStreamingSource)
}

@Composable
internal fun FailuresDashboardOptions.rememberDashboardPushClient(): FailuresPushSocketClient? {
  val sessionReady = sessionUuidProvider == null || sessionUuidProvider.invoke() != null
  val pushClient =
    failuresPushClient
      ?: remember(dataSourceMode, sessionUuidProvider, sessionReady) {
        if (dataSourceMode == DataSourceMode.Real && sessionReady) {
          pushClientFactory(sessionUuidProvider)
        } else null
      }

  return pushClient
}

@Composable
internal fun FailuresDashboardOptions.LoadFailures(
  memory: FailuresMemory,
  currentDataSource: FailuresDataSource,
) {
  with(memory) {
    LaunchedEffect(currentDataSource, dataSourceMode, retryCounter) {
      isLoading = true
      errorMessage = null
      when (val result = currentDataSource.getFailureGroups()) {
        is Result.Success -> {
          failureGroups = result.data
          isLoading = false
        }
        is Result.Error -> {
          errorMessage = result.message
          isLoading = false
        }
        is Result.Loading -> {
          /* keep loading state */
        }
      }
    }
  }
}

@Composable
internal fun FailuresDashboardOptions.SelectPendingFailure(memory: FailuresMemory) {
  with(memory) {
    LaunchedEffect(pendingSelectedFailureId, failureGroups) {
      val targetId = pendingSelectedFailureId ?: return@LaunchedEffect
      if (failureGroups.isEmpty()) return@LaunchedEffect

      val targetFailure = failureGroups.find { it.id == targetId }
      if (targetFailure != null) {
        selectedFailure = targetFailure
        pendingSelectedFailureId = null
        onFailureSelected?.invoke()
      }
    }
  }
}

@Composable
internal fun FailuresDashboardOptions.CollectFailureGroups(
  memory: FailuresMemory,
  activeStreamingSource: StreamingFailuresDataSourceInterface?,
) {
  with(memory) {
    LaunchedEffect(activeStreamingSource) {
      if (activeStreamingSource == null) return@LaunchedEffect

      activeStreamingSource.failureGroupsFlow().collect { result ->
        when (result) {
          is Result.Success -> {
            failureGroups = result.data.groups
          }
          is Result.Error -> {
            // Don't override main error, streaming updates are supplementary
          }
          is Result.Loading -> {
            /* waiting for data */
          }
        }
      }
    }
  }
}

@Composable
internal fun FailuresDashboardOptions.RefreshPushedFailures(
  memory: FailuresMemory,
  pushClient: FailuresPushSocketClient?,
  currentDataSource: FailuresDataSource,
) {
  with(memory) {
    LaunchedEffect(pushClient, currentDataSource, dataSourceMode) {
      val connected = pushClient ?: return@LaunchedEffect
      if (dataSourceMode == DataSourceMode.Real) {
        connected.failureNotifications.collectLatest {
          // Refresh failure groups when we receive a push notification
          when (val result = currentDataSource.getFailureGroups()) {
            is Result.Success -> {
              failureGroups = result.data
            }
            is Result.Error -> {
              // Don't overwrite error message on refresh failures
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
internal fun FailuresDashboardOptions.FailuresBody(
  memory: FailuresMemory,
  sources: FailureSources,
  pushClient: FailuresPushSocketClient?,
  scope: kotlinx.coroutines.CoroutineScope,
  modifier: Modifier,
) {
  val currentDataSource = sources.current
  val fakeDataSource = sources.fake
  with(memory) {
    Column(modifier = modifier.fillMaxSize().padding(16.dp)) {
      val selected = selectedFailure
      if (selected != null) {
        FailureDetailView(
          failure = selected,
          onBack = { selectedFailure = null },
          onNavigateToScreen = onNavigateToScreen,
          onNavigateToTest = onNavigateToTest,
          onNavigateToSource = onNavigateToSource,
        )
      } else {
        FailureListView(
          failures = failureGroups,
          filterType = filterType,
          onFilterChanged = { filterType = it },
          onFailureSelected = { selectedFailure = it },
          options =
            FailureListOptions(
              isLoading = isLoading,
              errorMessage = errorMessage,
              streamingError = streamingError,
              onRetry = { retryCounter++ },
              dataSource = currentDataSource,
              dataSourceMode = dataSourceMode,
              fakeDataSource = fakeDataSource,
              onTriggerFakeFailure = {
                scope.launch {
                  fakeDataSource?.triggerNewFailure()
                }
              },
              pushClient = pushClient,
              initialDateRange = initialDateRange,
              onDateRangeChanged = onDateRangeChanged,
              onFailureCountsChanged = onFailureCountsChanged,
            ),
        )
      }
    }
  }
}

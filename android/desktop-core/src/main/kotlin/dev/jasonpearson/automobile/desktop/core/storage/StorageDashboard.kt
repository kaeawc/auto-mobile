package dev.jasonpearson.automobile.desktop.core.storage

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.McpConnectionException
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStream
import dev.jasonpearson.automobile.desktop.core.daemon.StorageStreamUpdate
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import dev.jasonpearson.automobile.desktop.core.datasource.Result
import dev.jasonpearson.automobile.desktop.core.datasource.StorageDataSource
import dev.jasonpearson.automobile.desktop.core.di.LocalAutoMobileGraph
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import java.io.IOException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers

internal val STORAGE_DASHBOARD_LOG = LoggerFactory.getLogger("StorageDashboard")

/** How long a live-changed entry stays highlighted in the key-value inspector. */
internal const val HIGHLIGHT_DURATION_MS = 2000L
internal const val STORAGE_RECONCILIATION_INITIAL_RETRY_MS = 250L
internal const val STORAGE_RECONCILIATION_MAX_RETRY_MS = 5_000L

/** Storage tab options. */
enum class StorageTab(val title: String, val icon: String) {
  Database("Databases", "\uD83D\uDDC4"), // File cabinet
  KeyValue("Key-Value", "\uD83D\uDD11"), // Key
}

/** Main Storage Dashboard with Database and Key-Value tabs. */
data class StorageDashboardOptions(
  val modifier: Modifier = Modifier,
  val dataSourceMode: DataSourceMode = DataSourceMode.Fake,
  val clientProvider: (() -> AutoMobileClient)? = null,
  val deviceId: String? = null,
  val packageName: String? = null,
  val platform: StoragePlatform = StoragePlatform.Android,
  val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
  val observationStreamClient: ObservationStream? = null, // Shared stream for live storage changes
)

@Composable
fun StorageDashboard(options: StorageDashboardOptions = StorageDashboardOptions()) {
  with(options) {
    var selectedTab by remember { mutableStateOf(StorageTab.Database) }

    val data =
      remember(dataSourceMode, clientProvider, deviceId, packageName) { StorageDashboardData() }
    val live = remember(deviceId, packageName) { StorageLiveUpdates() }
    val currentDataSource by rememberUpdatedState(data.dataSource)
    StorageUpdatesEffect(options, data, live)
    StorageSubscriptionsEffect(options, data)
    StorageSubscriptionResponsesEffect(options, data, live)
    StorageReconnectEffect(options, data, live)
    StorageReconciliationEffect(options, data, live) { currentDataSource }
    StorageHighlightExpiryEffect(live)
    StorageInitialDataEffect(options, data)
    StorageDashboardBody(options, data, live, selectedTab) { selectedTab = it }
  }
}

internal class StorageDashboardData {
  var dataSource by mutableStateOf<StorageDataSource?>(null)
  var databases by mutableStateOf<List<DatabaseInfo>>(emptyList())
  var keyValueFiles by mutableStateOf<List<KeyValueFile>>(emptyList())
  var isLoading by mutableStateOf(true)
  var databaseError by mutableStateOf<Result.Error?>(null)
  var keyValueError by mutableStateOf<Result.Error?>(null)
}

internal class StorageLiveUpdates {
  var highlightExpiries by mutableStateOf<Map<String, Long>>(emptyMap())
  var storageUpdateGenerations by mutableStateOf<Map<String, Long>>(emptyMap())
  var storageFileUpdateGenerations by mutableStateOf<Map<String, Long>>(emptyMap())
  var storageReconciliationStartGenerations by mutableStateOf<Map<String, Long>>(emptyMap())
  var storageUpdateHistory by
    mutableStateOf<Map<String, List<Pair<Long, StorageStreamUpdate>>>>(emptyMap())
  val handledStorageSubscriptionRequestIds = mutableSetOf<String>()
  var lastStorageSequence by mutableStateOf<Long?>(null)
  var storageReconciliationFailureCount by mutableStateOf(0)
  val pendingStorageReconciliationFiles = mutableSetOf<String>()
  val storageReconciliationSignal =
    kotlinx.coroutines.channels.Channel<Unit>(kotlinx.coroutines.channels.Channel.CONFLATED)
}

@Composable
private fun StorageInitialDataEffect(options: StorageDashboardOptions, data: StorageDashboardData) {
  val graph = LocalAutoMobileGraph.current
  with(options) {
    with(data) {
      LaunchedEffect(dataSourceMode, clientProvider, deviceId, packageName) {
        STORAGE_DASHBOARD_LOG.info(
          "StorageDashboard LaunchedEffect: mode=$dataSourceMode, clientProvider=${if (clientProvider != null) "present" else "null"}, deviceId=$deviceId, packageName=$packageName",
        )
        isLoading = true
        databaseError = null
        keyValueError = null
        kotlinx.coroutines.withContext(ioDispatcher) {
          try {
            val newDataSource =
              graph.dataSourceFactory.createStorageDataSource(
                dataSourceMode,
                clientProvider,
                deviceId,
                packageName,
                platform,
              )
            dataSource = newDataSource
            STORAGE_DASHBOARD_LOG.info(
              "StorageDashboard: Created data source: ${newDataSource::class.simpleName}",
            )

            loadStorageDatabases(data, newDataSource)

            loadStorageKeyValueFiles(data, newDataSource)
          } catch (e: McpConnectionException) {
            storageFetchFailed(data, e)
          } catch (e: IOException) {
            storageFetchFailed(data, e)
          } catch (e: IllegalArgumentException) {
            storageFetchFailed(data, e)
          }
        }
      }
    }
  }
}

private suspend fun loadStorageDatabases(data: StorageDashboardData, source: StorageDataSource) {
  with(data) {
    // Fetch databases
    when (val result = source.getDatabases()) {
      is Result.Success -> {
        STORAGE_DASHBOARD_LOG.info(
          "StorageDashboard: getDatabases success, count=${result.data.size}",
        )
        databases = result.data
      }
      is Result.Error -> {
        STORAGE_DASHBOARD_LOG.warn("StorageDashboard: getDatabases error: ${result.message}")
        databaseError = result
      }
      is Result.Loading -> {
        // Keep loading state
      }
    }
  }
}

private suspend fun loadStorageKeyValueFiles(
  data: StorageDashboardData,
  source: StorageDataSource,
) {
  with(data) {
    // Fetch key-value files
    STORAGE_DASHBOARD_LOG.info("StorageDashboard: Calling getKeyValueFiles...")
    when (val result = source.getKeyValueFiles()) {
      is Result.Success -> {
        STORAGE_DASHBOARD_LOG.info(
          "StorageDashboard: getKeyValueFiles success, count=${result.data.size}",
        )
        result.data.forEach { file ->
          STORAGE_DASHBOARD_LOG.info(
            "StorageDashboard:   File: ${file.name}, entries=${file.entries.size}",
          )
        }
        keyValueFiles = result.data
        isLoading = false
      }
      is Result.Error -> {
        STORAGE_DASHBOARD_LOG.warn("StorageDashboard: getKeyValueFiles error: ${result.message}")
        keyValueError = result
        isLoading = false
      }
      is Result.Loading -> {
        // Keep loading state
      }
    }
  }
}

private fun storageFetchFailed(data: StorageDashboardData, error: Exception) {
  STORAGE_DASHBOARD_LOG.error("StorageDashboard: Exception during data fetch", error)
  data.databaseError = Result.Error(error, error.message ?: "Unknown error")
  data.keyValueError = Result.Error(error, error.message ?: "Unknown error")
  data.isLoading = false
}

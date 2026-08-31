package dev.jasonpearson.automobile.desktop.core.storage

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStream
import dev.jasonpearson.automobile.desktop.core.daemon.StorageStreamUpdate
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import dev.jasonpearson.automobile.desktop.core.datasource.Result
import dev.jasonpearson.automobile.desktop.core.datasource.StorageDataSource
import dev.jasonpearson.automobile.desktop.core.di.LocalAutoMobileGraph
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

private val LOG = LoggerFactory.getLogger("StorageDashboard")

/** How long a live-changed entry stays highlighted in the key-value inspector. */
private const val HIGHLIGHT_DURATION_MS = 2000L
private const val STORAGE_RECONCILIATION_INITIAL_RETRY_MS = 250L
private const val STORAGE_RECONCILIATION_MAX_RETRY_MS = 5_000L

/** Storage tab options. */
enum class StorageTab(val title: String, val icon: String) {
  Database("Databases", "\uD83D\uDDC4"), // File cabinet
  KeyValue("Key-Value", "\uD83D\uDD11"), // Key
}

/** Main Storage Dashboard with Database and Key-Value tabs. */
@Composable
fun StorageDashboard(
  modifier: Modifier = Modifier,
  dataSourceMode: DataSourceMode = DataSourceMode.Fake,
  clientProvider: (() -> AutoMobileClient)? = null,
  deviceId: String? = null,
  packageName: String? = null,
  platform: StoragePlatform = StoragePlatform.Android,
  observationStreamClient: ObservationStream? = null, // Shared stream for live storage changes
) {
  val graph = LocalAutoMobileGraph.current
  val colors = SharedTheme.globalColors
  var selectedTab by remember { mutableStateOf(StorageTab.Database) }

  // Fetch storage data from data source
  var dataSource by remember { mutableStateOf<StorageDataSource?>(null) }
  val currentDataSource by rememberUpdatedState(dataSource)
  var databases by remember { mutableStateOf<List<DatabaseInfo>>(emptyList()) }
  var keyValueFiles by remember { mutableStateOf<List<KeyValueFile>>(emptyList()) }
  var isLoading by remember { mutableStateOf(true) }
  var error by remember { mutableStateOf<String?>(null) }

  // Live key/value changes pushed by the daemon. Highlight expiry is tracked per key rather than
  // as one shared deadline, so a later change can't cut short an earlier key's highlight.
  var highlightExpiries by remember { mutableStateOf<Map<String, Long>>(emptyMap()) }
  // Incremented for every live update per key. An optimistic save snapshots its key's generation
  // before suspending, so an A -> B -> A update sequence cannot be mistaken for "unchanged".
  var storageUpdateGenerations by
    remember(deviceId, packageName) { mutableStateOf<Map<String, Long>>(emptyMap()) }
  // Each post-subscription snapshot records its starting generation, then replays entries added
  // here while the read is in flight. This closes the snapshot→observer gap without losing an
  // external write that arrives during reconciliation.
  var storageFileUpdateGenerations by
    remember(deviceId, packageName) { mutableStateOf<Map<String, Long>>(emptyMap()) }
  var storageReconciliationStartGenerations by
    remember(deviceId, packageName) { mutableStateOf<Map<String, Long>>(emptyMap()) }
  var storageUpdateHistory by
    remember(deviceId, packageName) {
      mutableStateOf<Map<String, List<Pair<Long, StorageStreamUpdate>>>>(emptyMap())
    }
  val handledStorageSubscriptionRequestIds =
    remember(deviceId, packageName) { mutableSetOf<String>() }
  var lastStorageSequence by remember(deviceId, packageName) { mutableStateOf<Long?>(null) }
  var storageReconciliationFailureCount by remember(deviceId, packageName) { mutableStateOf(0) }
  val pendingStorageReconciliationFiles = remember(deviceId, packageName) { mutableSetOf<String>() }
  val storageReconciliationSignal =
    remember(deviceId, packageName) {
      kotlinx.coroutines.channels.Channel<Unit>(kotlinx.coroutines.channels.Channel.CONFLATED)
    }
  val recentlyChangedKeys = highlightExpiries.keys

  LaunchedEffect(observationStreamClient, deviceId, packageName) {
    if (observationStreamClient == null) return@LaunchedEffect

    observationStreamClient.storageUpdates.collect { update ->
      // The stream is device-scoped but not package-scoped, so filter to the inspected app.
      if (deviceId != null && update.deviceId != null && update.deviceId != deviceId) {
        return@collect
      }
      if (packageName != null && update.packageName != packageName) return@collect

      if (update.sequenceNumber > 0L) {
        val sequenceRegressed =
          hasStorageSequenceRegressed(lastStorageSequence, update.sequenceNumber)
        if (
          sequenceRegressed || hasStorageSequenceGap(lastStorageSequence, update.sequenceNumber)
        ) {
          // The SDK sequence is process-global across preference files. A missing number may
          // belong to any loaded file, so reconcile all of them rather than guessing from the
          // first post-gap event. A regression means the app process restarted and its local
          // sequence reset; writes during that restart gap likewise require a fresh snapshot.
          pendingStorageReconciliationFiles.addAll(keyValueFiles.map { it.name })
          storageReconciliationSignal.trySend(Unit)
        }
        lastStorageSequence =
          if (sequenceRegressed) {
            update.sequenceNumber
          } else {
            maxOf(lastStorageSequence ?: 0L, update.sequenceNumber)
          }
      }

      val filePresent = keyValueFiles.any { it.name == update.fileName }
      val newlyHighlighted = update.highlightKeys(keyValueFiles)
      keyValueFiles = keyValueFiles.applyStorageUpdate(update)
      if (filePresent) {
        val nextGeneration = (storageFileUpdateGenerations[update.fileName] ?: 0L) + 1L
        storageFileUpdateGenerations =
          storageFileUpdateGenerations + (update.fileName to nextGeneration)
        if (storageReconciliationStartGenerations.containsKey(update.fileName)) {
          storageUpdateHistory =
            storageUpdateHistory +
              (update.fileName to
                (storageUpdateHistory[update.fileName].orEmpty() + (nextGeneration to update)))
        }
      }
      storageUpdateGenerations =
        newlyHighlighted.fold(storageUpdateGenerations) { generations, changedKey ->
          generations + (changedKey to ((generations[changedKey] ?: 0L) + 1L))
        }
      if (newlyHighlighted.isNotEmpty()) {
        val expiresAt = System.currentTimeMillis() + HIGHLIGHT_DURATION_MS
        highlightExpiries = highlightExpiries + newlyHighlighted.associateWith { expiresAt }
      }
    }
  }

  // Register a device-side content observer for each loaded key/value file so *external* writes
  // emit
  // storage_update frames -- connecting the observation stream alone never triggers the per-file
  // subscription the daemon needs (issue #4709 review). Keyed on the file *names* rather than the
  // whole list so an entry-only change (an optimistic edit or a folded live update, which rebuild
  // the
  // list with the same paths) does not churn subscriptions; releases every subscription when the
  // facet leaves composition or the device/app changes. The stream dedups repeat subscribes.
  val subscribedFileNames = keyValueFiles.map { it.name }.distinct()
  DisposableEffect(observationStreamClient, deviceId, packageName, subscribedFileNames) {
    val stream = observationStreamClient
    val pkg = packageName
    if (stream != null && pkg != null) {
      subscribedFileNames.forEach { stream.subscribeStorage(pkg, it) }
    }
    onDispose {
      if (stream != null && pkg != null) {
        subscribedFileNames.forEach { stream.unsubscribeStorage(pkg, it) }
      }
    }
  }

  // A storage observer starts only after the daemon acknowledges this specific request. Queue its
  // file for reconciliation after that acknowledgement; a separate consumer coalesces several
  // acknowledgements into one full snapshot instead of issuing an O(N²) series of reads.
  LaunchedEffect(observationStreamClient, deviceId, packageName) {
    val stream = observationStreamClient ?: return@LaunchedEffect
    stream.storageSubscriptionResponses.collect { response ->
      if (!response.subscribe || response.key.packageName != packageName) return@collect
      if (!response.success) {
        if (!handledStorageSubscriptionRequestIds.add(response.requestId)) return@collect
        LOG.warn(
          "StorageDashboard: failed to enable live updates for ${response.key.fileName}: ${response.error}"
        )
        return@collect
      }
      val fileName = response.key.fileName
      if (keyValueFiles.none { it.name == fileName }) return@collect
      if (!handledStorageSubscriptionRequestIds.add(response.requestId)) return@collect
      pendingStorageReconciliationFiles.add(fileName)
      storageReconciliationSignal.trySend(Unit)
    }
  }

  // A runner-only reconnect recreates observers without reconnecting this desktop stream. Refresh
  // the affected file because writes made while CtrlProxy was unavailable produced no delta.
  LaunchedEffect(observationStreamClient, deviceId, packageName) {
    val stream = observationStreamClient ?: return@LaunchedEffect
    stream.storageReconciliationRequests.collect { key ->
      if (key.packageName != packageName) return@collect
      if (keyValueFiles.none { it.name == key.fileName }) return@collect
      pendingStorageReconciliationFiles.add(key.fileName)
      storageReconciliationSignal.trySend(Unit)
    }
  }

  // Reconcile every newly-active file from one snapshot. Live updates received during the read are
  // replayed afterward, so coalescing retains the snapshot-to-observer gap protection.
  LaunchedEffect(observationStreamClient, deviceId, packageName) {
    while (true) {
      storageReconciliationSignal.receive()
      kotlinx.coroutines.yield()
      val fileNames = pendingStorageReconciliationFiles.toSet()
      pendingStorageReconciliationFiles.clear()

      val activeFileNames = fileNames.filter { fileName ->
        keyValueFiles.any { it.name == fileName }
      }
      if (activeFileNames.isEmpty()) continue
      val source = currentDataSource ?: continue
      val snapshotStartGenerations = activeFileNames.associateWith { fileName ->
        storageFileUpdateGenerations[fileName] ?: 0L
      }
      storageReconciliationStartGenerations =
        storageReconciliationStartGenerations + snapshotStartGenerations
      var reconciliationSucceeded = false
      try {
        when (
          val result =
            kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
              source.getKeyValueFiles()
            }
        ) {
          is Result.Success -> {
            val filesBeforeReconciliation = keyValueFiles
            val reconciledFiles =
              activeFileNames.fold(keyValueFiles) { files, fileName ->
                val updatesSinceSnapshotStarted =
                  storageUpdateHistory[fileName]
                    .orEmpty()
                    .filter { (generation, _) ->
                      generation > (snapshotStartGenerations[fileName] ?: 0L)
                    }
                    .map { (_, update) -> update }
                files.reconcileStorageFileSnapshot(
                  result.data,
                  fileName,
                  updatesSinceSnapshotStarted,
                )
              }
            keyValueFiles = reconciledFiles
            val reconciledEntryKeys =
              changedStorageEntryKeys(
                filesBeforeReconciliation,
                reconciledFiles,
                activeFileNames,
              )
            storageUpdateGenerations =
              reconciledEntryKeys.fold(storageUpdateGenerations) { generations, changedKey ->
                generations + (changedKey to ((generations[changedKey] ?: 0L) + 1L))
              }
            reconciliationSucceeded = true
          }
          is Result.Error ->
            LOG.warn("StorageDashboard: failed to reconcile storage files: ${result.message}")
          Result.Loading -> LOG.warn("StorageDashboard: reconciliation remained loading")
        }
      } catch (e: kotlinx.coroutines.CancellationException) {
        throw e
      } catch (e: Exception) {
        LOG.warn("StorageDashboard: reconciliation failed for $activeFileNames: ${e.message}")
      } finally {
        storageReconciliationStartGenerations =
          storageReconciliationStartGenerations - activeFileNames.toSet()
        storageUpdateHistory = storageUpdateHistory - activeFileNames.toSet()
      }
      if (reconciliationSucceeded) {
        storageReconciliationFailureCount = 0
      } else {
        storageReconciliationFailureCount = (storageReconciliationFailureCount + 1).coerceAtMost(6)
        val retryDelayMs =
          minOf(
            STORAGE_RECONCILIATION_INITIAL_RETRY_MS *
              (1L shl (storageReconciliationFailureCount - 1)),
            STORAGE_RECONCILIATION_MAX_RETRY_MS,
          )
        kotlinx.coroutines.delay(retryDelayMs)
        pendingStorageReconciliationFiles.addAll(activeFileNames)
        storageReconciliationSignal.trySend(Unit)
      }
    }
  }

  // Drop highlights as they individually expire. Writing the map restarts this effect, which then
  // schedules the next-soonest expiry, so one pass per restart is enough -- no loop needed.
  LaunchedEffect(highlightExpiries) {
    val nextExpiry = highlightExpiries.values.minOrNull() ?: return@LaunchedEffect
    val waitMs = nextExpiry - System.currentTimeMillis()
    if (waitMs > 0) kotlinx.coroutines.delay(waitMs)
    highlightExpiries = highlightExpiries.filterValues { it > System.currentTimeMillis() }
  }

  LaunchedEffect(dataSourceMode, clientProvider, deviceId, packageName) {
    LOG.info(
      "StorageDashboard LaunchedEffect: mode=$dataSourceMode, clientProvider=${if (clientProvider != null) "present" else "null"}, deviceId=$deviceId, packageName=$packageName"
    )
    isLoading = true
    error = null
    kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
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
        LOG.info("StorageDashboard: Created data source: ${newDataSource::class.simpleName}")

        // Fetch databases
        when (val result = newDataSource.getDatabases()) {
          is Result.Success -> {
            LOG.info("StorageDashboard: getDatabases success, count=${result.data.size}")
            databases = result.data
          }
          is Result.Error -> {
            LOG.warn("StorageDashboard: getDatabases error: ${result.message}")
            error = result.message
          }
          is Result.Loading -> {
            // Keep loading state
          }
        }

        // Fetch key-value files
        LOG.info("StorageDashboard: Calling getKeyValueFiles...")
        when (val result = newDataSource.getKeyValueFiles()) {
          is Result.Success -> {
            LOG.info("StorageDashboard: getKeyValueFiles success, count=${result.data.size}")
            result.data.forEach { file ->
              LOG.info("StorageDashboard:   File: ${file.name}, entries=${file.entries.size}")
            }
            keyValueFiles = result.data
            isLoading = false
          }
          is Result.Error -> {
            LOG.warn("StorageDashboard: getKeyValueFiles error: ${result.message}")
            if (error == null) error = result.message
            isLoading = false
          }
          is Result.Loading -> {
            // Keep loading state
          }
        }
      } catch (e: Exception) {
        LOG.error("StorageDashboard: Exception during data fetch", e)
        error = e.message ?: "Unknown error"
        isLoading = false
      }
    }
  }

  val onFetchTableData: (suspend (String, String) -> QueryResult)? =
    remember(dataSource) {
      val ds = dataSource ?: return@remember null
      val callback: suspend (String, String) -> QueryResult = { databasePath, table ->
        when (val r = ds.getTableData(databasePath, table)) {
          is Result.Success -> r.data
          is Result.Error -> QueryResult(emptyList(), emptyList(), 0, 0, error = r.message)
          else -> QueryResult(emptyList(), emptyList(), 0, 0, error = "Failed to load data")
        }
      }
      callback
    }

  val onExecuteSQL: (suspend (String, String) -> QueryResult)? =
    remember(dataSource) {
      val ds = dataSource ?: return@remember null
      val callback: suspend (String, String) -> QueryResult = { databasePath, query ->
        when (val r = ds.executeSQL(databasePath, query)) {
          is Result.Success -> r.data
          is Result.Error -> QueryResult(emptyList(), emptyList(), 0, 0, error = r.message)
          else -> QueryResult(emptyList(), emptyList(), 0, 0, error = "Failed to execute query")
        }
      }
      callback
    }

  Column(modifier = modifier.fillMaxSize()) {
    // Tab bar
    Row(
      modifier =
        Modifier.fillMaxWidth()
          .background(colors.text.normal.copy(alpha = 0.03f))
          .padding(horizontal = 8.dp, vertical = 6.dp),
      horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      StorageTab.entries.forEach { tab ->
        val isSelected = tab == selectedTab

        Row(
          modifier =
            Modifier.clip(RoundedCornerShape(6.dp))
              .background(
                if (isSelected) colors.text.normal.copy(alpha = 0.1f) else Color.Transparent
              )
              .clickable { selectedTab = tab }
              .pointerHoverIcon(PointerIcon.Hand)
              .padding(horizontal = 14.dp, vertical = 8.dp),
          horizontalArrangement = Arrangement.spacedBy(8.dp),
          verticalAlignment = Alignment.CenterVertically,
        ) {
          Text(
            tab.icon,
            fontSize = 14.sp,
          )
          Text(
            tab.title,
            fontSize = 12.sp,
            color = if (isSelected) colors.text.normal else colors.text.normal.copy(alpha = 0.6f),
          )
        }
      }
    }

    // Content
    when (selectedTab) {
      StorageTab.Database ->
        DatabaseInspector(
          databases = databases,
          loadError = if (databases.isEmpty()) error else null,
          onFetchTableData = onFetchTableData,
          onExecuteSQL = onExecuteSQL,
          modifier = Modifier.fillMaxSize(),
        )
      StorageTab.KeyValue ->
        KeyValueInspector(
          keyValueFiles = keyValueFiles,
          onSetValue =
            dataSource?.let { ds ->
              { fileName, key, value, type ->
                // Snapshot this key's live-update generation before the suspending save. Value
                // equality is insufficient: an A -> B -> A live sequence must still win over
                // the older submitted value when the save completes.
                val generationKey = highlightKey(fileName, key)
                val preSaveGeneration = storageUpdateGenerations[generationKey] ?: 0L
                val result = ds.setKeyValue(fileName, key, value, type)
                // Optimistic local update: reflect the saved value immediately rather than leaving
                // it stale until a live storage_update frame arrives (or the facet is reopened).
                // A later frame for the same key folds in idempotently over this (#4709). No
                // highlight — a highlight signals a change that happened *under* the user, not one
                // they just made. Skipped when a concurrent live frame already advanced the key.
                if (result is Result.Success) {
                  keyValueFiles =
                    keyValueFiles.applyKeyValueEditIfGenerationUnchanged(
                      fileName,
                      key,
                      value,
                      type,
                      preSaveGeneration,
                      storageUpdateGenerations[generationKey] ?: 0L,
                    )
                }
                result
              }
            },
          recentlyChangedKeys = recentlyChangedKeys,
          modifier = Modifier.fillMaxSize(),
        )
    }
  }
}

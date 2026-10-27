package dev.jasonpearson.automobile.desktop.core.storage

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import dev.jasonpearson.automobile.desktop.core.daemon.McpConnectionException
import dev.jasonpearson.automobile.desktop.core.daemon.StorageStreamUpdate
import dev.jasonpearson.automobile.desktop.core.datasource.Result
import dev.jasonpearson.automobile.desktop.core.datasource.StorageDataSource
import java.io.IOException

@Composable
internal fun StorageUpdatesEffect(
  options: StorageDashboardOptions,
  data: StorageDashboardData,
  live: StorageLiveUpdates,
) {
  LaunchedEffect(options.observationStreamClient, options.deviceId, options.packageName) {
    if (options.observationStreamClient == null) return@LaunchedEffect

    options.observationStreamClient.storageUpdates.collect { update ->
      // The stream is device-scoped but not package-scoped, so filter to the inspected app.
      if (
        options.deviceId != null && update.deviceId != null && update.deviceId != options.deviceId
      ) {
        return@collect
      }
      if (options.packageName != null && update.packageName != options.packageName) return@collect

      applyLiveStorageUpdate(data, live, update)
    }
  }
}

@Composable
internal fun StorageSubscriptionsEffect(
  options: StorageDashboardOptions,
  data: StorageDashboardData,
) {
  val subscribedFileNames = data.keyValueFiles.map { it.name }.distinct()
  DisposableEffect(
    options.observationStreamClient,
    options.deviceId,
    options.packageName,
    options.platform,
    subscribedFileNames,
  ) {
    val stream = options.observationStreamClient
    val pkg = options.packageName
    val supportsLiveStorage = options.platform == StoragePlatform.Android
    if (supportsLiveStorage && stream != null && pkg != null) {
      subscribedFileNames.forEach { stream.subscribeStorage(pkg, it) }
    }
    onDispose {
      if (supportsLiveStorage && stream != null && pkg != null) {
        subscribedFileNames.forEach { stream.unsubscribeStorage(pkg, it) }
      }
    }
  }
}

@Composable
internal fun StorageSubscriptionResponsesEffect(
  options: StorageDashboardOptions,
  data: StorageDashboardData,
  live: StorageLiveUpdates,
) {
  LaunchedEffect(options.observationStreamClient, options.deviceId, options.packageName) {
    val stream = options.observationStreamClient ?: return@LaunchedEffect
    stream.storageSubscriptionResponses.collect { response ->
      if (!response.subscribe || response.key.packageName != options.packageName) return@collect
      if (!response.success) {
        if (!live.handledStorageSubscriptionRequestIds.add(response.requestId)) return@collect
        STORAGE_DASHBOARD_LOG.warn(
          "StorageDashboard: failed to enable live updates for ${response.key.fileName}: ${response.error}",
        )
        return@collect
      }
      val fileName = response.key.fileName
      if (data.keyValueFiles.none { it.name == fileName }) return@collect
      if (!live.handledStorageSubscriptionRequestIds.add(response.requestId)) return@collect
      live.pendingStorageReconciliationFiles.add(fileName)
      live.storageReconciliationSignal.trySend(Unit)
    }
  }
}

@Composable
internal fun StorageReconnectEffect(
  options: StorageDashboardOptions,
  data: StorageDashboardData,
  live: StorageLiveUpdates,
) {
  LaunchedEffect(options.observationStreamClient, options.deviceId, options.packageName) {
    val stream = options.observationStreamClient ?: return@LaunchedEffect
    stream.storageReconciliationRequests.collect { key ->
      if (key.packageName != options.packageName) return@collect
      if (data.keyValueFiles.none { it.name == key.fileName }) return@collect
      live.pendingStorageReconciliationFiles.add(key.fileName)
      live.storageReconciliationSignal.trySend(Unit)
    }
  }
}

@Composable
internal fun StorageReconciliationEffect(
  options: StorageDashboardOptions,
  data: StorageDashboardData,
  live: StorageLiveUpdates,
  sourceProvider: () -> StorageDataSource?,
) {
  LaunchedEffect(options.observationStreamClient, options.deviceId, options.packageName) {
    while (true) {
      live.storageReconciliationSignal.receive()
      kotlinx.coroutines.yield()
      val fileNames = live.pendingStorageReconciliationFiles.toSet()
      live.pendingStorageReconciliationFiles.clear()

      val activeFileNames = fileNames.filter { fileName ->
        data.keyValueFiles.any { it.name == fileName }
      }
      if (activeFileNames.isEmpty()) continue
      val source = sourceProvider() ?: continue
      val reconciliationSucceeded =
        reconcileStorageFiles(options, data, live, source, activeFileNames)
      if (reconciliationSucceeded) {
        live.storageReconciliationFailureCount = 0
      } else {
        live.storageReconciliationFailureCount =
          (live.storageReconciliationFailureCount + 1).coerceAtMost(6)
        val retryDelayMs =
          minOf(
            STORAGE_RECONCILIATION_INITIAL_RETRY_MS *
              (1L shl (live.storageReconciliationFailureCount - 1)),
            STORAGE_RECONCILIATION_MAX_RETRY_MS,
          )
        kotlinx.coroutines.delay(retryDelayMs)
        live.pendingStorageReconciliationFiles.addAll(activeFileNames)
        live.storageReconciliationSignal.trySend(Unit)
      }
    }
  }
}

@Composable
internal fun StorageHighlightExpiryEffect(live: StorageLiveUpdates) {
  LaunchedEffect(live.highlightExpiries) {
    val nextExpiry = live.highlightExpiries.values.minOrNull() ?: return@LaunchedEffect
    val waitMs = nextExpiry - System.currentTimeMillis()
    if (waitMs > 0) kotlinx.coroutines.delay(waitMs)
    live.highlightExpiries = live.highlightExpiries.filterValues { it > System.currentTimeMillis() }
  }
}

private fun applyLiveStorageUpdate(
  data: StorageDashboardData,
  live: StorageLiveUpdates,
  update: StorageStreamUpdate,
) {
  if (update.sequenceNumber > 0L) {
    val sequenceRegressed =
      hasStorageSequenceRegressed(live.lastStorageSequence, update.sequenceNumber)
    if (
      sequenceRegressed || hasStorageSequenceGap(live.lastStorageSequence, update.sequenceNumber)
    ) {
      // The SDK sequence is process-global across preference files. A missing number may
      // belong to any loaded file, so reconcile all of them rather than guessing from the
      // first post-gap event. A regression means the app process restarted and its local
      // sequence reset; writes during that restart gap likewise require a fresh snapshot.
      live.pendingStorageReconciliationFiles.addAll(data.keyValueFiles.map { it.name })
      live.storageReconciliationSignal.trySend(Unit)
    }
    live.lastStorageSequence =
      if (sequenceRegressed) {
        update.sequenceNumber
      } else {
        maxOf(live.lastStorageSequence ?: 0L, update.sequenceNumber)
      }
  }

  val filePresent = data.keyValueFiles.any { it.name == update.fileName }
  val newlyHighlighted = update.highlightKeys(data.keyValueFiles)
  data.keyValueFiles = data.keyValueFiles.applyStorageUpdate(update)
  if (filePresent) {
    val nextGeneration = (live.storageFileUpdateGenerations[update.fileName] ?: 0L) + 1L
    live.storageFileUpdateGenerations =
      live.storageFileUpdateGenerations + (update.fileName to nextGeneration)
    if (live.storageReconciliationStartGenerations.containsKey(update.fileName)) {
      live.storageUpdateHistory =
        live.storageUpdateHistory +
          (update.fileName to
            (live.storageUpdateHistory[update.fileName].orEmpty() + (nextGeneration to update)))
    }
  }
  live.storageUpdateGenerations =
    newlyHighlighted.fold(live.storageUpdateGenerations) { generations, changedKey ->
      generations + (changedKey to ((generations[changedKey] ?: 0L) + 1L))
    }
  if (newlyHighlighted.isNotEmpty()) {
    val expiresAt = System.currentTimeMillis() + HIGHLIGHT_DURATION_MS
    live.highlightExpiries = live.highlightExpiries + newlyHighlighted.associateWith { expiresAt }
  }
}

private fun applyReconciledStorageFiles(
  data: StorageDashboardData,
  live: StorageLiveUpdates,
  snapshot: List<KeyValueFile>,
  activeFileNames: List<String>,
  snapshotStartGenerations: Map<String, Long>,
) {
  val filesBeforeReconciliation = data.keyValueFiles
  val reconciledFiles =
    activeFileNames.fold(data.keyValueFiles) { files, fileName ->
      val updatesSinceSnapshotStarted =
        live.storageUpdateHistory[fileName]
          .orEmpty()
          .filter { (generation, _) ->
            generation > (snapshotStartGenerations[fileName] ?: 0L)
          }
          .map { (_, update) -> update }
      files.reconcileStorageFileSnapshot(
        snapshot,
        fileName,
        updatesSinceSnapshotStarted,
      )
    }
  data.keyValueFiles = reconciledFiles
  val reconciledEntryKeys =
    changedStorageEntryKeys(
      filesBeforeReconciliation,
      reconciledFiles,
      activeFileNames,
    )
  live.storageUpdateGenerations =
    reconciledEntryKeys.fold(live.storageUpdateGenerations) { generations, changedKey ->
      generations + (changedKey to ((generations[changedKey] ?: 0L) + 1L))
    }
}

private suspend fun reconcileStorageFiles(
  options: StorageDashboardOptions,
  data: StorageDashboardData,
  live: StorageLiveUpdates,
  source: StorageDataSource,
  activeFileNames: List<String>,
): Boolean {
  val snapshotStartGenerations = activeFileNames.associateWith { fileName ->
    live.storageFileUpdateGenerations[fileName] ?: 0L
  }
  live.storageReconciliationStartGenerations =
    live.storageReconciliationStartGenerations + snapshotStartGenerations
  var reconciliationSucceeded = false
  try {
    val result =
      kotlinx.coroutines.withContext(options.ioDispatcher) {
        source.getKeyValueFiles()
      }
    reconciliationSucceeded =
      applyStorageReconciliationResult(
        data,
        live,
        result,
        activeFileNames,
        snapshotStartGenerations,
      )
  } catch (e: kotlinx.coroutines.CancellationException) {
    throw e
  } catch (e: McpConnectionException) {
    STORAGE_DASHBOARD_LOG.warn(
      "StorageDashboard: reconciliation failed for $activeFileNames: ${e.message}",
    )
  } catch (e: IOException) {
    STORAGE_DASHBOARD_LOG.warn(
      "StorageDashboard: reconciliation failed for $activeFileNames: ${e.message}",
    )
  } catch (e: IllegalArgumentException) {
    STORAGE_DASHBOARD_LOG.warn(
      "StorageDashboard: reconciliation failed for $activeFileNames: ${e.message}",
    )
  } finally {
    live.storageReconciliationStartGenerations =
      live.storageReconciliationStartGenerations - activeFileNames.toSet()
    live.storageUpdateHistory = live.storageUpdateHistory - activeFileNames.toSet()
  }
  return reconciliationSucceeded
}

private fun applyStorageReconciliationResult(
  data: StorageDashboardData,
  live: StorageLiveUpdates,
  result: Result<List<KeyValueFile>>,
  activeFileNames: List<String>,
  snapshotStartGenerations: Map<String, Long>,
): Boolean =
  when (result) {
    is Result.Success -> {
      applyReconciledStorageFiles(
        data,
        live,
        result.data,
        activeFileNames,
        snapshotStartGenerations,
      )
      true
    }
    is Result.Error -> {
      STORAGE_DASHBOARD_LOG.warn(
        "StorageDashboard: failed to reconcile storage files: ${result.message}",
      )
      false
    }
    Result.Loading -> {
      STORAGE_DASHBOARD_LOG.warn("StorageDashboard: reconciliation remained loading")
      false
    }
  }

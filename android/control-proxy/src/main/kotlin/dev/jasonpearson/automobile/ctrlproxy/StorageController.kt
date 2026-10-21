package dev.jasonpearson.automobile.ctrlproxy

import android.util.Log
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.ctrlproxy.storage.PreferenceChangeEvent
import dev.jasonpearson.automobile.ctrlproxy.storage.PreferenceEntry
import dev.jasonpearson.automobile.ctrlproxy.storage.PreferenceFileInfo
import dev.jasonpearson.automobile.ctrlproxy.storage.StorageSubscriptionManager
import dev.jasonpearson.automobile.ctrlproxy.storage.buildStorageChangedMessage
import dev.jasonpearson.automobile.protocol.SetPreference
import kotlinx.coroutines.CancellationException

/**
 * SharedPreferences, DataStore and storage-subscription requests, with the late-created
 * subscription manager and the late-bound WebSocket server supplied through accessors.
 */
internal class StorageController(
  manager: () -> StorageSubscriptionManager,
  asyncActionRunner: AsyncActionRunner,
  resultSender: ResultSender,
  private val timeProvider: TimeProvider,
  private val responseSender: ResponseSender,
) : StorageRequests(manager, asyncActionRunner, resultSender, timeProvider) {
  /**
   * Carries `storage_changed` push events, which answer no request, to the late-bound WebSocket
   * server. Request results go through [ResultSender].
   */
  interface ResponseSender {
    fun isRunning(): Boolean

    suspend fun broadcast(message: String)

    fun connectionCount(): Int
  }

  companion object {
    private const val TAG = "CtrlProxy"
  }

  suspend fun broadcastStorageChange(
    event: PreferenceChangeEvent,
  ) {
    if (!responseSender.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping storage change broadcast")
      return
    }

    try {
      // Build the wire payload via the extracted, unit-tested encoder. It emits the
      // prior value so the TS telemetry ingest can skip its per-insert previous-value
      // lookup (#3000), quoting it by its OWN type so a removed/type-changed STRING
      // stays valid JSON. An absent prior value is emitted as JSON null.
      val message = buildStorageChangedMessage(event, timeProvider.currentTimeMillis())
      responseSender.broadcast(message)
      Log.d(TAG, "Broadcasted storage change to ${responseSender.connectionCount()} clients")
    } catch (e: CancellationException) {
      // Let cooperative cancellation unwind cleanly rather than logging it as an error (#3191).
      throw e
    } catch (e: Exception) {
      Log.e(TAG, "Error broadcasting storage change", e)
    }
  }
}

/** Dispatches storage requests while retaining the async error and correlation guards. */
internal open class StorageRequests(
  private val manager: () -> StorageSubscriptionManager,
  private val asyncActionRunner: AsyncActionRunner,
  resultSender: ResultSender,
  timeProvider: TimeProvider,
) : StorageResponses(resultSender, timeProvider) {
  private companion object {
    const val TAG = "CtrlProxy"
  }

  fun handleListPreferenceFiles(requestId: String?, packageName: String) {
    Log.d(TAG, "handleListPreferenceFiles: requestId=$requestId, packageName=$packageName")
    asyncActionRunner.launch(requestId, "list_preference_files") {
      Log.d(TAG, "handleListPreferenceFiles: coroutine started, calling listPreferenceFiles")
      val result = manager().listPreferenceFiles(packageName)
      Log.d(TAG, "handleListPreferenceFiles: result=$result")
      result.fold(
        onSuccess = { files ->
          Log.d(TAG, "handleListPreferenceFiles: success, files count=${files.size}")
          broadcastPreferenceFilesResult(requestId, packageName, files, null)
        },
        onFailure = { error ->
          Log.e(TAG, "handleListPreferenceFiles: failure, error=${error.message}", error)
          broadcastPreferenceFilesResult(requestId, packageName, null, error.message)
        },
      )
    }
  }

  fun handleGetPreferences(requestId: String?, packageName: String, fileName: String) {
    asyncActionRunner.launch(requestId, "get_preferences") {
      val result = manager().getPreferences(packageName, fileName)
      result.fold(
        onSuccess = { entries ->
          broadcastPreferencesResult(requestId, packageName, fileName, entries, null)
        },
        onFailure = { error ->
          broadcastPreferencesResult(requestId, packageName, fileName, null, error.message)
        },
      )
    }
  }

  fun handleListDataStores(requestId: String?, packageName: String, adapterName: String) {
    asyncActionRunner.launch(requestId, "list_data_stores") {
      val result = manager().listDataStores(packageName, adapterName)
      result.fold(
        // DataStore descriptors reuse the SharedPreferences `preference_files` result envelope
        // (StorageResponse.FileList); the awaiting TS client disambiguates by requestId.
        onSuccess = { files ->
          broadcastPreferenceFilesResult(requestId, packageName, files, null)
        },
        onFailure = { error ->
          broadcastPreferenceFilesResult(requestId, packageName, null, error.message)
        },
      )
    }
  }

  fun handleGetDataStore(
    requestId: String?,
    packageName: String,
    adapterName: String,
    storeName: String,
  ) {
    asyncActionRunner.launch(requestId, "get_data_store") {
      val result = manager().getDataStore(packageName, adapterName, storeName)
      result.fold(
        // Reuses the SharedPreferences `preferences` result envelope; storeName maps to fileName.
        onSuccess = { entries ->
          broadcastPreferencesResult(requestId, packageName, storeName, entries, null)
        },
        onFailure = { error ->
          broadcastPreferencesResult(requestId, packageName, storeName, null, error.message)
        },
      )
    }
  }

  fun handleSubscribeStorage(requestId: String?, packageName: String, fileName: String) {
    asyncActionRunner.launch(requestId, "subscribe_storage") {
      val result = manager().subscribe(packageName, fileName)
      result.fold(
        onSuccess = { subscription ->
          broadcastSubscribeStorageResult(
            requestId,
            packageName,
            fileName,
            subscription.subscriptionId,
            null,
          )
        },
        onFailure = { error ->
          broadcastSubscribeStorageResult(requestId, packageName, fileName, null, error.message)
        },
      )
    }
  }

  fun handleUnsubscribeStorage(requestId: String?, packageName: String, fileName: String) {
    asyncActionRunner.launch(requestId, "unsubscribe_storage") {
      val success = manager().unsubscribe(packageName, fileName)
      broadcastUnsubscribeStorageResult(requestId, packageName, fileName, success)
    }
  }

  fun handleGetPreference(
    requestId: String?,
    packageName: String,
    fileName: String,
    key: String,
  ) {
    asyncActionRunner.launch(requestId, "get_preference") {
      val result = manager().getPreference(packageName, fileName, key)
      result.fold(
        onSuccess = { entry ->
          broadcastGetPreferenceResult(
            GetPreferenceOutcome(
              requestId = requestId,
              packageName = packageName,
              fileName = fileName,
              key = key,
              entry = entry,
              error = null,
            ),
          )
        },
        onFailure = { error ->
          broadcastGetPreferenceResult(
            GetPreferenceOutcome(
              requestId = requestId,
              packageName = packageName,
              fileName = fileName,
              key = key,
              entry = null,
              error = error.message,
            ),
          )
        },
      )
    }
  }

  fun handleSetPreference(request: SetPreference) {
    asyncActionRunner.launch(request.requestId, "set_preference") {
      val result =
        manager()
          .setPreference(
            request.packageName,
            request.fileName,
            request.key,
            request.value,
            request.valueType,
          )
      result.fold(
        onSuccess = {
          broadcastSetPreferenceResult(
            request.requestId,
            request.packageName,
            request.fileName,
            request.key,
            null,
          )
        },
        onFailure = { error ->
          broadcastSetPreferenceResult(
            request.requestId,
            request.packageName,
            request.fileName,
            request.key,
            error.message,
          )
        },
      )
    }
  }

  fun handleRemovePreference(
    requestId: String?,
    packageName: String,
    fileName: String,
    key: String,
  ) {
    asyncActionRunner.launch(requestId, "remove_preference") {
      val result = manager().removePreference(packageName, fileName, key)
      result.fold(
        onSuccess = {
          broadcastRemovePreferenceResult(requestId, packageName, fileName, key, null)
        },
        onFailure = { error ->
          broadcastRemovePreferenceResult(requestId, packageName, fileName, key, error.message)
        },
      )
    }
  }

  fun handleClearPreferences(
    requestId: String?,
    packageName: String,
    fileName: String,
  ) {
    asyncActionRunner.launch(requestId, "clear_preferences") {
      val result = manager().clearPreferences(packageName, fileName)
      result.fold(
        onSuccess = { broadcastClearPreferencesResult(requestId, packageName, fileName, null) },
        onFailure = { error ->
          broadcastClearPreferencesResult(requestId, packageName, fileName, error.message)
        },
      )
    }
  }
}

/** Encodes and broadcasts correlated storage request results. */
internal open class StorageResponses(
  private val resultSender: ResultSender,
  private val timeProvider: TimeProvider,
) {
  private companion object {
    const val TAG = "CtrlProxy"
  }

  protected suspend fun broadcastPreferenceFilesResult(
    requestId: String?,
    packageName: String,
    files: List<PreferenceFileInfo>?,
    error: String?,
  ) {
    resultSender.sendFrame(requestId, "preference_files", attachPerf = false) { _ ->
      preferenceFilesResultFrame(
        timeProvider.currentTimeMillis(),
        requestId,
        packageName,
        files,
        error,
      )
    }
  }

  protected suspend fun broadcastPreferencesResult(
    requestId: String?,
    packageName: String,
    fileName: String,
    entries: List<PreferenceEntry>?,
    error: String?,
  ) {
    resultSender.sendFrame(requestId, "preferences", attachPerf = false) { _ ->
      preferencesResultFrame(
        timeProvider.currentTimeMillis(),
        StorageTarget(requestId, packageName, fileName),
        entries,
        error,
      )
    }
  }

  protected suspend fun broadcastSubscribeStorageResult(
    requestId: String?,
    packageName: String,
    fileName: String,
    subscriptionId: String?,
    error: String?,
  ) {
    resultSender.sendFrame(requestId, "subscribe_storage_result", attachPerf = false) { _ ->
      subscribeStorageResultFrame(
        timeProvider.currentTimeMillis(),
        StorageTarget(requestId, packageName, fileName),
        subscriptionId,
        error,
      )
    }
  }

  protected suspend fun broadcastUnsubscribeStorageResult(
    requestId: String?,
    packageName: String,
    fileName: String,
    success: Boolean,
  ) {
    resultSender.sendFrame(requestId, "unsubscribe_storage_result", attachPerf = false) { _ ->
      unsubscribeStorageResultFrame(
        timeProvider.currentTimeMillis(),
        StorageTarget(requestId, packageName, fileName),
        success,
      )
    }
  }

  protected suspend fun broadcastGetPreferenceResult(outcome: GetPreferenceOutcome) {
    resultSender.sendFrame(outcome.requestId, "get_preference_result", attachPerf = false) { _ ->
      getPreferenceResultFrame(timeProvider.currentTimeMillis(), outcome)
    }
  }

  protected suspend fun broadcastSetPreferenceResult(
    requestId: String?,
    packageName: String,
    fileName: String,
    key: String,
    error: String?,
  ) {
    resultSender.sendFrame(requestId, "set_preference_result", attachPerf = false) { _ ->
      setPreferenceResultFrame(
        timeProvider.currentTimeMillis(),
        StorageTarget(requestId, packageName, fileName),
        key,
        error,
      )
    }
  }

  protected suspend fun broadcastRemovePreferenceResult(
    requestId: String?,
    packageName: String,
    fileName: String,
    key: String,
    error: String?,
  ) {
    resultSender.sendFrame(requestId, "remove_preference_result", attachPerf = false) { _ ->
      removePreferenceResultFrame(
        timeProvider.currentTimeMillis(),
        StorageTarget(requestId, packageName, fileName),
        key,
        error,
      )
    }
  }

  protected suspend fun broadcastClearPreferencesResult(
    requestId: String?,
    packageName: String,
    fileName: String,
    error: String?,
  ) {
    resultSender.sendFrame(requestId, "clear_preferences_result", attachPerf = false) { _ ->
      clearPreferencesResultFrame(
        timeProvider.currentTimeMillis(),
        StorageTarget(requestId, packageName, fileName),
        error,
      )
    }
  }
}

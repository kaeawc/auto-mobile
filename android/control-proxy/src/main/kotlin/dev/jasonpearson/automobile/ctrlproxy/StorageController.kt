package dev.jasonpearson.automobile.ctrlproxy

import android.util.Log
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.ctrlproxy.storage.PreferenceChangeEvent
import dev.jasonpearson.automobile.ctrlproxy.storage.PreferenceEntry
import dev.jasonpearson.automobile.ctrlproxy.storage.PreferenceFileInfo
import dev.jasonpearson.automobile.ctrlproxy.storage.StorageSubscriptionManager
import dev.jasonpearson.automobile.ctrlproxy.storage.buildStorageChangedMessage
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/**
 * SharedPreferences, DataStore and storage-subscription requests, with the late-created
 * subscription manager and the late-bound WebSocket server supplied through accessors.
 */
internal class StorageController(
  private val manager: () -> StorageSubscriptionManager,
  private val asyncActionRunner: AsyncActionRunner,
  private val resultBroadcaster: ResultBroadcaster,
  private val timeProvider: TimeProvider,
  private val jsonCompact: Json,
  private val responseSender: ResponseSender,
) {
  /** Keeps the service's late-bound WebSocket server behind one seam. */
  interface ResponseSender {
    fun isRunning(): Boolean

    suspend fun broadcast(message: String)

    fun connectionCount(): Int
  }

  companion object {
    private const val TAG = "CtrlProxy"
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
          broadcastGetPreferenceResult(requestId, packageName, fileName, key, entry, null)
        },
        onFailure = { error ->
          broadcastGetPreferenceResult(requestId, packageName, fileName, key, null, error.message)
        },
      )
    }
  }

  fun handleSetPreference(
    requestId: String?,
    packageName: String,
    fileName: String,
    key: String,
    value: String?,
    type: String,
  ) {
    asyncActionRunner.launch(requestId, "set_preference") {
      val result = manager().setPreference(packageName, fileName, key, value, type)
      result.fold(
        onSuccess = { broadcastSetPreferenceResult(requestId, packageName, fileName, key, null) },
        onFailure = { error ->
          broadcastSetPreferenceResult(requestId, packageName, fileName, key, error.message)
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

  private suspend fun broadcastPreferenceFilesResult(
    requestId: String?,
    packageName: String,
    files: List<PreferenceFileInfo>?,
    error: String?,
  ) {
    if (!responseSender.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping preference files broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "preference_files") {
      val message = buildString {
        append("""{"type":"preference_files","timestamp":${timeProvider.currentTimeMillis()}""")
        if (requestId != null) {
          appendJsonStringField("requestId", requestId, jsonCompact)
        }
        append(""","packageName":${jsonCompact.encodeToString(packageName)}""")
        if (files != null) {
          append(""","success":true,"files":${jsonCompact.encodeToString(files)}""")
        } else {
          append(
            ""","success":false,"error":${jsonCompact.encodeToString(error ?: "Unknown error")}""",
          )
        }
        append("}")
      }
      responseSender.broadcast(message)
      Log.d(TAG, "Broadcasted preference files to ${responseSender.connectionCount()} clients")
    }
  }

  private suspend fun broadcastPreferencesResult(
    requestId: String?,
    packageName: String,
    fileName: String,
    entries: List<PreferenceEntry>?,
    error: String?,
  ) {
    if (!responseSender.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping preferences broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "preferences") {
      val message = buildString {
        append("""{"type":"preferences","timestamp":${timeProvider.currentTimeMillis()}""")
        if (requestId != null) {
          appendJsonStringField("requestId", requestId, jsonCompact)
        }
        append(""","packageName":${jsonCompact.encodeToString(packageName)}""")
        append(""","fileName":${jsonCompact.encodeToString(fileName)}""")
        if (entries != null) {
          append(""","success":true,"entries":${jsonCompact.encodeToString(entries)}""")
        } else {
          append(
            ""","success":false,"error":${jsonCompact.encodeToString(error ?: "Unknown error")}""",
          )
        }
        append("}")
      }
      responseSender.broadcast(message)
      Log.d(TAG, "Broadcasted preferences to ${responseSender.connectionCount()} clients")
    }
  }

  private suspend fun broadcastSubscribeStorageResult(
    requestId: String?,
    packageName: String,
    fileName: String,
    subscriptionId: String?,
    error: String?,
  ) {
    if (!responseSender.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping subscribe storage broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "subscribe_storage_result") {
      val message = buildString {
        append(
          """{"type":"subscribe_storage_result","timestamp":${timeProvider.currentTimeMillis()}""",
        )
        if (requestId != null) {
          appendJsonStringField("requestId", requestId, jsonCompact)
        }
        append(""","packageName":${jsonCompact.encodeToString(packageName)}""")
        append(""","fileName":${jsonCompact.encodeToString(fileName)}""")
        if (subscriptionId != null) {
          append(
            ""","success":true,"subscriptionId":${jsonCompact.encodeToString(subscriptionId)}""",
          )
        } else {
          append(
            ""","success":false,"error":${jsonCompact.encodeToString(error ?: "Unknown error")}""",
          )
        }
        append("}")
      }
      responseSender.broadcast(message)
      Log.d(
        TAG,
        "Broadcasted subscribe storage result to ${responseSender.connectionCount()} clients",
      )
    }
  }

  private suspend fun broadcastUnsubscribeStorageResult(
    requestId: String?,
    packageName: String,
    fileName: String,
    success: Boolean,
  ) {
    if (!responseSender.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping unsubscribe storage broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "unsubscribe_storage_result") {
      val message = buildString {
        append(
          """{"type":"unsubscribe_storage_result","timestamp":${timeProvider.currentTimeMillis()}""",
        )
        if (requestId != null) {
          appendJsonStringField("requestId", requestId, jsonCompact)
        }
        append(""","packageName":${jsonCompact.encodeToString(packageName)}""")
        append(""","fileName":${jsonCompact.encodeToString(fileName)}""")
        append(""","success":$success""")
        append("}")
      }
      responseSender.broadcast(message)
      Log.d(
        TAG,
        "Broadcasted unsubscribe storage result to ${responseSender.connectionCount()} clients",
      )
    }
  }

  private suspend fun broadcastGetPreferenceResult(
    requestId: String?,
    packageName: String,
    fileName: String,
    key: String,
    entry: PreferenceEntry?,
    error: String?,
  ) {
    if (!responseSender.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping get preference broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "get_preference_result") {
      val message = buildString {
        append(
          """{"type":"get_preference_result","timestamp":${timeProvider.currentTimeMillis()}""",
        )
        if (requestId != null) {
          appendJsonStringField("requestId", requestId, jsonCompact)
        }
        append(""","packageName":${jsonCompact.encodeToString(packageName)}""")
        append(""","fileName":${jsonCompact.encodeToString(fileName)}""")
        append(""","key":${jsonCompact.encodeToString(key)}""")
        if (error != null) {
          append(""","success":false,"found":false,"error":${jsonCompact.encodeToString(error)}""")
        } else if (entry != null) {
          append(""","success":true,"found":true""")
          if (entry.value != null) {
            append(""","value":${jsonCompact.encodeToString(entry.value)}""")
          } else {
            append(""","value":null""")
          }
          append(""","valueType":${jsonCompact.encodeToString(entry.type)}""")
        } else {
          append(""","success":true,"found":false""")
        }
        append("}")
      }
      responseSender.broadcast(message)
      Log.d(
        TAG,
        "Broadcasted get preference result to ${responseSender.connectionCount()} clients",
      )
    }
  }

  private suspend fun broadcastSetPreferenceResult(
    requestId: String?,
    packageName: String,
    fileName: String,
    key: String,
    error: String?,
  ) {
    if (!responseSender.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping set preference broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "set_preference_result") {
      val message = buildString {
        append(
          """{"type":"set_preference_result","timestamp":${timeProvider.currentTimeMillis()}""",
        )
        if (requestId != null) {
          appendJsonStringField("requestId", requestId, jsonCompact)
        }
        append(""","packageName":${jsonCompact.encodeToString(packageName)}""")
        append(""","fileName":${jsonCompact.encodeToString(fileName)}""")
        append(""","key":${jsonCompact.encodeToString(key)}""")
        if (error != null) {
          append(""","success":false,"error":${jsonCompact.encodeToString(error)}""")
        } else {
          append(""","success":true""")
        }
        append("}")
      }
      responseSender.broadcast(message)
      Log.d(
        TAG,
        "Broadcasted set preference result to ${responseSender.connectionCount()} clients",
      )
    }
  }

  private suspend fun broadcastRemovePreferenceResult(
    requestId: String?,
    packageName: String,
    fileName: String,
    key: String,
    error: String?,
  ) {
    if (!responseSender.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping remove preference broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "remove_preference_result") {
      val message = buildString {
        append(
          """{"type":"remove_preference_result","timestamp":${timeProvider.currentTimeMillis()}""",
        )
        if (requestId != null) {
          appendJsonStringField("requestId", requestId, jsonCompact)
        }
        append(""","packageName":${jsonCompact.encodeToString(packageName)}""")
        append(""","fileName":${jsonCompact.encodeToString(fileName)}""")
        append(""","key":${jsonCompact.encodeToString(key)}""")
        if (error != null) {
          append(""","success":false,"error":${jsonCompact.encodeToString(error)}""")
        } else {
          append(""","success":true""")
        }
        append("}")
      }
      responseSender.broadcast(message)
      Log.d(
        TAG,
        "Broadcasted remove preference result to ${responseSender.connectionCount()} clients",
      )
    }
  }

  private suspend fun broadcastClearPreferencesResult(
    requestId: String?,
    packageName: String,
    fileName: String,
    error: String?,
  ) {
    if (!responseSender.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping clear preferences broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "clear_preferences_result") {
      val message = buildString {
        append(
          """{"type":"clear_preferences_result","timestamp":${timeProvider.currentTimeMillis()}""",
        )
        if (requestId != null) {
          appendJsonStringField("requestId", requestId, jsonCompact)
        }
        append(""","packageName":${jsonCompact.encodeToString(packageName)}""")
        append(""","fileName":${jsonCompact.encodeToString(fileName)}""")
        if (error != null) {
          append(""","success":false,"error":${jsonCompact.encodeToString(error)}""")
        } else {
          append(""","success":true""")
        }
        append("}")
      }
      responseSender.broadcast(message)
      Log.d(
        TAG,
        "Broadcasted clear preferences result to ${responseSender.connectionCount()} clients",
      )
    }
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
      val message =
        buildStorageChangedMessage(
          event,
          timeProvider.currentTimeMillis(),
          jsonCompact,
        )
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

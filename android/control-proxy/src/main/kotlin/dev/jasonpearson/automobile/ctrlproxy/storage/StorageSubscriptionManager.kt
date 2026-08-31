package dev.jasonpearson.automobile.ctrlproxy.storage

import android.content.Context
import android.database.ContentObserver
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import dev.jasonpearson.automobile.protocol.StorageProtocolSerializer
import dev.jasonpearson.automobile.protocol.StorageResponse
import java.util.ArrayDeque
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow

/**
 * Manages subscriptions to SharedPreferences changes across multiple target apps.
 *
 * Uses ContentProvider.call() to communicate with SDK-instrumented apps and ContentObserver to
 * receive push notifications when changes occur.
 */
class StorageSubscriptionManager(private val context: Context) {

  companion object {
    private const val TAG = "StorageSubscriptionMgr"
    private const val AUTHORITY_SUFFIX = ".automobile.sharedprefs"
    private const val CHANGES_PATH = "changes"
    private const val STORAGE_EVENT_BUFFER_CAPACITY = 64
  }

  /** State for a single subscription. */
  private data class SubscriptionState(
    val subscription: StorageSubscription,
    var lastSequence: Long = 0,
  )

  /** State for a package being observed. */
  private data class PackageObserverState(
    val observer: ContentObserver,
    // Thread-safe: mutated on IO (subscribe/unsubscribe) and read on the main
    // looper (ContentObserver.onChange -> fetchChangesForPackage). See #3600.
    val subscriptions: MutableSet<String> = ConcurrentHashMap.newKeySet(), // file names
  )

  private data class PackageEventBuffer(
    val events: ArrayDeque<PreferenceChangeEvent> = ArrayDeque()
  )

  // Mutated from Dispatchers.IO (subscribe/unsubscribe) and the main looper
  // (ContentObserver.onChange, destroy). ConcurrentHashMap avoids the
  // resize-under-concurrent-put corruption / ConcurrentModificationException a
  // plain HashMap would hit here (#3600).
  private val subscriptions =
    ConcurrentHashMap<String, SubscriptionState>() // subscriptionId -> state
  private val packageObservers =
    ConcurrentHashMap<String, PackageObserverState>() // packageName -> state

  // Bound events independently per package. If one package overflows, its newest event is retained
  // and exposes the sequence gap needed for snapshot recovery; unrelated packages cannot hide it.
  private val changeEventBuffers = ConcurrentHashMap<String, PackageEventBuffer>()
  private val changeEventSignal = Channel<Unit>(Channel.CONFLATED)
  val changeEvents: Flow<PreferenceChangeEvent> = flow {
    for (ignored in changeEventSignal) {
      while (true) {
        val events = takeChangeEventBatch()
        if (events.isEmpty()) break
        for (event in events) emit(event)
      }
    }
  }

  private val handler = Handler(Looper.getMainLooper())

  /**
   * Checks if the SDK is available and inspection is enabled for a package.
   *
   * @param packageName The target app package name
   * @return Result with availability info or error
   */
  fun checkSdkAvailability(packageName: String): Result<SdkAvailabilityInfo> {
    return try {
      val authority = packageName + AUTHORITY_SUFFIX
      val uri = Uri.parse("content://$authority")
      val result = context.contentResolver.call(uri, "checkAvailability", null, null)

      if (result == null) {
        Result.failure(StorageError.SdkNotInstalled(packageName))
      } else if (!result.getBoolean("success", false)) {
        val error = result.getString("error") ?: "Unknown error"
        val errorType = result.getString("errorType") ?: "UNKNOWN"
        if (errorType == "DISABLED") {
          Result.failure(StorageError.InspectionDisabled(packageName))
        } else {
          Result.failure(StorageError.SdkError(error))
        }
      } else {
        val responseJson = result.getString("result") ?: "{}"
        val response = StorageProtocolSerializer.responseFromJson(responseJson)
        when (response) {
          is StorageResponse.Availability ->
            Result.success(
              SdkAvailabilityInfo(
                available = response.available,
                version = response.version,
              )
            )
          else -> Result.failure(StorageError.SdkError("Unexpected response type"))
        }
      }
    } catch (e: SecurityException) {
      Result.failure(StorageError.SdkNotInstalled(packageName))
    } catch (e: IllegalArgumentException) {
      Result.failure(StorageError.SdkNotInstalled(packageName))
    } catch (e: Exception) {
      Log.e(TAG, "Error checking SDK availability for $packageName", e)
      Result.failure(StorageError.SdkError(e.message ?: "Unknown error"))
    }
  }

  /**
   * Lists all SharedPreferences files in a package.
   *
   * @param packageName The target app package name
   * @return Result with list of preference file info or error
   */
  fun listPreferenceFiles(packageName: String): Result<List<PreferenceFileInfo>> {
    Log.d(TAG, "listPreferenceFiles: packageName=$packageName")
    return try {
      val authority = packageName + AUTHORITY_SUFFIX
      val uri = Uri.parse("content://$authority")
      Log.d(TAG, "listPreferenceFiles: calling contentResolver.call with authority=$authority")
      val result = context.contentResolver.call(uri, "listFiles", null, null)
      Log.d(TAG, "listPreferenceFiles: contentResolver.call returned, result=$result")

      if (result == null) {
        Log.w(TAG, "listPreferenceFiles: result is null (SDK not installed)")
        Result.failure(StorageError.SdkNotInstalled(packageName))
      } else if (!result.getBoolean("success", false)) {
        val error = result.getString("error") ?: "Unknown error"
        Log.w(TAG, "listPreferenceFiles: result.success=false, error=$error")
        Result.failure(StorageError.SdkError(error))
      } else {
        val responseJson = result.getString("result") ?: "{}"
        Log.d(TAG, "listPreferenceFiles: responseJson=$responseJson")
        val response = StorageProtocolSerializer.responseFromJson(responseJson)
        Log.d(
          TAG,
          "listPreferenceFiles: parsed response type=${response?.let { it::class.simpleName } ?: "null"}",
        )
        when (response) {
          is StorageResponse.FileList -> {
            val files =
              response.files.map { file ->
                PreferenceFileInfo(
                  name = file.name,
                  path = file.path,
                  entryCount = file.entryCount,
                )
              }
            Log.d(TAG, "listPreferenceFiles: returning ${files.size} files")
            Result.success(files)
          }
          else -> {
            Log.w(
              TAG,
              "listPreferenceFiles: unexpected response type: ${response?.let { it::class.simpleName } ?: "null"}",
            )
            Result.failure(StorageError.SdkError("Unexpected response type"))
          }
        }
      }
    } catch (e: SecurityException) {
      Log.e(TAG, "listPreferenceFiles: SecurityException (SDK not installed)", e)
      Result.failure(StorageError.SdkNotInstalled(packageName))
    } catch (e: Exception) {
      Log.e(TAG, "Error listing preference files for $packageName", e)
      Result.failure(StorageError.SdkError(e.message ?: "Unknown error"))
    }
  }

  /**
   * Gets all preferences from a file.
   *
   * @param packageName The target app package name
   * @param fileName The preferences file name
   * @return Result with list of preference entries or error
   */
  fun getPreferences(packageName: String, fileName: String): Result<List<PreferenceEntry>> {
    return try {
      val authority = packageName + AUTHORITY_SUFFIX
      val uri = Uri.parse("content://$authority")
      val extras = Bundle().apply { putString("fileName", fileName) }
      val result = context.contentResolver.call(uri, "getPreferences", null, extras)

      if (result == null) {
        Result.failure(StorageError.SdkNotInstalled(packageName))
      } else if (!result.getBoolean("success", false)) {
        val error = result.getString("error") ?: "Unknown error"
        val errorType = result.getString("errorType")
        if (errorType == "FileNotFound") {
          Result.failure(StorageError.FileNotFound(fileName))
        } else {
          Result.failure(StorageError.SdkError(error))
        }
      } else {
        val responseJson = result.getString("result") ?: "{}"
        val response = StorageProtocolSerializer.responseFromJson(responseJson)
        when (response) {
          is StorageResponse.Preferences -> {
            val entries =
              response.entries.map { entry ->
                PreferenceEntry(
                  key = entry.key,
                  value = entry.value,
                  type = entry.type,
                )
              }
            Result.success(entries)
          }
          else -> Result.failure(StorageError.SdkError("Unexpected response type"))
        }
      }
    } catch (e: SecurityException) {
      Result.failure(StorageError.SdkNotInstalled(packageName))
    } catch (e: Exception) {
      Log.e(TAG, "Error getting preferences for $packageName:$fileName", e)
      Result.failure(StorageError.SdkError(e.message ?: "Unknown error"))
    }
  }

  /**
   * Lists the Jetpack DataStore instances exposed by a host-registered adapter (issue #5573).
   *
   * DataStore is served through the same storage-inspection ContentProvider as SharedPreferences
   * (authority [AUTHORITY_SUFFIX]); the provider routes the `listDataStores` method to the
   * host-registered adapter and returns descriptors in the shared [StorageResponse.FileList] shape
   * (path emitted empty — no filesystem path is exposed for DataStore).
   *
   * @param packageName The target app package name
   * @param adapterName The stable name the host registered its DataStore adapter under
   * @return Result with list of DataStore descriptors (as [PreferenceFileInfo]) or error
   */
  fun listDataStores(packageName: String, adapterName: String): Result<List<PreferenceFileInfo>> {
    return try {
      val authority = packageName + AUTHORITY_SUFFIX
      val uri = Uri.parse("content://$authority")
      val extras = Bundle().apply { putString("adapterName", adapterName) }
      val result = context.contentResolver.call(uri, "listDataStores", null, extras)

      if (result == null) {
        Result.failure(StorageError.SdkNotInstalled(packageName))
      } else if (!result.getBoolean("success", false)) {
        val error = result.getString("error") ?: "Unknown error"
        Result.failure(StorageError.SdkError(error))
      } else {
        val responseJson = result.getString("result") ?: "{}"
        val response = StorageProtocolSerializer.responseFromJson(responseJson)
        when (response) {
          is StorageResponse.FileList -> {
            val files =
              response.files.map { file ->
                PreferenceFileInfo(name = file.name, path = file.path, entryCount = file.entryCount)
              }
            Result.success(files)
          }
          else -> Result.failure(StorageError.SdkError("Unexpected response type"))
        }
      }
    } catch (e: SecurityException) {
      Log.e(TAG, "listDataStores: SecurityException (SDK not installed)", e)
      Result.failure(StorageError.SdkNotInstalled(packageName))
    } catch (e: Exception) {
      Log.e(TAG, "Error listing data stores for $packageName (adapter=$adapterName)", e)
      Result.failure(StorageError.SdkError(e.message ?: "Unknown error"))
    }
  }

  /**
   * Reads all entries from a named DataStore instance (issue #5573).
   *
   * Reuses the shared [StorageResponse.Preferences] response shape.
   *
   * @param packageName The target app package name
   * @param adapterName The stable name the host registered its DataStore adapter under
   * @param storeName The DataStore instance name
   * @return Result with list of entries (as [PreferenceEntry]) or error
   */
  fun getDataStore(
    packageName: String,
    adapterName: String,
    storeName: String,
  ): Result<List<PreferenceEntry>> {
    return try {
      val authority = packageName + AUTHORITY_SUFFIX
      val uri = Uri.parse("content://$authority")
      val extras =
        Bundle().apply {
          putString("adapterName", adapterName)
          putString("storeName", storeName)
        }
      val result = context.contentResolver.call(uri, "getDataStore", null, extras)

      if (result == null) {
        Result.failure(StorageError.SdkNotInstalled(packageName))
      } else if (!result.getBoolean("success", false)) {
        val error = result.getString("error") ?: "Unknown error"
        val errorType = result.getString("errorType")
        if (errorType == "StoreNotFound") {
          Result.failure(StorageError.FileNotFound(storeName))
        } else {
          Result.failure(StorageError.SdkError(error))
        }
      } else {
        val responseJson = result.getString("result") ?: "{}"
        val response = StorageProtocolSerializer.responseFromJson(responseJson)
        when (response) {
          is StorageResponse.Preferences -> {
            val entries =
              response.entries.map { entry ->
                PreferenceEntry(key = entry.key, value = entry.value, type = entry.type)
              }
            Result.success(entries)
          }
          else -> Result.failure(StorageError.SdkError("Unexpected response type"))
        }
      }
    } catch (e: SecurityException) {
      Result.failure(StorageError.SdkNotInstalled(packageName))
    } catch (e: Exception) {
      Log.e(TAG, "Error getting data store for $packageName:$storeName (adapter=$adapterName)", e)
      Result.failure(StorageError.SdkError(e.message ?: "Unknown error"))
    }
  }

  /**
   * Subscribes to changes on a SharedPreferences file.
   *
   * @param packageName The target app package name
   * @param fileName The preferences file name
   * @return Result with subscription info or error
   */
  fun subscribe(packageName: String, fileName: String): Result<StorageSubscription> {
    val subscriptionId = "$packageName:$fileName"

    // Check if already subscribed
    if (subscriptions.containsKey(subscriptionId)) {
      return Result.success(subscriptions[subscriptionId]!!.subscription)
    }

    return try {
      val authority = packageName + AUTHORITY_SUFFIX
      val uri = Uri.parse("content://$authority")
      val extras = Bundle().apply { putString("fileName", fileName) }
      val result = context.contentResolver.call(uri, "subscribeToFile", null, extras)

      if (result == null) {
        Result.failure(StorageError.SdkNotInstalled(packageName))
      } else if (!result.getBoolean("success", false)) {
        val error = result.getString("error") ?: "Unknown error"
        Result.failure(StorageError.SdkError(error))
      } else {
        val subscription = StorageSubscription(packageName, fileName, subscriptionId)

        // Do not claim success until the local observer is active. Otherwise a registration
        // failure leaves an entry that makes later retries falsely report an existing observer.
        val observerRegistration = registerPackageObserver(packageName, fileName)
        val observerRegistrationError = observerRegistration.exceptionOrNull()
        if (observerRegistrationError != null) {
          try {
            context.contentResolver.call(uri, "unsubscribeFromFile", null, extras)
          } catch (rollbackError: Exception) {
            Log.w(TAG, "Failed to roll back SDK subscription for $subscriptionId", rollbackError)
          }
          return Result.failure(observerRegistrationError)
        }

        // Track the subscription after the observer exists, so a retry can repair a failed setup.
        val existing = subscriptions.putIfAbsent(subscriptionId, SubscriptionState(subscription))
        if (existing != null) {
          return Result.success(existing.subscription)
        }

        Log.d(TAG, "Subscribed to $subscriptionId")
        Result.success(subscription)
      }
    } catch (e: SecurityException) {
      Result.failure(StorageError.SdkNotInstalled(packageName))
    } catch (e: Exception) {
      Log.e(TAG, "Error subscribing to $packageName:$fileName", e)
      Result.failure(StorageError.SdkError(e.message ?: "Unknown error"))
    }
  }

  /**
   * Unsubscribes from changes on a SharedPreferences file.
   *
   * @param packageName The target app package name
   * @param fileName The preferences file name
   * @return true once the subscription is absent (including when it was already absent)
   */
  fun unsubscribe(packageName: String, fileName: String): Boolean {
    val subscriptionId = "$packageName:$fileName"

    if (!subscriptions.containsKey(subscriptionId)) {
      return true
    }

    try {
      val authority = packageName + AUTHORITY_SUFFIX
      val uri = Uri.parse("content://$authority")
      val extras = Bundle().apply { putString("fileName", fileName) }
      context.contentResolver.call(uri, "unsubscribeFromFile", null, extras)
    } catch (e: Exception) {
      Log.w(TAG, "Error unsubscribing from SDK (may be expected if app was uninstalled)", e)
    }

    // Remove the subscription
    subscriptions.remove(subscriptionId)

    // Unregister package observer if no more subscriptions for this package
    unregisterPackageObserverIfUnused(packageName, fileName)

    Log.d(TAG, "Unsubscribed from $subscriptionId")
    return true
  }

  /** Returns all active subscriptions. */
  fun getActiveSubscriptions(): List<StorageSubscription> {
    return subscriptions.values.map { it.subscription }
  }

  /**
   * Gets a single preference value by key.
   *
   * @param packageName The target app package name
   * @param fileName The preferences file name
   * @param key The key to retrieve
   * @return Result with the preference entry (null if key not found) or error
   */
  fun getPreference(packageName: String, fileName: String, key: String): Result<PreferenceEntry?> {
    return try {
      val authority = packageName + AUTHORITY_SUFFIX
      val uri = Uri.parse("content://$authority")
      val extras =
        Bundle().apply {
          putString("fileName", fileName)
          putString("key", key)
        }
      val result = context.contentResolver.call(uri, "getPreference", null, extras)

      if (result == null) {
        Result.failure(StorageError.SdkNotInstalled(packageName))
      } else if (!result.getBoolean("success", false)) {
        val error = result.getString("error") ?: "Unknown error"
        val errorType = result.getString("errorType")
        if (errorType == "FileNotFound") {
          Result.failure(StorageError.FileNotFound(fileName))
        } else {
          Result.failure(StorageError.SdkError(error))
        }
      } else {
        val responseJson = result.getString("result") ?: "{}"
        val response = StorageProtocolSerializer.responseFromJson(responseJson)
        when (response) {
          is StorageResponse.SinglePreference -> {
            val entry =
              response.entry?.let {
                PreferenceEntry(
                  key = it.key,
                  value = it.value,
                  type = it.type,
                )
              }
            Result.success(entry)
          }
          else -> Result.failure(StorageError.SdkError("Unexpected response type"))
        }
      }
    } catch (e: SecurityException) {
      Result.failure(StorageError.SdkNotInstalled(packageName))
    } catch (e: Exception) {
      Log.e(TAG, "Error getting preference for $packageName:$fileName:$key", e)
      Result.failure(StorageError.SdkError(e.message ?: "Unknown error"))
    }
  }

  /**
   * Sets a preference value.
   *
   * @param packageName The target app package name
   * @param fileName The preferences file name
   * @param key The key to set
   * @param value The serialized value (or null)
   * @param type The type of the value (STRING, INT, LONG, FLOAT, BOOLEAN, STRING_SET)
   * @return Result with success or error
   */
  fun setPreference(
    packageName: String,
    fileName: String,
    key: String,
    value: String?,
    type: String,
  ): Result<Unit> {
    return try {
      val authority = packageName + AUTHORITY_SUFFIX
      val uri = Uri.parse("content://$authority")
      val extras =
        Bundle().apply {
          putString("fileName", fileName)
          putString("key", key)
          if (value != null) putString("value", value)
          putString("type", type)
        }
      val result = context.contentResolver.call(uri, "setValue", null, extras)

      if (result == null) {
        Result.failure(StorageError.SdkNotInstalled(packageName))
      } else if (!result.getBoolean("success", false)) {
        val error = result.getString("error") ?: "Unknown error"
        val errorType = result.getString("errorType")
        if (errorType == "FileNotFound") {
          Result.failure(StorageError.FileNotFound(fileName))
        } else {
          Result.failure(StorageError.SdkError(error))
        }
      } else {
        Log.d(TAG, "Set preference $packageName:$fileName:$key")
        Result.success(Unit)
      }
    } catch (e: SecurityException) {
      Result.failure(StorageError.SdkNotInstalled(packageName))
    } catch (e: Exception) {
      Log.e(TAG, "Error setting preference for $packageName:$fileName:$key", e)
      Result.failure(StorageError.SdkError(e.message ?: "Unknown error"))
    }
  }

  /**
   * Removes a preference value.
   *
   * @param packageName The target app package name
   * @param fileName The preferences file name
   * @param key The key to remove
   * @return Result with success or error
   */
  fun removePreference(packageName: String, fileName: String, key: String): Result<Unit> {
    return try {
      val authority = packageName + AUTHORITY_SUFFIX
      val uri = Uri.parse("content://$authority")
      val extras =
        Bundle().apply {
          putString("fileName", fileName)
          putString("key", key)
        }
      val result = context.contentResolver.call(uri, "removeValue", null, extras)

      if (result == null) {
        Result.failure(StorageError.SdkNotInstalled(packageName))
      } else if (!result.getBoolean("success", false)) {
        val error = result.getString("error") ?: "Unknown error"
        val errorType = result.getString("errorType")
        if (errorType == "FileNotFound") {
          Result.failure(StorageError.FileNotFound(fileName))
        } else {
          Result.failure(StorageError.SdkError(error))
        }
      } else {
        Log.d(TAG, "Removed preference $packageName:$fileName:$key")
        Result.success(Unit)
      }
    } catch (e: SecurityException) {
      Result.failure(StorageError.SdkNotInstalled(packageName))
    } catch (e: Exception) {
      Log.e(TAG, "Error removing preference for $packageName:$fileName:$key", e)
      Result.failure(StorageError.SdkError(e.message ?: "Unknown error"))
    }
  }

  /**
   * Clears all preferences in a file.
   *
   * @param packageName The target app package name
   * @param fileName The preferences file name
   * @return Result with success or error
   */
  fun clearPreferences(packageName: String, fileName: String): Result<Unit> {
    return try {
      val authority = packageName + AUTHORITY_SUFFIX
      val uri = Uri.parse("content://$authority")
      val extras =
        Bundle().apply {
          putString("fileName", fileName)
        }
      val result = context.contentResolver.call(uri, "clearFile", null, extras)

      if (result == null) {
        Result.failure(StorageError.SdkNotInstalled(packageName))
      } else if (!result.getBoolean("success", false)) {
        val error = result.getString("error") ?: "Unknown error"
        val errorType = result.getString("errorType")
        if (errorType == "FileNotFound") {
          Result.failure(StorageError.FileNotFound(fileName))
        } else {
          Result.failure(StorageError.SdkError(error))
        }
      } else {
        Log.d(TAG, "Cleared preferences $packageName:$fileName")
        Result.success(Unit)
      }
    } catch (e: SecurityException) {
      Result.failure(StorageError.SdkNotInstalled(packageName))
    } catch (e: Exception) {
      Log.e(TAG, "Error clearing preferences for $packageName:$fileName", e)
      Result.failure(StorageError.SdkError(e.message ?: "Unknown error"))
    }
  }

  /** Cleans up all subscriptions and observers. Call when the service is destroyed. */
  fun destroy() {
    // Unsubscribe from all. Resolve ids through the same canonical parse the inbound
    // unsubscribe_storage dispatch uses, so the "packageName:fileName" format has one inverse.
    subscriptions.keys.toList().forEach { subscriptionId ->
      StorageSubscription.parseId(subscriptionId)?.let { (packageName, fileName) ->
        unsubscribe(packageName, fileName)
      }
    }

    // Clear any remaining state
    subscriptions.clear()
    packageObservers.clear()
    changeEventSignal.close()
  }

  // Create-or-merge and remove-if-unused run through ConcurrentHashMap.compute so the
  // whole check-then-act is atomic per package. Two files of one package subscribing
  // concurrently on Dispatchers.IO would otherwise both observe no entry, register
  // separate ContentObservers, and overwrite the map with single-file state — leaking
  // the losing observer and dropping changes for its file (Codex #4709 review). compute
  // holds the per-bin lock for the key, so the second caller sees the first's state and
  // only merges its file name; it also serializes register against a concurrent
  // remove-if-unused for the same package.
  private fun registerPackageObserver(packageName: String, fileName: String): Result<Unit> {
    var registrationError: Exception? = null
    packageObservers.compute(packageName) { _, existing ->
      if (existing != null) {
        existing.subscriptions.add(fileName)
        return@compute existing
      }

      val authority = packageName + AUTHORITY_SUFFIX
      val changesUri = Uri.parse("content://$authority/$CHANGES_PATH")

      val observer =
        object : ContentObserver(handler) {
          override fun onChange(selfChange: Boolean) {
            super.onChange(selfChange)
            Log.d(TAG, "ContentObserver notified for $packageName")
            fetchChangesForPackage(packageName)
          }
        }

      try {
        context.contentResolver.registerContentObserver(changesUri, false, observer)
        Log.d(TAG, "Registered ContentObserver for $packageName")
        PackageObserverState(
          observer,
          ConcurrentHashMap.newKeySet<String>().apply { add(fileName) },
        )
      } catch (e: Exception) {
        Log.e(TAG, "Failed to register ContentObserver for $packageName", e)
        registrationError = e
        // Leave the package unmapped so a later subscribe can retry.
        null
      }
    }
    return registrationError?.let {
      Result.failure(StorageError.SdkError("Failed to register observer: ${it.message}"))
    } ?: Result.success(Unit)
  }

  private fun unregisterPackageObserverIfUnused(packageName: String, fileName: String) {
    packageObservers.compute(packageName) { _, state ->
      if (state == null) return@compute null
      state.subscriptions.remove(fileName)

      if (state.subscriptions.isEmpty()) {
        try {
          context.contentResolver.unregisterContentObserver(state.observer)
          Log.d(TAG, "Unregistered ContentObserver for $packageName")
        } catch (e: Exception) {
          Log.w(TAG, "Error unregistering ContentObserver", e)
        }
        // Returning null removes the mapping.
        null
      } else {
        state
      }
    }
  }

  private fun fetchChangesForPackage(packageName: String) {
    val state = packageObservers[packageName] ?: return
    val authority = packageName + AUTHORITY_SUFFIX
    val uri = Uri.parse("content://$authority")

    for (fileName in state.subscriptions.toList()) {
      val subscriptionId = "$packageName:$fileName"
      val subState = subscriptions[subscriptionId] ?: continue

      try {
        val extras =
          Bundle().apply {
            putString("fileName", fileName)
            putLong("sinceSequence", subState.lastSequence)
          }
        val result = context.contentResolver.call(uri, "getChanges", null, extras)

        if (result != null && result.getBoolean("success", false)) {
          val responseJson = result.getString("result") ?: "{}"
          val response = StorageProtocolSerializer.responseFromJson(responseJson)

          if (response is StorageResponse.Changes) {
            for (change in response.changes) {
              val event =
                PreferenceChangeEvent(
                  packageName = packageName,
                  fileName = fileName,
                  key = change.key,
                  value = change.value,
                  type = change.type,
                  timestamp = change.timestamp,
                  sequenceNumber = change.sequenceNumber,
                  previousValue = change.previousValue,
                  previousValueType = change.previousValueType,
                )

              if (!enqueueChangeEvent(event)) {
                Log.w(TAG, "Stopping storage-change fetch after event delivery channel closed")
                return
              }
              subState.lastSequence = maxOf(subState.lastSequence, change.sequenceNumber)
            }
          }
        }
      } catch (e: Exception) {
        Log.e(TAG, "Error fetching changes for $packageName:$fileName", e)
      }
    }
  }

  private fun enqueueChangeEvent(event: PreferenceChangeEvent): Boolean {
    val buffer = changeEventBuffers.computeIfAbsent(event.packageName) { PackageEventBuffer() }
    synchronized(buffer) {
      if (buffer.events.size == STORAGE_EVENT_BUFFER_CAPACITY) {
        buffer.events.removeFirst()
      }
      buffer.events.addLast(event)
    }
    return changeEventSignal.trySend(Unit).isSuccess
  }

  private fun takeChangeEventBatch(): List<PreferenceChangeEvent> =
    changeEventBuffers.values.mapNotNull { buffer ->
      synchronized(buffer) {
        buffer.events.pollFirst()
      }
    }
}

/** Information about SDK availability. */
data class SdkAvailabilityInfo(
  val available: Boolean,
  val version: Int,
)

/** Errors that can occur during storage operations. */
sealed class StorageError(message: String) : Exception(message) {
  class SdkNotInstalled(packageName: String) :
    StorageError("SDK not installed in package: $packageName")

  class InspectionDisabled(packageName: String) :
    StorageError("SharedPreferences inspection is disabled in: $packageName")

  class FileNotFound(fileName: String) : StorageError("Preferences file not found: $fileName")

  class SdkError(message: String) : StorageError(message)
}

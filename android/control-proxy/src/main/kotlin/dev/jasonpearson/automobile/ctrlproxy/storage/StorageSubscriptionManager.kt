package dev.jasonpearson.automobile.ctrlproxy.storage

import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import dev.jasonpearson.automobile.protocol.StorageChangeEvent
import dev.jasonpearson.automobile.protocol.StorageProtocolSerializer
import dev.jasonpearson.automobile.protocol.StorageResponse
import java.util.ArrayDeque
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.coroutineContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Manages subscriptions to SharedPreferences changes across multiple target apps.
 *
 * Uses ContentProvider.call() to communicate with SDK-instrumented apps and ContentObserver to
 * receive push notifications when changes occur.
 */
class StorageSubscriptionManager(
  private val context: Context,
  private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
  scope: CoroutineScope = CoroutineScope(SupervisorJob() + ioDispatcher),
  private val backgroundCalls: BackgroundCalls = ContentResolverCalls(context, ioDispatcher),
  private val cleanupTimeoutMs: Long = 1_000L,
  // Waits between the first and the single retry of a DISABLED subscribe reply. Injected so tests
  // run without a wall-clock sleep; the subscribe path already blocks a background worker.
  private val retryDelayMs: Long = DISABLED_RETRY_DELAY_MS,
  private val pause: (Long) -> Unit = { Thread.sleep(it) },
  private val nowMs: () -> Long = { System.nanoTime() / 1_000_000L },
) {

  /**
   * Suspendable boundary for background provider calls, including deterministic cancellation tests.
   */
  fun interface BackgroundCalls {
    suspend fun call(uri: Uri, method: String, extras: Bundle): Bundle?
  }

  private class ContentResolverCalls(
    private val context: Context,
    private val dispatcher: CoroutineDispatcher,
  ) : BackgroundCalls {
    override suspend fun call(uri: Uri, method: String, extras: Bundle): Bundle? =
      runInterruptible(dispatcher) { context.contentResolver.call(uri, method, null, extras) }
  }

  // Only local bookkeeping takes this lock. No target-app provider call may hold it.
  private val lifecycleLock = Any()
  @Volatile private var destroyed = false
  private val fetchScope =
    CoroutineScope(
      scope.coroutineContext + SupervisorJob(scope.coroutineContext[Job]) + ioDispatcher
    )
  // Cleanup must survive both fetch cancellation and cancellation of the owning service scope.
  private val cleanupContext = scope.coroutineContext.minusKey(Job) + ioDispatcher

  companion object {
    private const val TAG = "StorageSubscriptionMgr"
    private const val AUTHORITY_SUFFIX = ".automobile.sharedprefs"
    private const val CHANGES_PATH = "changes"
    private const val STORAGE_EVENT_BUFFER_CAPACITY = 64
    private const val DISABLED_RETRY_DELAY_MS = 500L
    // Keep launch guidance through multiple SDK startup intervals, then allow genuine disables.
    private const val REFUSED_START_WINDOW_MS = DISABLED_RETRY_DELAY_MS * 20
    private const val MAX_REFUSED_START_PACKAGES = 64
  }

  /** State for a single subscription. */
  private data class SubscriptionState(
    val subscription: StorageSubscription,
    // The cursor and token describe the inspected app's current process: its in-memory sequence
    // counter restarts at 1 whenever the app does, so both are reset on a detected restart
    // (#10069).
    @Volatile var lastSequence: Long = 0,
    @Volatile var processToken: String? = null,
    // Set when a restart was detected but the app's listener has not been re-armed yet (the
    // re-arm call failed or the app vanished again). The next fetch for this file retries it.
    @Volatile var needsRearm: Boolean = false,
  )

  /** State for a package being observed. */
  private data class PackageObserverState(
    val observer: ContentObserver,
    val signals: Channel<Unit>,
    val worker: Job,
    val subscriptions: MutableSet<String> = ConcurrentHashMap.newKeySet(), // file names
  )

  private data class SubscriptionEventBuffer(
    val events: ArrayDeque<PreferenceChangeEvent> = ArrayDeque()
  )

  // Mutated from request and fetch workers and the main looper (destroy).
  // ConcurrentHashMap avoids the
  // resize-under-concurrent-put corruption / ConcurrentModificationException a
  // plain HashMap would hit here (#3600).
  private val subscriptions =
    ConcurrentHashMap<String, SubscriptionState>() // subscriptionId -> state
  private val subscriptionLocks = ConcurrentHashMap<String, Any>()
  private val packageObservers =
    ConcurrentHashMap<String, PackageObserverState>() // packageName -> state

  // Guarded by lifecycleLock, oldest entries evicted first. Retain launch guidance briefly because
  // DISABLED cannot distinguish SDK startup from an intentional disable; never claim the app is
  // currently stopped.
  private val refusedStartPackages = linkedMapOf<String, Long>()

  // Bound events independently per subscribed file. If one file overflows, its newest event is
  // retained and exposes the sequence gap needed for snapshot recovery; unrelated files cannot
  // hide it.
  private val changeEventBuffers = ConcurrentHashMap<String, SubscriptionEventBuffer>()
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
    val lock =
      synchronized(lifecycleLock) {
        if (destroyed) {
          return Result.failure(StorageError.SdkError("Storage subscription manager is destroyed"))
        }
        subscriptionLocks.computeIfAbsent(subscriptionId) { Any() }
      }
    return synchronized(lock) { subscribeLocked(packageName, fileName, subscriptionId) }
  }

  private fun subscribeLocked(
    packageName: String,
    fileName: String,
    subscriptionId: String,
  ): Result<StorageSubscription> {
    // Always ask the app to (re-)arm its listener: the app-side half of a subscription lives in
    // the app process and is gone after a restart even though this local entry survives (#10069).
    // The SDK treats a repeat for an already-listening file as a no-op.
    val token =
      requestSubscribeToFile(packageName, fileName).getOrElse {
        return Result.failure(it)
      }
    subscriptions[subscriptionId]?.let { existing ->
      if (isProcessRestartOnResubscribe(existing.processToken, token)) {
        Log.i(TAG, "Inspected app restarted; resetting storage sequence for $subscriptionId")
        existing.lastSequence = 0
      }
      existing.processToken = token
      existing.needsRearm = false
      return Result.success(existing.subscription)
    }

    val subscription = StorageSubscription(packageName, fileName, subscriptionId)

    // Do not claim success until the local observer is active. Otherwise a registration
    // failure leaves an entry that makes later retries falsely report an existing observer.
    val observerRegistration =
      synchronized(lifecycleLock) {
        if (destroyed) {
          Result.failure(StorageError.SdkError("Storage subscription manager is destroyed"))
        } else {
          registerPackageObserver(packageName, fileName).also { registration ->
            if (registration.isSuccess) {
              subscriptions[subscriptionId] = SubscriptionState(subscription, processToken = token)
            }
          }
        }
      }
    val observerRegistrationError = observerRegistration.exceptionOrNull()
    if (observerRegistrationError != null) {
      rollBackSubscribeToFile(packageName, fileName, subscriptionId)
      return Result.failure(observerRegistrationError)
    }

    Log.d(TAG, "Subscribed to $subscriptionId")
    return Result.success(subscription)
  }

  /** Outcome of one `subscribeToFile` provider call. */
  private class SubscribeCall(val result: Result<String?>, val disabled: Boolean = false)

  /**
   * Calls the SDK's `subscribeToFile`; the success value is the app's process token, if any.
   *
   * A provider call into an app without a process starts that process, and can land before the app
   * has enabled inspection; the SDK then answers DISABLED although it is embedded and enabled
   * (#10210). That happens after a force-stop, a swipe-away, a low-memory kill, a crash or a reboot
   * alike, so the stopped flag cannot tell the cases apart. Retry once after a short delay (the
   * first call already started the process) before reporting anything about the app.
   */
  private fun requestSubscribeToFile(packageName: String, fileName: String): Result<String?> {
    // Read before the call: the call itself starts the process and clears the stopped state.
    val wasStopped = isPackageStopped(packageName)
    val first = callSubscribeToFile(packageName, fileName)
    if (first.disabled && !pauseBeforeRetry()) return first.result
    val outcome = if (first.disabled) callSubscribeToFile(packageName, fileName) else first
    synchronized(lifecycleLock) {
      if (!outcome.disabled) {
        refusedStartPackages.remove(packageName)
      } else if (!destroyed) {
        if (wasStopped) {
          refusedStartPackages[packageName] = nowMs()
          if (refusedStartPackages.size > MAX_REFUSED_START_PACKAGES) {
            refusedStartPackages.remove(refusedStartPackages.keys.first())
          }
        }
        val startedAtMs = refusedStartPackages[packageName]
        if (startedAtMs != null && nowMs() - startedAtMs <= REFUSED_START_WINDOW_MS) {
          return Result.failure(StorageError.AppStartedByRequest(packageName))
        }
        if (startedAtMs != null) refusedStartPackages.remove(packageName)
      }
    }
    return outcome.result
  }

  private fun pauseBeforeRetry(): Boolean =
    try {
      pause(retryDelayMs)
      true
    } catch (e: InterruptedException) {
      // Shutting down: keep the interrupt for the caller and report the first reply as it was.
      Thread.currentThread().interrupt()
      false
    }

  private fun callSubscribeToFile(packageName: String, fileName: String): SubscribeCall {
    return try {
      val authority = packageName + AUTHORITY_SUFFIX
      val uri = Uri.parse("content://$authority")
      val extras = Bundle().apply { putString("fileName", fileName) }
      val result = context.contentResolver.call(uri, "subscribeToFile", null, extras)

      if (result == null) {
        SubscribeCall(Result.failure(StorageError.SdkNotInstalled(packageName)))
      } else if (!result.getBoolean("success", false)) {
        val error = result.getString("error") ?: "Unknown error"
        SubscribeCall(
          Result.failure(StorageError.SdkError(error)),
          disabled = result.getString("errorType") == "DISABLED",
        )
      } else {
        val response = result.getString("result")?.let(StorageProtocolSerializer::responseFromJson)
        SubscribeCall(
          Result.success((response as? StorageResponse.SubscriptionResult)?.processToken)
        )
      }
    } catch (e: SecurityException) {
      SubscribeCall(Result.failure(StorageError.SdkNotInstalled(packageName)))
    } catch (e: Exception) {
      Log.e(TAG, "Error subscribing to $packageName:$fileName", e)
      SubscribeCall(Result.failure(StorageError.SdkError(e.message ?: "Unknown error")))
    }
  }

  /**
   * True when [packageName] is installed but in the stopped state (force-stopped, never launched),
   * i.e. it has no process. False when it is running, not installed, or not visible to the runner.
   */
  private fun isPackageStopped(packageName: String): Boolean =
    try {
      @Suppress("DEPRECATION")
      val flags = context.packageManager.getApplicationInfo(packageName, 0).flags
      flags and ApplicationInfo.FLAG_STOPPED != 0
    } catch (e: PackageManager.NameNotFoundException) {
      // Not installed or not visible: the provider call reports that itself, so no stopped hint.
      Log.d(TAG, "No package info for $packageName: ${e.message}")
      false
    }

  private fun rollBackSubscribeToFile(
    packageName: String,
    fileName: String,
    subscriptionId: String,
  ) {
    try {
      val uri = Uri.parse("content://$packageName$AUTHORITY_SUFFIX")
      val extras = Bundle().apply { putString("fileName", fileName) }
      context.contentResolver.call(uri, "unsubscribeFromFile", null, extras)
    } catch (rollbackError: Exception) {
      Log.w(TAG, "Failed to roll back SDK subscription for $subscriptionId", rollbackError)
    }
  }

  /**
   * A repeat subscribe restarts the sequence cursor unless the app proves it is the same process.
   * Resetting is safe even when it is not a restart: the SDK drops changes from its queue once
   * delivered, so reading from 0 returns only undelivered changes.
   */
  private fun isProcessRestartOnResubscribe(known: String?, reported: String?): Boolean =
    known == null || reported == null || known != reported

  /**
   * Unsubscribes from changes on a SharedPreferences file.
   *
   * @param packageName The target app package name
   * @param fileName The preferences file name
   * @return true once the subscription is absent (including when it was already absent)
   */
  fun unsubscribe(packageName: String, fileName: String): Boolean {
    val subscriptionId = "$packageName:$fileName"
    val lock =
      synchronized(lifecycleLock) {
        if (destroyed) return true
        subscriptionLocks.computeIfAbsent(subscriptionId) { Any() }
      }
    return synchronized(lock) { unsubscribeLocked(packageName, fileName, subscriptionId) }
  }

  private fun unsubscribeLocked(
    packageName: String,
    fileName: String,
    subscriptionId: String,
  ): Boolean {
    synchronized(lifecycleLock) {
      refusedStartPackages.remove(packageName)
      if (subscriptions.remove(subscriptionId) == null) return true
      changeEventBuffers.remove(eventBufferKey(packageName, fileName))
      unregisterPackageObserverIfUnused(packageName, fileName)
    }

    try {
      val authority = packageName + AUTHORITY_SUFFIX
      val uri = Uri.parse("content://$authority")
      val extras = Bundle().apply { putString("fileName", fileName) }
      context.contentResolver.call(uri, "unsubscribeFromFile", null, extras)
    } catch (e: Exception) {
      Log.w(TAG, "Error unsubscribing from SDK (may be expected if app was uninstalled)", e)
    }

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
    val remoteSubscriptions: List<StorageSubscription>
    val observers: List<PackageObserverState>
    synchronized(lifecycleLock) {
      if (destroyed) return
      destroyed = true
      remoteSubscriptions = subscriptions.values.map { it.subscription }
      observers = packageObservers.values.toList()
      subscriptions.clear()
      subscriptionLocks.clear()
      packageObservers.clear()
      refusedStartPackages.clear()
      changeEventBuffers.clear()
      changeEventSignal.close()
    }
    fetchScope.cancel()
    for (state in observers) {
      state.signals.close()
      try {
        context.contentResolver.unregisterContentObserver(state.observer)
      } catch (e: Exception) {
        Log.w(TAG, "Error unregistering ContentObserver during destroy", e)
      }
    }
    if (remoteSubscriptions.isEmpty()) return

    val cleanupScope = CoroutineScope(cleanupContext + SupervisorJob())
    cleanupScope.launch {
      try {
        val completed =
          withTimeoutOrNull(cleanupTimeoutMs) {
            for (subscription in remoteSubscriptions) {
              // This sibling is deliberately outside withTimeout's child hierarchy: a Binder call
              // may ignore interruption. Bound the await, without joining a stuck provider thread.
              val call = cleanupScope.async {
                val uri = Uri.parse("content://${subscription.packageName}$AUTHORITY_SUFFIX")
                val extras = Bundle().apply { putString("fileName", subscription.fileName) }
                backgroundCalls.call(uri, "unsubscribeFromFile", extras)
              }
              try {
                call.await()
              } catch (e: CancellationException) {
                throw e
              } catch (e: Exception) {
                Log.w(
                  TAG,
                  "Best-effort SDK unsubscribe failed for ${subscription.subscriptionId}",
                  e,
                )
              } finally {
                call.cancel()
              }
            }
            true
          }
        if (completed == null) {
          // Local state is already gone; abandoning remote cleanup is safe during teardown.
          Log.d(TAG, "Timed out best-effort storage unsubscribe during destroy")
        }
      } finally {
        cleanupScope.cancel()
      }
    }
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

      val signals = Channel<Unit>(Channel.CONFLATED)
      val observer =
        object : ContentObserver(handler) {
          override fun onChange(selfChange: Boolean) {
            super.onChange(selfChange)
            Log.d(TAG, "ContentObserver notified for $packageName")
            if (!destroyed) signals.trySend(Unit)
          }
        }

      try {
        context.contentResolver.registerContentObserver(changesUri, false, observer)
        Log.d(TAG, "Registered ContentObserver for $packageName")
        val worker = fetchScope.launch {
          for (ignored in signals) fetchChangesForPackage(packageName, signals)
        }
        PackageObserverState(
          observer,
          signals,
          worker,
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
        state.signals.close()
        state.worker.cancel()
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

  private suspend fun fetchChangesForPackage(packageName: String, signals: Channel<Unit>) {
    // A notification during registration must wait for the local subscription to be committed.
    // Release this local lock before making any provider call.
    val state = synchronized(lifecycleLock) { packageObservers[packageName] } ?: return
    if (destroyed || state.signals !== signals) return
    val authority = packageName + AUTHORITY_SUFFIX
    val uri = Uri.parse("content://$authority")

    for (fileName in state.subscriptions.toList()) {
      coroutineContext.ensureActive()
      if (destroyed || packageObservers[packageName] !== state) return
      val subscriptionId = "$packageName:$fileName"
      val subState = subscriptions[subscriptionId] ?: continue

      try {
        if (!fetchChangesForFile(packageName, fileName, uri, subState)) return
      } catch (e: CancellationException) {
        throw e
      } catch (e: Exception) {
        Log.e(TAG, "Error fetching changes for $packageName:$fileName", e)
      }
    }
  }

  /** Returns false when event delivery has closed and the caller should stop fetching. */
  private suspend fun fetchChangesForFile(
    packageName: String,
    fileName: String,
    uri: Uri,
    subState: SubscriptionState,
  ): Boolean {
    val firstReply = requestChanges(uri, fileName, subState.lastSequence) ?: return true
    val reportedToken = firstReply.processToken
    val knownToken = subState.processToken
    val restarted = knownToken != null && reportedToken != null && knownToken != reportedToken
    if (restarted) {
      // The app restarted: its sequence counter began again at 1 and its listener is gone, so the
      // old cursor would hide every new change and no further change would ever be queued.
      Log.i(
        TAG,
        "Inspected app restarted; re-arming storage subscription ${subState.subscription.subscriptionId}",
      )
      subState.lastSequence = 0
      subState.processToken = reportedToken
      subState.needsRearm = true
    } else if (knownToken == null) {
      subState.processToken = reportedToken
    }
    if (subState.needsRearm) rearmListener(packageName, fileName, uri, subState)

    var pending = firstReply.changes
    var advanceCursor = true
    if (restarted) {
      // The SDK removes the changes it returns, so the first reply (filtered by the stale cursor)
      // already holds new-process changes that a re-read will never return again. Keep them and
      // merge with the read from 0, de-duplicated by sequence number. If the re-read failed, its
      // changes are still queued in the app: deliver the first reply but leave the cursor at 0 so
      // the next poll reads them.
      val reread = requestChanges(uri, fileName, 0)
      advanceCursor = reread != null
      pending =
        (pending + reread?.changes.orEmpty())
          .distinctBy { it.sequenceNumber }
          .sortedBy { it.sequenceNumber }
    }
    return deliverChanges(packageName, fileName, subState, pending, advanceCursor)
  }

  /**
   * Tells the manager the app [packageName] showed a window. A freshly started app process shows a
   * window shortly after it starts, and a restart leaves no push of its own (the old process's
   * listener is gone and the new one has none until it is re-armed), so this is the liveness signal
   * that makes an open subscription notice a restart without the client re-subscribing (#10069).
   *
   * Cost: nothing while idle (no timer, no polling). A subscribed package triggers one `getChanges`
   * call per subscribed file per signal, coalesced by the package's conflated worker queue; a
   * package with no subscription is a single map miss.
   */
  fun onPackageActivity(packageName: String) {
    if (destroyed) return
    packageObservers[packageName]?.signals?.trySend(Unit)
  }

  /**
   * Re-registers the app-side listener in the new process. Leaves [SubscriptionState.needsRearm]
   * set when the call fails so the next signal retries; a retry happens only when a signal arrives,
   * never on a timer.
   */
  private suspend fun rearmListener(
    packageName: String,
    fileName: String,
    uri: Uri,
    subState: SubscriptionState,
  ) {
    val extras = Bundle().apply { putString("fileName", fileName) }
    val result = backgroundCalls.call(uri, "subscribeToFile", extras)
    coroutineContext.ensureActive()
    if (result == null || !result.getBoolean("success", false)) {
      Log.w(TAG, "Could not re-arm storage subscription $packageName:$fileName; will retry")
      return
    }
    val response = result.getString("result")?.let(StorageProtocolSerializer::responseFromJson)
    val token = (response as? StorageResponse.SubscriptionResult)?.processToken
    if (token != null && token != subState.processToken) {
      // The app restarted again between the read and the re-arm.
      subState.processToken = token
      subState.lastSequence = 0
    }
    subState.needsRearm = false
  }

  private fun deliverChanges(
    packageName: String,
    fileName: String,
    subState: SubscriptionState,
    pending: List<StorageChangeEvent>,
    advanceCursor: Boolean,
  ): Boolean {
    for (change in pending) {
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

      if (!enqueueChangeEvent(event, subState)) {
        Log.w(TAG, "Stopping storage-change fetch after event delivery channel closed")
        return false
      }
      if (advanceCursor) {
        subState.lastSequence = maxOf(subState.lastSequence, change.sequenceNumber)
      }
    }
    return true
  }

  private suspend fun requestChanges(
    uri: Uri,
    fileName: String,
    sinceSequence: Long,
  ): StorageResponse.Changes? {
    val extras =
      Bundle().apply {
        putString("fileName", fileName)
        putLong("sinceSequence", sinceSequence)
      }
    val result = backgroundCalls.call(uri, "getChanges", extras)
    coroutineContext.ensureActive()
    if (result == null || !result.getBoolean("success", false)) return null
    val responseJson = result.getString("result") ?: "{}"
    return StorageProtocolSerializer.responseFromJson(responseJson) as? StorageResponse.Changes
  }

  private fun enqueueChangeEvent(event: PreferenceChangeEvent, state: SubscriptionState): Boolean {
    val subscriptionId = "${event.packageName}:${event.fileName}"
    synchronized(lifecycleLock) {
      if (destroyed || subscriptions[subscriptionId] !== state) {
        return true
      }
      val bufferKey = eventBufferKey(event.packageName, event.fileName)
      val buffer = changeEventBuffers.computeIfAbsent(bufferKey) { SubscriptionEventBuffer() }
      synchronized(buffer) {
        if (buffer.events.size == STORAGE_EVENT_BUFFER_CAPACITY) {
          buffer.events.removeFirst()
        }
        buffer.events.addLast(event)
      }
    }
    return changeEventSignal.trySend(Unit).isSuccess
  }

  private fun eventBufferKey(packageName: String, fileName: String): String =
    "${packageName.length}:$packageName:$fileName"

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

  /**
   * The target app had no process (it was force-stopped) when the subscribe call arrived, so the
   * call itself started it, and its inspection still had not become available after one retry. The
   * app is running now, so the reply must not tell the user it is not running (#10210).
   */
  class AppStartedByRequest(packageName: String) :
    StorageError(
      "app $packageName was not running; this request started it but its storage inspection did " +
        "not become available. Launch the app normally and subscribe again"
    )

  class FileNotFound(fileName: String) : StorageError("Preferences file not found: $fileName")

  class SdkError(message: String) : StorageError(message)
}

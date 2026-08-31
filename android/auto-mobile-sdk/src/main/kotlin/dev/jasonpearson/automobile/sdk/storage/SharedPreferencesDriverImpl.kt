package dev.jasonpearson.automobile.sdk.storage

import android.content.Context
import android.content.SharedPreferences
import android.net.Uri
import dev.jasonpearson.automobile.sdk.AutoMobileSDK
import java.io.File
import java.util.ArrayDeque
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicLong

/**
 * Android implementation of SharedPreferencesDriver that uses the SharedPreferences API.
 *
 * @param context Application context
 * @param fileSystemOperations File system abstraction for listing preference files
 */
internal class SharedPreferencesDriverImpl(
  private val context: Context,
  private val fileSystemOperations: FileSystemOperations = RealFileSystemOperations(),
) : SharedPreferencesDriver {

  companion object {
    /** URI authority suffix for change notifications. */
    const val CHANGES_AUTHORITY_SUFFIX = ".automobile.sharedprefs"

    /** URI path for change notifications. */
    const val CHANGES_PATH = "changes"

    /**
     * Retain enough recent writes for transient CtrlProxy delays without allowing an unavailable
     * consumer to exhaust the inspected app's memory. Evicting older entries leaves a sequence gap,
     * which the desktop reconciles from a fresh snapshot.
     */
    private const val MAX_QUEUED_CHANGES_PER_FILE = 256
  }

  private val listeners = CopyOnWriteArrayList<OnPreferenceChangeListener>()
  // ConcurrentHashMap: the SharedPreferences change listener fires on arbitrary
  // threads and reads changeQueues/valueSnapshots while startListening/stopListening
  // structurally modify these maps on other threads (#3601). The values were already
  // concurrent; only the outer maps were plain HashMaps.
  private val sharedPrefsListeners =
    ConcurrentHashMap<String, SharedPreferences.OnSharedPreferenceChangeListener>()

  /** Per-file bounded change queues for push-based notifications. */
  private val changeQueues = ConcurrentHashMap<String, BoundedPreferenceChangeQueue>()

  /**
   * Per-file snapshot of the last-known values, keyed by preference key. Seeded on [startListening]
   * and updated after each change so the change listener — which fires only AFTER the value is
   * already committed — can report the value that was present BEFORE the change (#3000). Backed by
   * [ConcurrentHashMap] because the SharedPreferences listener may fire off arbitrary threads; it
   * cannot store null, so an absent key naturally means "no prior value".
   */
  private val valueSnapshots = ConcurrentHashMap<String, ConcurrentHashMap<String, Any?>>()

  /** Monotonically increasing sequence counter for ordering changes. */
  private val sequenceCounter = AtomicLong(0)

  override fun getPreferenceFiles(): List<PreferenceFileDescriptor> {
    val sharedPrefsDir = File(context.applicationInfo.dataDir, "shared_prefs")
    val files = fileSystemOperations.listFiles(sharedPrefsDir)

    return files
      .filter { it.name.endsWith(".xml") }
      .map { file ->
        val name = file.name.removeSuffix(".xml")
        val prefs = context.getSharedPreferences(name, Context.MODE_PRIVATE)
        PreferenceFileDescriptor(
          name = name,
          path = file.absolutePath,
          entryCount = prefs.all.size,
        )
      }
  }

  override fun getPreferences(fileName: String): List<KeyValuePair> {
    // Verify the file exists
    val sharedPrefsDir = File(context.applicationInfo.dataDir, "shared_prefs")
    val prefFile = File(sharedPrefsDir, "$fileName.xml")

    if (!fileSystemOperations.exists(prefFile)) {
      throw SharedPreferencesError.FileNotFound(fileName)
    }

    val prefs = context.getSharedPreferences(fileName, Context.MODE_PRIVATE)
    return prefs.all.map { (key, value) ->
      KeyValuePair(key = key, value = value, type = detectType(value))
    }
  }

  override fun registerOnChangeListener(listener: OnPreferenceChangeListener) {
    listeners.add(listener)
  }

  override fun unregisterOnChangeListener(listener: OnPreferenceChangeListener) {
    listeners.remove(listener)
  }

  /**
   * Starts listening for changes on a specific preferences file.
   *
   * Initializes a change queue for the file and registers a listener that:
   * 1. Captures new values and queues changes with sequence numbers
   * 2. Notifies registered listeners
   * 3. Signals observers via ContentResolver.notifyChange()
   *
   * @param fileName The preferences file name
   */
  internal fun startListening(fileName: String) {
    if (sharedPrefsListeners.containsKey(fileName)) return

    // Initialize change queue for this file
    changeQueues.getOrPut(fileName) {
      BoundedPreferenceChangeQueue(MAX_QUEUED_CHANGES_PER_FILE)
    }

    val prefs = context.getSharedPreferences(fileName, Context.MODE_PRIVATE)

    // Seed the previous-value snapshot with the file's current contents so the first
    // change for a key reports its true prior value rather than null (#3000).
    val snapshot = ConcurrentHashMap<String, Any?>()
    prefs.all.forEach { (k, v) -> if (v != null) snapshot[k] = v }
    valueSnapshots[fileName] = snapshot

    val sharedPrefsListener =
      SharedPreferences.OnSharedPreferenceChangeListener { sharedPrefs, key ->
        // Capture the new value
        val newValue = if (key != null) sharedPrefs.all[key] else null
        val type = detectType(newValue)
        val timestamp = System.currentTimeMillis()
        val sequence = sequenceCounter.incrementAndGet()

        // Derive the prior value from the snapshot taken before this change. A
        // null key means the whole file was cleared (API 30+), so there is no
        // single prior value to report (#3000). Capture its own type so it stays
        // valid JSON on the wire even when the new value's type is UNKNOWN.
        val previousValue = if (key != null) snapshot[key] else null
        val previousValueType = detectType(previousValue)

        // Queue the change
        val change =
          PreferenceChange(
            fileName,
            key,
            newValue,
            type,
            timestamp,
            sequence,
            previousValue,
            previousValueType,
          )
        changeQueues[fileName]?.add(change)

        // Advance the snapshot to reflect the new state for the next change.
        if (key != null) {
          if (newValue != null) snapshot[key] = newValue else snapshot.remove(key)
        } else {
          snapshot.clear()
        }

        // Notify registered listeners
        listeners.forEach { it.onPreferenceChanged(fileName, key) }

        // Signal ContentObserver watchers
        notifyChangesAvailable()
      }

    prefs.registerOnSharedPreferenceChangeListener(sharedPrefsListener)
    sharedPrefsListeners[fileName] = sharedPrefsListener
  }

  /**
   * Stops listening for changes on a specific preferences file.
   *
   * Also clears any queued changes for this file.
   *
   * @param fileName The preferences file name
   */
  internal fun stopListening(fileName: String) {
    sharedPrefsListeners.remove(fileName)?.let { listener ->
      val prefs = context.getSharedPreferences(fileName, Context.MODE_PRIVATE)
      prefs.unregisterOnSharedPreferenceChangeListener(listener)
    }
    changeQueues.remove(fileName)
    valueSnapshots.remove(fileName)
  }

  /** Stops listening on all preferences files. */
  internal fun stopAllListening() {
    sharedPrefsListeners.keys.toList().forEach { stopListening(it) }
  }

  /**
   * Checks if the driver is actively listening for changes on a specific file.
   *
   * @param fileName The preferences file name
   * @return true if listening on this file
   */
  internal fun isListening(fileName: String): Boolean {
    return sharedPrefsListeners.containsKey(fileName)
  }

  /**
   * Returns the list of files currently being listened to.
   *
   * @return List of preference file names with active listeners
   */
  internal fun getListenedFiles(): List<String> {
    return sharedPrefsListeners.keys.toList()
  }

  /**
   * Returns queued changes for a file since the given sequence number.
   *
   * Changes are returned and removed from the queue. Use sinceSequence=0 to get all changes.
   *
   * @param fileName The preferences file name
   * @param sinceSequence Only return changes with sequenceNumber > sinceSequence
   * @return List of changes since the given sequence number
   */
  internal fun getQueuedChanges(fileName: String, sinceSequence: Long): List<PreferenceChange> {
    return changeQueues[fileName]?.drainAfter(sinceSequence) ?: emptyList()
  }

  /** Notifies observers that changes are available via ContentResolver. */
  private fun notifyChangesAvailable() {
    try {
      val authority = context.packageName + CHANGES_AUTHORITY_SUFFIX
      val uri = Uri.parse("content://$authority/$CHANGES_PATH")
      context.contentResolver.notifyChange(uri, null)
    } catch (e: Exception) {
      // Log but don't fail if notification fails
      AutoMobileSDK.logger.w("SharedPreferencesDriver", e) { "Failed to notify change" }
    }
  }

  override fun getPreference(fileName: String, key: String): KeyValuePair? {
    // Verify the file exists
    val sharedPrefsDir = File(context.applicationInfo.dataDir, "shared_prefs")
    val prefFile = File(sharedPrefsDir, "$fileName.xml")

    if (!fileSystemOperations.exists(prefFile)) {
      throw SharedPreferencesError.FileNotFound(fileName)
    }

    val prefs = context.getSharedPreferences(fileName, Context.MODE_PRIVATE)
    val value = prefs.all[key] ?: return null
    return KeyValuePair(key = key, value = value, type = detectType(value))
  }

  override fun setValue(fileName: String, key: String, value: Any?, type: KeyValueType) {
    // Verify the file exists
    val sharedPrefsDir = File(context.applicationInfo.dataDir, "shared_prefs")
    val prefFile = File(sharedPrefsDir, "$fileName.xml")

    if (!fileSystemOperations.exists(prefFile)) {
      throw SharedPreferencesError.FileNotFound(fileName)
    }

    val prefs = context.getSharedPreferences(fileName, Context.MODE_PRIVATE)
    val editor = prefs.edit()

    when (type) {
      KeyValueType.STRING -> editor.putString(key, value as? String)
      KeyValueType.INT -> editor.putInt(key, (value as Number).toInt())
      KeyValueType.LONG -> editor.putLong(key, (value as Number).toLong())
      KeyValueType.FLOAT -> editor.putFloat(key, (value as Number).toFloat())
      KeyValueType.BOOLEAN -> editor.putBoolean(key, value as Boolean)
      KeyValueType.STRING_SET -> {
        @Suppress("UNCHECKED_CAST")
        val set =
          value as? Set<String>
            ?: throw SharedPreferencesError.InvalidType(type.name, "value is not a Set<String>")
        editor.putStringSet(key, set)
      }
      KeyValueType.UNKNOWN ->
        throw SharedPreferencesError.InvalidType(type.name, "cannot set value with UNKNOWN type")
    }

    editor.apply()
  }

  override fun removeValue(fileName: String, key: String) {
    // Verify the file exists
    val sharedPrefsDir = File(context.applicationInfo.dataDir, "shared_prefs")
    val prefFile = File(sharedPrefsDir, "$fileName.xml")

    if (!fileSystemOperations.exists(prefFile)) {
      throw SharedPreferencesError.FileNotFound(fileName)
    }

    val prefs = context.getSharedPreferences(fileName, Context.MODE_PRIVATE)
    prefs.edit().remove(key).apply()
  }

  override fun clear(fileName: String) {
    // Verify the file exists
    val sharedPrefsDir = File(context.applicationInfo.dataDir, "shared_prefs")
    val prefFile = File(sharedPrefsDir, "$fileName.xml")

    if (!fileSystemOperations.exists(prefFile)) {
      throw SharedPreferencesError.FileNotFound(fileName)
    }

    val prefs = context.getSharedPreferences(fileName, Context.MODE_PRIVATE)
    prefs.edit().clear().apply()
  }

  private fun detectType(value: Any?): KeyValueType {
    return when (value) {
      null -> KeyValueType.UNKNOWN
      is String -> KeyValueType.STRING
      is Int -> KeyValueType.INT
      is Long -> KeyValueType.LONG
      is Float -> KeyValueType.FLOAT
      is Boolean -> KeyValueType.BOOLEAN
      is Set<*> -> KeyValueType.STRING_SET
      else -> KeyValueType.UNKNOWN
    }
  }
}

/**
 * Synchronizes each file's queue independently so application writes never contend across files.
 * Its finite capacity intentionally evicts the oldest event: the remaining sequence discontinuity
 * tells the desktop to refresh its authoritative snapshot.
 */
private class BoundedPreferenceChangeQueue(private val capacity: Int) {
  private val changes = ArrayDeque<PreferenceChange>(capacity)

  @Synchronized
  fun add(change: PreferenceChange) {
    if (changes.size == capacity) {
      changes.removeFirst()
    }
    changes.addLast(change)
  }

  @Synchronized
  fun drainAfter(sequenceNumber: Long): List<PreferenceChange> {
    val pendingChanges = changes.filter { it.sequenceNumber > sequenceNumber }
    changes.removeAll(pendingChanges.toSet())
    return pendingChanges
  }
}

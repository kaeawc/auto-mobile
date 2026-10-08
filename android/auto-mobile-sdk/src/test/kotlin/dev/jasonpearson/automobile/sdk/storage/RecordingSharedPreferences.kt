package dev.jasonpearson.automobile.sdk.storage

import android.content.SharedPreferences

/**
 * In-memory [SharedPreferences] whose [SharedPreferences.Editor] records whether a write went
 * through `apply()` or `commit()` and on which thread, and whose `commit()` result can be forced to
 * `false` (a failed disk write). Like the real implementation, the edit lands in memory (and
 * listeners fire once) even when the simulated disk write fails.
 */
class RecordingSharedPreferences(initial: Map<String, Any?> = emptyMap()) : SharedPreferences {
  /** One recorded write: which flush method ran, and on which thread. */
  data class WriteCall(val method: String, val threadName: String)

  /** What `commit()` returns; set to false to simulate a full or read-only disk. */
  var commitResult: Boolean = true

  val writeCalls = mutableListOf<WriteCall>()

  private val values = LinkedHashMap<String, Any?>(initial)
  private val listeners = mutableListOf<SharedPreferences.OnSharedPreferenceChangeListener>()

  override fun getAll(): MutableMap<String, *> = LinkedHashMap(values)

  override fun getString(key: String, defValue: String?): String? =
    values[key] as? String ?: defValue

  @Suppress("UNCHECKED_CAST")
  override fun getStringSet(key: String, defValues: MutableSet<String>?): MutableSet<String>? =
    values[key] as? MutableSet<String> ?: defValues

  override fun getInt(key: String, defValue: Int): Int = values[key] as? Int ?: defValue

  override fun getLong(key: String, defValue: Long): Long = values[key] as? Long ?: defValue

  override fun getFloat(key: String, defValue: Float): Float = values[key] as? Float ?: defValue

  override fun getBoolean(key: String, defValue: Boolean): Boolean =
    values[key] as? Boolean ?: defValue

  override fun contains(key: String): Boolean = values.containsKey(key)

  override fun edit(): SharedPreferences.Editor = RecordingEditor()

  override fun registerOnSharedPreferenceChangeListener(
    listener: SharedPreferences.OnSharedPreferenceChangeListener,
  ) {
    listeners.add(listener)
  }

  override fun unregisterOnSharedPreferenceChangeListener(
    listener: SharedPreferences.OnSharedPreferenceChangeListener,
  ) {
    listeners.remove(listener)
  }

  private inner class RecordingEditor : SharedPreferences.Editor {
    private val staged = mutableListOf<Pair<String, Any?>>()
    private var clearRequested = false

    override fun putString(key: String, value: String?) = stage(key, value)

    override fun putStringSet(key: String, values: MutableSet<String>?) = stage(key, values)

    override fun putInt(key: String, value: Int) = stage(key, value)

    override fun putLong(key: String, value: Long) = stage(key, value)

    override fun putFloat(key: String, value: Float) = stage(key, value)

    override fun putBoolean(key: String, value: Boolean) = stage(key, value)

    override fun remove(key: String) = stage(key, null)

    override fun clear(): SharedPreferences.Editor = apply { clearRequested = true }

    override fun commit(): Boolean {
      record("commit")
      flushToMemory()
      return commitResult
    }

    override fun apply() {
      record("apply")
      flushToMemory()
    }

    private fun stage(key: String, value: Any?): SharedPreferences.Editor = apply {
      staged.add(key to value)
    }

    private fun record(method: String) {
      writeCalls.add(WriteCall(method, Thread.currentThread().name))
    }

    private fun flushToMemory() {
      if (clearRequested) {
        values.clear()
        notifyListeners(null)
      }
      staged.forEach { (key, value) ->
        if (value == null) values.remove(key) else values[key] = value
        notifyListeners(key)
      }
    }

    private fun notifyListeners(key: String?) {
      listeners.toList().forEach {
        it.onSharedPreferenceChanged(this@RecordingSharedPreferences, key)
      }
    }
  }
}

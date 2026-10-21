package dev.jasonpearson.automobile.ctrlproxy

import android.content.ContentResolver
import android.provider.Settings
import android.util.Log
import dev.jasonpearson.automobile.ctrlproxy.perf.PerfProvider
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.protocol.SettingsGetResult
import dev.jasonpearson.automobile.protocol.SettingsListResult
import dev.jasonpearson.automobile.protocol.SettingsPutResult
import kotlinx.coroutines.CancellationException

/** Settings.System/Secure/Global read, write and list, with platform and socket access supplied. */
internal class SettingsController(
  private val contentResolver: () -> ContentResolver,
  private val perfProvider: PerfProvider,
  private val timeProvider: TimeProvider,
  private val resultSender: ResultSender,
) {
  companion object {
    private const val TAG = "CtrlProxy"
  }

  suspend fun performSettingsRead(requestId: String?, namespace: String, key: String) {
    val startTime = timeProvider.currentTimeMillis()
    Log.d(TAG, "performSettingsRead: namespace=$namespace key=$key")
    perfProvider.serial("performSettingsRead")

    var success = false
    var value: String? = null
    var found = false
    var error: String? = null

    try {
      withSettingsFailures(
        onFailure = { e ->
          when (e) {
            is SecurityException -> {
              // Why: surface permission errors cleanly so the TS caller can fall back to ADB
              error = "SecurityException: ${e.message}"
              Log.w(TAG, "Settings read denied: $namespace/$key", e)
            }
            else -> {
              error = "Read failed: ${e.message}"
              Log.e(TAG, "Settings read failed: $namespace/$key", e)
            }
          }
        },
      ) {
        perfProvider.startOperation("readSetting")
        value =
          when (namespace) {
            "system" -> Settings.System.getString(contentResolver(), key)
            "secure" -> Settings.Secure.getString(contentResolver(), key)
            "global" -> Settings.Global.getString(contentResolver(), key)
            else -> {
              error = "Unknown namespace: $namespace"
              null
            }
          }
        perfProvider.endOperation("readSetting")
        if (error == null) {
          success = true
          found = value != null
        }
      }
    } finally {
      perfProvider.end()
      val totalTime = timeProvider.currentTimeMillis() - startTime
      broadcastSettingsGetResult(
        SettingsGetOutcome(
          requestId = requestId,
          namespace = namespace,
          key = key,
          success = success,
          value = value,
          found = found,
          error = error,
          totalTimeMs = totalTime,
        ),
      )
    }
  }

  suspend fun performSettingsWrite(
    requestId: String?,
    namespace: String,
    key: String,
    value: String?,
    valueType: String,
  ) {
    val startTime = timeProvider.currentTimeMillis()
    Log.d(TAG, "performSettingsWrite: namespace=$namespace key=$key valueType=$valueType")
    perfProvider.serial("performSettingsWrite")

    var success = false
    var error: String? = null

    try {
      withSettingsFailures(
        onFailure = { e ->
          when (e) {
            is SecurityException -> {
              // Why: writes to Settings.System require WRITE_SETTINGS; Secure/Global require system
              // app.
              // Surface SecurityException so the TS client can fall back to ADB instead of
              // crashing.
              error = "SecurityException: ${e.message}"
              Log.w(TAG, "Settings write denied: $namespace/$key", e)
            }
            else -> {
              error = "Write failed: ${e.message}"
              Log.e(TAG, "Settings write failed: $namespace/$key", e)
            }
          }
        },
      ) {
        perfProvider.startOperation("writeSetting")
        val write = SettingWrite(namespace, key, value, valueType)
        success = write.apply()
        error = write.error
        perfProvider.endOperation("writeSetting")
        if (!success && error == null) {
          error = "Unknown namespace: $namespace"
        }
      }
    } finally {
      perfProvider.end()
      val totalTime = timeProvider.currentTimeMillis() - startTime
      broadcastSettingsPutResult(
        SettingsPutOutcome(
          requestId = requestId,
          namespace = namespace,
          key = key,
          success = success,
          error = error,
          totalTimeMs = totalTime,
        ),
      )
    }
  }

  private inner class SettingWrite(
    private val namespace: String,
    private val key: String,
    private val value: String?,
    private val valueType: String,
  ) {
    var error: String? = null
      private set

    fun apply(): Boolean {
      if (value == null) {
        return writeSettingString(namespace, key, null)
      } else {
        return when (valueType) {
          "int" -> {
            val intVal = value.toIntOrNull()
            if (intVal == null) {
              error = "Invalid int value: $value"
              false
            } else {
              writeSettingInt(namespace, key, intVal)
            }
          }
          "long" -> {
            val longVal = value.toLongOrNull()
            if (longVal == null) {
              error = "Invalid long value: $value"
              false
            } else {
              writeSettingLong(namespace, key, longVal)
            }
          }
          "float" -> {
            val floatVal = value.toFloatOrNull()
            if (floatVal == null) {
              error = "Invalid float value: $value"
              false
            } else {
              writeSettingFloat(namespace, key, floatVal)
            }
          }
          else -> writeSettingString(namespace, key, value)
        }
      }
    }
  }

  suspend fun performSettingsList(requestId: String?, namespace: String) {
    val startTime = timeProvider.currentTimeMillis()
    Log.d(TAG, "performSettingsList: namespace=$namespace")
    perfProvider.serial("performSettingsList")

    var success = false
    var entries: Map<String, String>? = null
    var error: String? = null

    try {
      withSettingsFailures(
        onFailure = { e ->
          when (e) {
            is SecurityException -> {
              error = "SecurityException: ${e.message}"
              Log.w(TAG, "Settings list denied: $namespace", e)
            }
            else -> {
              error = "List failed: ${e.message}"
              Log.e(TAG, "Settings list failed: $namespace", e)
            }
          }
        },
      ) {
        perfProvider.startOperation("listSettings")
        val uri =
          when (namespace) {
            "system" -> Settings.System.CONTENT_URI
            "secure" -> Settings.Secure.CONTENT_URI
            "global" -> Settings.Global.CONTENT_URI
            else -> null
          }
        if (uri == null) {
          error = "Unknown namespace: $namespace"
        } else {
          entries = readSettingsEntries(contentResolver(), uri)
          success = true
        }
        perfProvider.endOperation("listSettings")
      }
    } finally {
      perfProvider.end()
      val totalTime = timeProvider.currentTimeMillis() - startTime
      broadcastSettingsListResult(
        SettingsListOutcome(
          requestId = requestId,
          namespace = namespace,
          success = success,
          entries = entries,
          error = error,
          totalTimeMs = totalTime,
        ),
      )
    }
  }

  private fun writeSettingString(namespace: String, key: String, value: String?): Boolean {
    return when (namespace) {
      "system" -> Settings.System.putString(contentResolver(), key, value)
      "secure" -> Settings.Secure.putString(contentResolver(), key, value)
      "global" -> Settings.Global.putString(contentResolver(), key, value)
      else -> false
    }
  }

  private fun writeSettingInt(namespace: String, key: String, value: Int): Boolean {
    return when (namespace) {
      "system" -> Settings.System.putInt(contentResolver(), key, value)
      "secure" -> Settings.Secure.putInt(contentResolver(), key, value)
      "global" -> Settings.Global.putInt(contentResolver(), key, value)
      else -> false
    }
  }

  private fun writeSettingLong(namespace: String, key: String, value: Long): Boolean {
    return when (namespace) {
      "system" -> Settings.System.putLong(contentResolver(), key, value)
      "secure" -> Settings.Secure.putLong(contentResolver(), key, value)
      "global" -> Settings.Global.putLong(contentResolver(), key, value)
      else -> false
    }
  }

  private fun writeSettingFloat(namespace: String, key: String, value: Float): Boolean {
    return when (namespace) {
      "system" -> Settings.System.putFloat(contentResolver(), key, value)
      "secure" -> Settings.Secure.putFloat(contentResolver(), key, value)
      "global" -> Settings.Global.putFloat(contentResolver(), key, value)
      else -> false
    }
  }

  private suspend fun broadcastSettingsGetResult(outcome: SettingsGetOutcome) {
    resultSender.send(outcome.requestId, "settings_get_result", attachPerf = false) { _ ->
      SettingsGetResult(
        timestamp = timeProvider.currentTimeMillis(),
        requestId = outcome.requestId,
        success = outcome.success,
        namespace = outcome.namespace,
        key = outcome.key,
        value = outcome.value,
        found = outcome.found,
        totalTimeMs = outcome.totalTimeMs,
        error = outcome.error,
      )
    }
  }

  private suspend fun broadcastSettingsPutResult(outcome: SettingsPutOutcome) {
    resultSender.send(outcome.requestId, "settings_put_result", attachPerf = false) { _ ->
      SettingsPutResult(
        timestamp = timeProvider.currentTimeMillis(),
        requestId = outcome.requestId,
        success = outcome.success,
        namespace = outcome.namespace,
        key = outcome.key,
        totalTimeMs = outcome.totalTimeMs,
        error = outcome.error,
      )
    }
  }

  private suspend fun broadcastSettingsListResult(outcome: SettingsListOutcome) {
    resultSender.send(outcome.requestId, "settings_list_result", attachPerf = false) { _ ->
      SettingsListResult(
        timestamp = timeProvider.currentTimeMillis(),
        requestId = outcome.requestId,
        success = outcome.success,
        namespace = outcome.namespace,
        entries = outcome.entries,
        totalTimeMs = outcome.totalTimeMs,
        error = outcome.error,
      )
    }
  }
}

/**
 * Handles the platform failure set shared by these operations. Failure handlers run outside the
 * try.
 */
private inline fun <T> withSettingsFailures(onFailure: (Exception) -> T, block: () -> T): T =
  try {
    block()
  } catch (e: kotlinx.coroutines.CancellationException) {
    throw e
  } catch (e: SecurityException) {
    onFailure(e)
  } catch (e: IllegalArgumentException) {
    onFailure(e)
  } catch (e: IllegalStateException) {
    onFailure(e)
  } catch (e: android.database.sqlite.SQLiteException) {
    onFailure(e)
  }

private fun readSettingsEntries(
  resolver: android.content.ContentResolver,
  uri: android.net.Uri,
): Map<String, String> {
  val map = HashMap<String, String>()
  resolver.query(uri, arrayOf("name", "value"), null, null, null)?.use { cursor ->
    val nameIdx = cursor.getColumnIndex("name")
    val valueIdx = cursor.getColumnIndex("value")
    if (nameIdx >= 0 && valueIdx >= 0) {
      while (cursor.moveToNext()) {
        val name = cursor.getString(nameIdx) ?: continue
        val v = cursor.getString(valueIdx) ?: ""
        map[name] = v
      }
    }
  }
  return map
}

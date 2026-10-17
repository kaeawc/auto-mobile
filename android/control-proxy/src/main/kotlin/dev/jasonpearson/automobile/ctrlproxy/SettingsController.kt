package dev.jasonpearson.automobile.ctrlproxy

import android.content.ContentResolver
import android.provider.Settings
import android.util.Log
import dev.jasonpearson.automobile.ctrlproxy.perf.PerfProvider
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.protocol.SettingsGetResult
import dev.jasonpearson.automobile.protocol.SettingsListResult
import dev.jasonpearson.automobile.protocol.SettingsPutResult
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import kotlinx.coroutines.CancellationException

/** Settings.System/Secure/Global read, write and list, with platform and socket access supplied. */
internal class SettingsController(
  private val contentResolver: () -> ContentResolver,
  private val perfProvider: PerfProvider,
  private val timeProvider: TimeProvider,
  private val resultBroadcaster: ResultBroadcaster,
  private val responseSender: ResponseSender,
) {
  /** Keeps the service's late-bound WebSocket server behind one seam. */
  interface ResponseSender {
    fun isRunning(): Boolean

    suspend fun broadcast(response: WebSocketResponse)
  }

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
    } catch (e: SecurityException) {
      // Why: surface permission errors cleanly so the TS caller can fall back to ADB
      error = "SecurityException: ${e.message}"
      Log.w(TAG, "Settings read denied: $namespace/$key", e)
    } catch (e: CancellationException) {
      throw e
    } catch (e: Exception) {
      error = "Read failed: ${e.message}"
      Log.e(TAG, "Settings read failed: $namespace/$key", e)
    } finally {
      perfProvider.end()
      val totalTime = timeProvider.currentTimeMillis() - startTime
      broadcastSettingsGetResult(
        requestId,
        namespace,
        key,
        success,
        value,
        found,
        error,
        totalTime,
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
      perfProvider.startOperation("writeSetting")
      if (value == null) {
        success = writeSettingString(namespace, key, null)
      } else {
        success =
          when (valueType) {
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
      perfProvider.endOperation("writeSetting")
      if (!success && error == null) {
        error = "Unknown namespace: $namespace"
      }
    } catch (e: SecurityException) {
      // Why: writes to Settings.System require WRITE_SETTINGS; Secure/Global require system app.
      // Surface SecurityException so the TS client can fall back to ADB instead of crashing.
      error = "SecurityException: ${e.message}"
      Log.w(TAG, "Settings write denied: $namespace/$key", e)
    } catch (e: CancellationException) {
      throw e
    } catch (e: Exception) {
      error = "Write failed: ${e.message}"
      Log.e(TAG, "Settings write failed: $namespace/$key", e)
    } finally {
      perfProvider.end()
      val totalTime = timeProvider.currentTimeMillis() - startTime
      broadcastSettingsPutResult(requestId, namespace, key, success, error, totalTime)
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
        val map = HashMap<String, String>()
        contentResolver().query(uri, arrayOf("name", "value"), null, null, null)?.use { cursor ->
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
        entries = map
        success = true
      }
      perfProvider.endOperation("listSettings")
    } catch (e: SecurityException) {
      error = "SecurityException: ${e.message}"
      Log.w(TAG, "Settings list denied: $namespace", e)
    } catch (e: CancellationException) {
      throw e
    } catch (e: Exception) {
      error = "List failed: ${e.message}"
      Log.e(TAG, "Settings list failed: $namespace", e)
    } finally {
      perfProvider.end()
      val totalTime = timeProvider.currentTimeMillis() - startTime
      broadcastSettingsListResult(requestId, namespace, success, entries, error, totalTime)
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

  private suspend fun broadcastSettingsGetResult(
    requestId: String?,
    namespace: String,
    key: String,
    success: Boolean,
    value: String?,
    found: Boolean,
    error: String?,
    totalTimeMs: Long,
  ) {
    if (!responseSender.isRunning()) return
    resultBroadcaster.guard(requestId, "settings_get_result") {
      responseSender.broadcast(
        SettingsGetResult(
          timestamp = timeProvider.currentTimeMillis(),
          requestId = requestId,
          success = success,
          namespace = namespace,
          key = key,
          value = value,
          found = found,
          totalTimeMs = totalTimeMs,
          error = error,
        ),
      )
    }
  }

  private suspend fun broadcastSettingsPutResult(
    requestId: String?,
    namespace: String,
    key: String,
    success: Boolean,
    error: String?,
    totalTimeMs: Long,
  ) {
    if (!responseSender.isRunning()) return
    resultBroadcaster.guard(requestId, "settings_put_result") {
      responseSender.broadcast(
        SettingsPutResult(
          timestamp = timeProvider.currentTimeMillis(),
          requestId = requestId,
          success = success,
          namespace = namespace,
          key = key,
          totalTimeMs = totalTimeMs,
          error = error,
        ),
      )
    }
  }

  private suspend fun broadcastSettingsListResult(
    requestId: String?,
    namespace: String,
    success: Boolean,
    entries: Map<String, String>?,
    error: String?,
    totalTimeMs: Long,
  ) {
    if (!responseSender.isRunning()) return
    resultBroadcaster.guard(requestId, "settings_list_result") {
      responseSender.broadcast(
        SettingsListResult(
          timestamp = timeProvider.currentTimeMillis(),
          requestId = requestId,
          success = success,
          namespace = namespace,
          entries = entries,
          totalTimeMs = totalTimeMs,
          error = error,
        ),
      )
    }
  }
}

package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.storage.PreferenceEntry
import dev.jasonpearson.automobile.ctrlproxy.storage.PreferenceFileInfo
import dev.jasonpearson.automobile.protocol.ClearPreferencesResult
import dev.jasonpearson.automobile.protocol.GetPreferenceResult
import dev.jasonpearson.automobile.protocol.PreferenceFilesResult
import dev.jasonpearson.automobile.protocol.PreferencesResult
import dev.jasonpearson.automobile.protocol.RemovePreferenceResult
import dev.jasonpearson.automobile.protocol.SetPreferenceResult
import dev.jasonpearson.automobile.protocol.StorageEntry
import dev.jasonpearson.automobile.protocol.StorageFileInfo
import dev.jasonpearson.automobile.protocol.SubscribeStorageResult
import dev.jasonpearson.automobile.protocol.UnsubscribeStorageResult

/** Typed storage result frames (#11877); `ResultFramesGoldenTest` pins them to the old bytes. */
private const val UNKNOWN_ERROR = "Unknown error"

/** The file and request a storage result answers. */
internal data class StorageTarget(
  val requestId: String?,
  val packageName: String,
  val fileName: String,
)

internal fun preferenceFilesResultFrame(
  timestamp: Long,
  requestId: String?,
  packageName: String,
  files: List<PreferenceFileInfo>?,
  error: String?,
): String =
  typedResultFrame(
    PreferenceFilesResult(
      timestamp = timestamp,
      requestId = requestId,
      packageName = packageName,
      success = files != null,
      files =
        files?.map { StorageFileInfo(name = it.name, path = it.path, entryCount = it.entryCount) },
      error = if (files == null) error ?: UNKNOWN_ERROR else null,
    ),
  )

internal fun preferencesResultFrame(
  timestamp: Long,
  target: StorageTarget,
  entries: List<PreferenceEntry>?,
  error: String?,
): String =
  explicitNullsResultFrame(
    PreferencesResult(
      timestamp = timestamp,
      requestId = target.requestId,
      packageName = target.packageName,
      fileName = target.fileName,
      success = entries != null,
      entries = entries?.map { StorageEntry(key = it.key, value = it.value, type = it.type) },
      error = if (entries == null) error ?: UNKNOWN_ERROR else null,
    ),
  )

internal fun subscribeStorageResultFrame(
  timestamp: Long,
  target: StorageTarget,
  subscriptionId: String?,
  error: String?,
): String =
  typedResultFrame(
    SubscribeStorageResult(
      timestamp = timestamp,
      requestId = target.requestId,
      packageName = target.packageName,
      fileName = target.fileName,
      success = subscriptionId != null,
      subscriptionId = subscriptionId,
      error = if (subscriptionId == null) error ?: UNKNOWN_ERROR else null,
    ),
  )

internal fun unsubscribeStorageResultFrame(
  timestamp: Long,
  target: StorageTarget,
  success: Boolean,
): String =
  typedResultFrame(
    UnsubscribeStorageResult(
      timestamp = timestamp,
      requestId = target.requestId,
      packageName = target.packageName,
      fileName = target.fileName,
      success = success,
    ),
  )

/**
 * An entry whose value is null is written without `value`, where the hand-built frame wrote
 * `"value":null`; SharedPreferences cannot hold a null value, so a found entry always has one.
 */
internal fun getPreferenceResultFrame(timestamp: Long, outcome: GetPreferenceOutcome): String =
  typedResultFrame(
    GetPreferenceResult(
      timestamp = timestamp,
      requestId = outcome.requestId,
      packageName = outcome.packageName,
      fileName = outcome.fileName,
      key = outcome.key,
      success = outcome.error == null,
      found = outcome.error == null && outcome.entry != null,
      value = outcome.entry?.value.takeIf { outcome.error == null },
      valueType = outcome.entry?.type.takeIf { outcome.error == null },
      error = outcome.error,
    ),
  )

internal fun setPreferenceResultFrame(
  timestamp: Long,
  target: StorageTarget,
  key: String,
  error: String?,
): String =
  typedResultFrame(
    SetPreferenceResult(
      timestamp = timestamp,
      requestId = target.requestId,
      packageName = target.packageName,
      fileName = target.fileName,
      key = key,
      success = error == null,
      error = error,
    ),
  )

internal fun removePreferenceResultFrame(
  timestamp: Long,
  target: StorageTarget,
  key: String,
  error: String?,
): String =
  typedResultFrame(
    RemovePreferenceResult(
      timestamp = timestamp,
      requestId = target.requestId,
      packageName = target.packageName,
      fileName = target.fileName,
      key = key,
      success = error == null,
      error = error,
    ),
  )

internal fun clearPreferencesResultFrame(
  timestamp: Long,
  target: StorageTarget,
  error: String?,
): String =
  typedResultFrame(
    ClearPreferencesResult(
      timestamp = timestamp,
      requestId = target.requestId,
      packageName = target.packageName,
      fileName = target.fileName,
      success = error == null,
      error = error,
    ),
  )

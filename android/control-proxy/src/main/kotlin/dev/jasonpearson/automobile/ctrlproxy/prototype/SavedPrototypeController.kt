package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.util.Log
import dev.jasonpearson.automobile.protocol.PrototypeResult
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidation
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator
import dev.jasonpearson.automobile.protocol.SavedPrototypeEntry
import dev.jasonpearson.automobile.protocol.SavedPrototypeErrorCode
import dev.jasonpearson.automobile.protocol.SavedPrototypeInfo
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

class SavedPrototypeController(
  private val store: SavedPrototypeStore,
  private val assets: PrototypeAssetSource,
  private val shortcuts: SavedPrototypeShortcuts,
  private val sink: PrototypeResultSink,
  private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
  private val json = Json {
    prettyPrint = false
    ignoreUnknownKeys = true
    classDiscriminator = "type"
  }

  suspend fun save(requestId: String?, spec: PrototypeSpec, label: String, icon: String?) =
    reply(requestId) { saveResult(spec, label, icon) }

  suspend fun list(requestId: String?) =
    reply(requestId) {
      val summaries = store.list()
      val pinned = pinnedIds()
      PrototypeResult(
        timestamp = 0,
        success = true,
        savedPrototypes =
          summaries.map {
            SavedPrototypeEntry(
              it.id,
              it.label,
              it.slug,
              it.savedAt,
              shortcutIdFor(it.id) in pinned,
            )
          },
      )
    }

  suspend fun delete(requestId: String?, id: String) =
    reply(requestId) {
      if (!store.delete(id)) {
        refusal(SavedPrototypeErrorCode.NOT_FOUND, "Saved prototype not found: $id")
      } else {
        disableShortcut(id)
        PrototypeResult(timestamp = 0, success = true)
      }
    }

  private fun saveResult(spec: PrototypeSpec, label: String, icon: String?): PrototypeResult {
    val specJson = json.encodeToString(spec)
    val validation = PrototypeSpecValidator.validate(specJson)
    if (validation is PrototypeSpecValidation.Failure) {
      return refusal(
        SavedPrototypeErrorCode.INVALID_SPEC,
        "${validation.error.path}: ${validation.error.message}",
      )
    }
    val ids = (prototypeAssetReferences(spec.root) + listOfNotNull(icon)).distinct()
    val copied = mutableListOf<SavedPrototypeAsset>()
    val missing = mutableListOf<String>()
    for (id in ids) {
      val info = assets.lookup(id)
      val bytes = if (info != null) assets.read(id) else null
      if (info == null || bytes == null) missing += id
      else copied += SavedPrototypeAsset(id, info.mimeType, bytes)
    }
    if (missing.isNotEmpty()) {
      return refusal(
        SavedPrototypeErrorCode.MISSING_ASSET,
        "Missing prototype assets: ${missing.joinToString()}",
      )
    }
    return when (
      val result = store.save(SavedPrototypeSaveRequest(spec.id, label, specJson, copied))
    ) {
      is SavedPrototypeSaveResult.Saved ->
        PrototypeResult(
          timestamp = 0,
          success = true,
          saved = SavedPrototypeInfo(result.id, result.slug, result.replaced),
        )
      is SavedPrototypeSaveResult.Rejected -> refusal(result.reason.errorCode(), result.message)
    }
  }

  private fun pinnedIds(): Set<String> =
    try {
      shortcuts.pinnedIds()
    } catch (error: CancellationException) {
      throw error
    } catch (error: Exception) {
      Log.w(TAG, "Cannot read pinned prototype shortcuts", error)
      emptySet()
    }

  private fun disableShortcut(id: String) {
    try {
      shortcuts.disable(listOf(shortcutIdFor(id)), "This prototype was deleted")
    } catch (error: CancellationException) {
      throw error
    } catch (error: Exception) {
      Log.w(TAG, "Cannot disable deleted prototype shortcut", error)
    }
  }

  // Build the outcome before calling the sink: even a sink failure cannot cause a second reply.
  private suspend fun reply(requestId: String?, action: () -> PrototypeResult) {
    val result =
      try {
        withContext(ioDispatcher) { action() }
      } catch (error: CancellationException) {
        throw error
      } catch (error: Exception) {
        Log.w(TAG, "Saved prototype request failed", error)
        refusal(SavedPrototypeErrorCode.INTERNAL_ERROR, "Saved prototype request failed")
      }
    val saved = result.saved
    val entries = result.savedPrototypes
    val code = result.errorCode
    when {
      saved != null -> sink.sendSaved(requestId, saved)
      entries != null -> sink.sendSavedList(requestId, entries)
      code != null -> sink.sendRefusal(requestId, code, checkNotNull(result.error))
      else -> sink.send(requestId, result.success, result.error)
    }
  }

  private fun refusal(code: SavedPrototypeErrorCode, message: String) =
    PrototypeResult(timestamp = 0, success = false, errorCode = code, error = message)

  private companion object {
    const val TAG = "SavedPrototypeController"
  }
}

internal fun SavedPrototypeRejection.errorCode(): SavedPrototypeErrorCode =
  when (this) {
    SavedPrototypeRejection.INVALID_ID -> SavedPrototypeErrorCode.INVALID_ID
    SavedPrototypeRejection.INVALID_LABEL -> SavedPrototypeErrorCode.INVALID_LABEL
    SavedPrototypeRejection.SPEC_TOO_LARGE -> SavedPrototypeErrorCode.SPEC_TOO_LARGE
    SavedPrototypeRejection.INVALID_SPEC -> SavedPrototypeErrorCode.INVALID_SPEC
    SavedPrototypeRejection.INVALID_ASSET_ID -> SavedPrototypeErrorCode.INVALID_ASSET_ID
    SavedPrototypeRejection.DUPLICATE_ASSET_ID -> SavedPrototypeErrorCode.DUPLICATE_ASSET_ID
    SavedPrototypeRejection.UNSUPPORTED_MIME_TYPE -> SavedPrototypeErrorCode.UNSUPPORTED_MIME_TYPE
    SavedPrototypeRejection.EMPTY_ASSET -> SavedPrototypeErrorCode.EMPTY_ASSET
    SavedPrototypeRejection.ASSET_TOO_LARGE -> SavedPrototypeErrorCode.ASSET_TOO_LARGE
    SavedPrototypeRejection.COUNT_LIMIT -> SavedPrototypeErrorCode.COUNT_LIMIT
    SavedPrototypeRejection.TOTAL_LIMIT -> SavedPrototypeErrorCode.TOTAL_LIMIT
    SavedPrototypeRejection.MISSING_ASSET -> SavedPrototypeErrorCode.MISSING_ASSET
    SavedPrototypeRejection.SAVED_COUNT_LIMIT -> SavedPrototypeErrorCode.SAVED_COUNT_LIMIT
    SavedPrototypeRejection.STORAGE_FAILURE -> SavedPrototypeErrorCode.STORAGE_FAILURE
    SavedPrototypeRejection.UNSUPPORTED_EXISTING -> SavedPrototypeErrorCode.UNSUPPORTED_EXISTING
  }

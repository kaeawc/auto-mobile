package dev.jasonpearson.automobile.desktop.core.storage

import dev.jasonpearson.automobile.desktop.core.daemon.StorageStreamUpdate
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive

private val json = Json { ignoreUnknownKeys = true }

/**
 * Identifies an entry for highlight purposes. Keys are only unique within a file, so the file name
 * is part of the identity.
 */
internal fun highlightKey(fileName: String, key: String): String = "$fileName:$key"

/**
 * Decodes a daemon-supplied value string into the representation [KeyValueEntry.value] holds.
 *
 * Falls back to the raw string whenever the declared type doesn't parse, which keeps a malformed or
 * newly-added device type visible in the inspector instead of dropping it.
 */
internal fun parseKeyValue(rawValue: String?, type: KeyValueType): Any? {
  if (rawValue == null) return null

  return try {
    when (type) {
      KeyValueType.String -> rawValue
      KeyValueType.Int -> rawValue.toIntOrNull() ?: rawValue
      KeyValueType.Long -> rawValue.toLongOrNull() ?: rawValue
      KeyValueType.Float -> rawValue.toFloatOrNull() ?: rawValue
      KeyValueType.Boolean -> rawValue.toBooleanStrictOrNull() ?: rawValue
      KeyValueType.StringSet ->
        json.parseToJsonElement(rawValue).jsonArray.map { it.jsonPrimitive.content }.toSet()
      KeyValueType.Unknown -> rawValue
    }
  } catch (_: Exception) {
    // A value that doesn't match its declared type is the device's business, not a client error --
    // show it verbatim rather than losing the update.
    rawValue
  }
}

/**
 * Applies one live [StorageStreamUpdate] to the currently displayed files.
 *
 * The three protocol cases are distinguished by nullability, per `StorageChangedEvent`:
 * - null `key` — the whole file was cleared, so its entries are emptied.
 * - null `value` with a non-null key — that key was deleted.
 * - otherwise — the key was added or updated.
 *
 * Updates for a file the inspector hasn't loaded are ignored: the fetched file list defines what is
 * visible, and synthesizing a file here would require inventing an on-device path.
 *
 * Returns the receiver unchanged when nothing matched, so callers can skip recomposition.
 */
internal fun List<KeyValueFile>.applyStorageUpdate(
  update: StorageStreamUpdate
): List<KeyValueFile> {
  val target = firstOrNull { it.name == update.fileName } ?: return this
  val changedKey = update.key
  val newValue = update.value

  val updatedEntries =
    when {
      changedKey == null -> emptyList()
      newValue == null -> target.entries.filterNot { it.key == changedKey }
      else -> {
        val entry =
          KeyValueEntry(
            key = changedKey,
            value = parseKeyValue(newValue, update.valueType),
            type = update.valueType,
          )
        val existingIndex = target.entries.indexOfFirst { it.key == changedKey }
        if (existingIndex >= 0) {
          target.entries.toMutableList().apply { this[existingIndex] = entry }
        } else {
          target.entries + entry
        }
      }
    }

  if (updatedEntries == target.entries) return this

  return map { file ->
    if (file.name == update.fileName) file.copy(entries = updatedEntries) else file
  }
}

/**
 * The highlight identities a live update should light up: the single changed key, or every key in a
 * cleared file.
 */
internal fun StorageStreamUpdate.highlightKeys(files: List<KeyValueFile>): Set<String> =
  if (isFileCleared) {
    files
      .firstOrNull { it.name == fileName }
      ?.entries
      ?.map { highlightKey(fileName, it.key) }
      ?.toSet() ?: emptySet()
  } else {
    key?.let { setOf(highlightKey(fileName, it)) } ?: emptySet()
  }

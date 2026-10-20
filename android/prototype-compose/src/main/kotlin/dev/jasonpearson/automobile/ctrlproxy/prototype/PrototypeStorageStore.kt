package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator
import dev.jasonpearson.automobile.protocol.PrototypeStoredValues
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put

/**
 * Credential-encrypted app-private root for [PrototypeStorageDirectoryStore], beside saved ones.
 */
fun prototypeStorageRoot(filesDir: File): File = File(filesDir, "prototype-storage")

sealed interface PrototypeStorageLoad {
  data object Missing : PrototypeStorageLoad

  data class Loaded(val stored: PrototypeStoredValues) : PrototypeStorageLoad

  /** The file exists but cannot be trusted (unparsable, wrong shape, someone else's id). */
  data class Corrupt(val message: String) : PrototypeStorageLoad
}

/**
 * The values a prototype's `storage` block keeps (#12522), one document per prototype id. Call off
 * the main thread. [save] and [delete] throw [IOException] when the disk refuses; [load] reports an
 * untrustworthy file as [PrototypeStorageLoad.Corrupt] instead of throwing.
 */
interface PrototypeStorageStore {
  fun load(id: String): PrototypeStorageLoad

  /** Replaces everything stored for [id], atomically: a reader sees the old or the new document. */
  fun save(id: String, stored: PrototypeStoredValues)

  /** True when there was something to remove. */
  fun delete(id: String): Boolean
}

/**
 * `<root>/<slug>-<hash>.json`, named like a saved prototype's directory so one id maps to one file.
 * A save writes `<name>.tmp`, syncs it and renames it over the target; a leftover temp file from a
 * crash is overwritten by the next save and never read. All operations are serialized.
 */
class PrototypeStorageDirectoryStore(private val root: File) : PrototypeStorageStore {
  @Synchronized
  override fun load(id: String): PrototypeStorageLoad {
    val file = fileFor(id)
    if (!file.isFile) return PrototypeStorageLoad.Missing
    return try {
      if (file.length() > MAX_DOCUMENT_BYTES) {
        PrototypeStorageLoad.Corrupt("Stored document is ${file.length()} bytes")
      } else parse(id, file.readText(Charsets.UTF_8))
    } catch (error: IOException) {
      PrototypeStorageLoad.Corrupt("Stored document unreadable: ${error.message}")
    }
  }

  @Synchronized
  override fun save(id: String, stored: PrototypeStoredValues) {
    if (!root.isDirectory && !root.mkdirs() && !root.isDirectory) {
      throw IOException("Cannot create prototype storage directory")
    }
    val document = buildJsonObject {
      put("id", id)
      put("version", stored.version)
      put("values", JsonObject(stored.values))
    }
    val target = fileFor(id)
    val temp = File(root, "${target.name}.tmp")
    try {
      FileOutputStream(temp).use { out ->
        out.write(document.toString().toByteArray(Charsets.UTF_8))
        out.flush()
        out.fd.sync()
      }
      if (!temp.renameTo(target)) throw IOException("Cannot replace stored prototype values")
    } finally {
      if (temp.exists()) temp.delete()
    }
  }

  @Synchronized
  override fun delete(id: String): Boolean {
    val file = fileFor(id)
    if (!file.exists()) return false
    if (!file.delete() && file.exists()) throw IOException("Cannot delete stored prototype values")
    return true
  }

  private fun fileFor(id: String): File =
    File(
      root,
      "${prototypeIdSlugPrefix(id)}-${sha256Hex(id.toByteArray(Charsets.UTF_8)).take(HASH_LENGTH)}.json",
    )

  private fun parse(id: String, text: String): PrototypeStorageLoad {
    val document =
      try {
        Json.parseToJsonElement(text) as? JsonObject
      } catch (error: SerializationException) {
        return PrototypeStorageLoad.Corrupt("Stored document is not JSON: ${error.message}")
      } ?: return PrototypeStorageLoad.Corrupt("Stored document is not an object")
    val version = (document["version"] as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull
    val values = document["values"] as? JsonObject
    return when {
      (document["id"] as? JsonPrimitive)?.contentOrNull != id ->
        PrototypeStorageLoad.Corrupt("Stored document belongs to another prototype")
      version == null || version < 1 || values == null ->
        PrototypeStorageLoad.Corrupt("Stored document has no version and values")
      else -> PrototypeStorageLoad.Loaded(PrototypeStoredValues(version, values))
    }
  }

  private companion object {
    /** A valid document holds at most the storage limit plus its envelope; this is generous. */
    val MAX_DOCUMENT_BYTES = PrototypeSpecValidator.MAX_PROTOTYPE_STORAGE_BYTES * 4L
    const val HASH_LENGTH = 16
  }
}

object PrototypeStorageStores {
  private val stores = mutableMapOf<String, PrototypeStorageStore>()

  /** One instance per canonical root, so the service and the saved activity share one lock. */
  @Synchronized
  fun inDirectory(root: File): PrototypeStorageStore {
    val path = root.canonicalPath
    return stores.getOrPut(path) { PrototypeStorageDirectoryStore(File(path)) }
  }
}

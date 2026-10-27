package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeAssetContract
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidation
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.UUID
import java.util.logging.Level
import java.util.logging.Logger
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.intOrNull

/**
 * One lock serializes all operations and recovery; no other lock is acquired. Whole entries are
 * staged, with the manifest written last. Unchanged verified hash files from the same slug are
 * copied into staging, avoiding rewriting request bytes (no hard links or non-SDK APIs). Fault
 * hooks run after each write/copy, after the manifest, between replacement renames, and after the
 * delete rename. Files are synced before commit, with the manifest synced last on a best-effort
 * basis. Directories are not synced because this is not portable across supported Android SDKs.
 * Factory callers share an instance per canonical root; direct instances are for isolated owners
 * and tests and must not operate concurrently on the same root.
 */
class SavedPrototypeDirectoryStore(
  private val root: File,
  private val limits: SavedPrototypeLimits = SavedPrototypeLimits(),
  private val clock: () -> Long = System::currentTimeMillis,
  private val slugHash: (String) -> String = { sha256Hex(it.toByteArray(Charsets.UTF_8)) },
  private val fault: (String) -> Unit = {},
  private val log: (String, Exception?) -> Unit = { message, error ->
    Logger.getLogger("SavedPrototypeStore").log(Level.WARNING, message, error)
  },
  private val files: SavedPrototypeFileOperations = DiskFiles,
) : SavedPrototypeStore {
  private val lock = Any()
  private val json = Json {
    ignoreUnknownKeys = false
    encodeDefaults = true
  }

  @Serializable
  private data class Manifest(
    val formatVersion: Int,
    val id: String,
    val label: String,
    val savedAt: Long,
    val specFile: String,
    val assets: List<Asset>,
    val fonts: List<Asset>,
  )

  @Serializable
  private data class Asset(
    val id: String,
    val file: String,
    val sha256: String,
    val mediaType: String,
  )

  override fun save(request: SavedPrototypeSaveRequest): SavedPrototypeSaveResult =
    synchronized(lock) {
      validate(request)?.let {
        return@synchronized it
      }
      val hashes = request.assets.associate { it.id to sha256Hex(it.bytes) }
      storage({ rejected(SavedPrototypeRejection.STORAGE_FAILURE, "Failed to save prototype.") }) {
        recover()
        val target = find(request.id)
        val replaced = target.exists()
        if (replaced && !storage({ false }) { canReplace(target) }) {
          return@storage rejected(
            SavedPrototypeRejection.UNSUPPORTED_EXISTING,
            "Existing saved prototype manifest cannot be replaced.",
          )
        }
        if (!replaced && readableManifestCount() >= limits.maxSavedPrototypes) {
          return@storage rejected(
            SavedPrototypeRejection.SAVED_COUNT_LIMIT,
            "Saved prototype limit reached.",
          )
        }
        directory(root)
        val token = UUID.randomUUID().toString()
        val stage = File(root, ".tmp-$token")
        directory(stage)
        directory(File(stage, "assets"))
        directory(File(stage, "fonts"))
        val records =
          request.assets.map { asset ->
            val hash = hashes.getValue(asset.id)
            val folder = if (isFontMimeType(asset.mediaType)) "fonts" else "assets"
            val path = "$folder/$hash.${extensions.getValue(asset.mediaType)}"
            val destination = File(stage, path)
            directory(destination.parentFile!!)
            val previous = File(target, path)
            if (
              previous.isFile &&
                previous.length() == asset.bytes.size.toLong() &&
                sha256Hex(previous.readBytes()) == hash
            ) {
              previous.copyTo(destination, overwrite = true)
              files.sync(destination)
              fault("copied-asset")
            } else {
              destination.writeBytes(asset.bytes)
              files.sync(destination)
              fault("wrote-asset")
            }
            Asset(asset.id, path, hash, asset.mediaType)
          }
        val specFile = File(stage, "spec.json")
        specFile.writeText(request.specJson, Charsets.UTF_8)
        files.sync(specFile)
        fault("wrote-spec")
        val manifest =
          Manifest(
            SAVED_PROTOTYPE_FORMAT_VERSION,
            request.id,
            request.label,
            clock(),
            "spec.json",
            records.filterNot { isFontMimeType(it.mediaType) },
            records.filter { isFontMimeType(it.mediaType) },
          )
        val manifestFile = File(stage, "manifest.json")
        manifestFile.writeText(json.encodeToString(manifest), Charsets.UTF_8)
        storage({ Unit }) { files.sync(manifestFile) }
        fault("wrote-manifest")
        val old = File(root, ".old-${target.name}--$token")
        if (replaced) move(target, old)
        try {
          if (replaced) fault("moved-old")
          move(stage, target)
        } catch (error: IOException) {
          if (replaced) move(old, target)
          throw error
        }
        // Retire the backup before cleanup so recovery cannot restore a committed replacement.
        if (old.exists()) retireOld(old)
        SavedPrototypeSaveResult.Saved(request.id, target.name, replaced)
      }
    }

  override fun list(): List<SavedPrototypeSummary> =
    synchronized(lock) {
      storage({ emptyList() }) {
        recover()
        entries()
          .mapNotNull { entry ->
            when (val result = read(entry)) {
              is SavedPrototypeLoadResult.Loaded ->
                SavedPrototypeSummary(result.id, result.label, result.slug, result.savedAt)
              else -> {
                log("Omitting unreadable saved prototype ${entry.name}: $result", null)
                null
              }
            }
          }
          .sortedWith(compareByDescending<SavedPrototypeSummary> { it.savedAt }.thenBy { it.id })
      }
    }

  override fun load(id: String): SavedPrototypeLoadResult =
    synchronized(lock) {
      storage({ SavedPrototypeLoadResult.Corrupt("Failed to read saved prototype.") }) {
        recover()
        val entry = find(id)
        if (!entry.exists()) SavedPrototypeLoadResult.NotFound else read(entry)
      }
    }

  override fun delete(id: String): Boolean =
    synchronized(lock) {
      storage({ false }) {
        recover()
        val entry = find(id)
        if (!entry.exists()) return@storage false
        val trash = File(root, ".del-${entry.name}--${UUID.randomUUID()}")
        move(entry, trash)
        fault("moved-delete")
        remove(trash)
        true
      }
    }

  private fun validate(request: SavedPrototypeSaveRequest): SavedPrototypeSaveResult.Rejected? {
    fun refusal(reason: SavedPrototypeRejection) =
      rejected(reason, "Invalid saved prototype: $reason.")
    if (request.id.isEmpty() || request.id.length > limits.assets.maxIdLength)
      return refusal(SavedPrototypeRejection.INVALID_ID)
    if (request.label.isEmpty() || request.label.length > limits.maxLabelLength)
      return refusal(SavedPrototypeRejection.INVALID_LABEL)
    if (request.specJson.toByteArray(Charsets.UTF_8).size > limits.maxSpecBytes)
      return refusal(SavedPrototypeRejection.SPEC_TOO_LARGE)
    val validated = PrototypeSpecValidator.validate(request.specJson)
    if (validated !is PrototypeSpecValidation.Success)
      return refusal(SavedPrototypeRejection.INVALID_SPEC)
    if (request.assets.size > limits.assets.maxCount)
      return refusal(SavedPrototypeRejection.COUNT_LIMIT)
    val ids = mutableSetOf<String>()
    var total = 0L
    for (asset in request.assets) {
      if (
        asset.id.isEmpty() ||
          asset.id.length > limits.assets.maxIdLength ||
          PrototypeAssetContract.isMediaId(asset.id)
      )
        return refusal(SavedPrototypeRejection.INVALID_ASSET_ID)
      if (!ids.add(asset.id)) return refusal(SavedPrototypeRejection.DUPLICATE_ASSET_ID)
      if (asset.mediaType !in limits.assets.mimeTypes || asset.mediaType !in extensions)
        return refusal(SavedPrototypeRejection.UNSUPPORTED_MIME_TYPE)
      if (asset.bytes.isEmpty()) return refusal(SavedPrototypeRejection.EMPTY_ASSET)
      val cap =
        if (isFontMimeType(asset.mediaType))
          minOf(limits.assets.maxFontBytes, limits.assets.maxAssetBytes)
        else limits.assets.maxAssetBytes
      if (asset.bytes.size > cap) return refusal(SavedPrototypeRejection.ASSET_TOO_LARGE)
      total += asset.bytes.size
    }
    if (total > limits.assets.maxTotalBytes) return refusal(SavedPrototypeRejection.TOTAL_LIMIT)
    if (prototypeAssetReferences(validated.spec.root).any { it !in ids })
      return refusal(SavedPrototypeRejection.MISSING_ASSET)
    return null
  }

  private fun read(entry: File): SavedPrototypeLoadResult =
    storage({ SavedPrototypeLoadResult.Corrupt("Unreadable saved prototype.") }) {
      val document = manifestDocument(entry) ?: throw IOException("Missing or unparsable manifest")
      val version = formatVersion(document)
      if (version != SAVED_PROTOTYPE_FORMAT_VERSION)
        return@storage SavedPrototypeLoadResult.UnsupportedFormat(version)
      val manifest = json.decodeFromJsonElement<Manifest>(document)
      if (
        manifest.specFile != "spec.json" ||
          manifest.id.isEmpty() ||
          manifest.id.length > limits.assets.maxIdLength ||
          manifest.label.isEmpty() ||
          manifest.label.length > limits.maxLabelLength
      )
        throw IOException("Invalid manifest metadata")
      val specFile = File(entry, manifest.specFile)
      if (specFile.length() > limits.maxSpecBytes) throw IOException("Spec exceeds byte cap")
      val specJson = specFile.readText(Charsets.UTF_8)
      val validated = PrototypeSpecValidator.validate(specJson)
      if (validated !is PrototypeSpecValidation.Success) throw IOException("Invalid stored spec")
      val records = manifest.assets + manifest.fonts
      if (
        records.size > limits.assets.maxCount || records.map { it.id }.toSet().size != records.size
      )
        throw IOException("Invalid asset count or duplicate ids")
      val bytes = mutableMapOf<String, ByteArray>()
      val files = mutableMapOf<String, File>()
      var total = 0L
      for (asset in records) {
        if (
          asset.id.isEmpty() ||
            asset.id.length > limits.assets.maxIdLength ||
            PrototypeAssetContract.isMediaId(asset.id) ||
            asset.mediaType !in limits.assets.mimeTypes
        )
          throw IOException("Invalid asset metadata")
        val extension = extensions[asset.mediaType] ?: throw IOException("Unknown asset MIME")
        val font = isFontMimeType(asset.mediaType)
        val folder = if (font) "fonts" else "assets"
        if (
          (asset in manifest.fonts) != font ||
            !Regex("[a-f0-9]{64}").matches(asset.sha256) ||
            asset.file != "$folder/${asset.sha256}.$extension"
        )
          throw IOException("Invalid asset path")
        val file = File(entry, asset.file)
        val cap =
          if (font) minOf(limits.assets.maxFontBytes, limits.assets.maxAssetBytes)
          else limits.assets.maxAssetBytes
        if (!file.isFile || file.length() !in 1..cap.toLong())
          throw IOException("Missing or oversized asset")
        val content = file.readBytes()
        if (sha256Hex(content) != asset.sha256) throw IOException("Asset hash mismatch")
        total += content.size
        bytes[asset.id] = content
        files[asset.id] = file
      }
      if (
        total > limits.assets.maxTotalBytes ||
          prototypeAssetReferences(validated.spec.root).any { it !in bytes }
      )
        throw IOException("Missing assets or total exceeded")
      SavedPrototypeLoadResult.Loaded(
        manifest.id,
        manifest.label,
        entry.name,
        manifest.savedAt,
        validated.spec,
        specJson,
        bytes,
        files,
        manifest.fonts.map { it.id }.toSet(),
      )
    }

  private fun manifestDocument(entry: File): JsonElement? {
    val file = File(entry, "manifest.json")
    if (!file.exists()) return null
    if (file.length() > MAX_MANIFEST_BYTES) throw IOException("Manifest exceeds byte cap")
    val text = files.readManifest(file)
    return try {
      json.parseToJsonElement(text)
    } catch (error: SerializationException) {
      log("Saved prototype manifest is unparsable", error)
      null
    }
  }

  private fun formatVersion(document: JsonElement): Int =
    ((document as? JsonObject)?.get("formatVersion") as? JsonPrimitive)?.intOrNull
      ?: throw IOException("Missing or invalid manifest format version")

  private fun canReplace(entry: File): Boolean {
    val document = manifestDocument(entry) ?: return true
    if (formatVersion(document) != SAVED_PROTOTYPE_FORMAT_VERSION) return false
    return read(entry) is SavedPrototypeLoadResult.Loaded
  }

  private fun readableManifestCount(): Int =
    entries().count { entry ->
      storage({ false }) {
        val document = manifestDocument(entry) ?: return@storage false
        if (formatVersion(document) != SAVED_PROTOTYPE_FORMAT_VERSION) return@storage false
        json.decodeFromJsonElement<Manifest>(document)
        true
      }
    }

  private fun find(id: String): File {
    val prefix = prototypeIdSlugPrefix(id)
    val hash = slugHash(id)
    require(Regex("[a-f0-9]{64}").matches(hash)) { "Slug hash must be 64 lowercase hex characters" }
    var free: File? = null
    var unreadable: File? = null
    for (length in 12..64) {
      val candidate = File(root, "$prefix-${hash.take(length)}")
      if (!candidate.exists()) {
        if (free == null) free = candidate
        continue
      }
      val storedId =
        storage<String?>({ null }) {
          ((manifestDocument(candidate) as? JsonObject)?.get("id") as? JsonPrimitive)?.contentOrNull
        }
      if (storedId == id) return candidate
      if (storedId == null && unreadable == null) unreadable = candidate
    }
    return unreadable ?: free ?: throw IOException("Slug hash collision exhausted")
  }

  private fun entries(): List<File> =
    children().filter { it.isDirectory && !it.name.startsWith(".") }

  private fun children(): List<File> {
    if (!root.exists()) return emptyList()
    return root.listFiles()?.toList() ?: throw IOException("Cannot list saved prototype directory")
  }

  private fun recover() {
    for (entry in children().sortedBy { it.name }) {
      when {
        entry.name.startsWith(".tmp-") -> storage({ Unit }) { remove(entry) }
        entry.name.startsWith(".del-") -> storage({ Unit }) { remove(entry) }
        entry.name.startsWith(".old-") -> {
          val slug = entry.name.removePrefix(".old-").substringBeforeLast("--", "")
          if (!Regex("[a-z0-9-]+-[a-f0-9]{12,64}").matches(slug)) {
            log("Removing invalid saved prototype recovery name: ${entry.name}", null)
            storage({ Unit }) { remove(entry) }
            continue
          }
          val target = File(root, slug)
          if (target.exists()) retireOld(entry) else move(entry, target)
        }
      }
    }
  }

  private fun retireOld(old: File) {
    val trash = File(root, ".del-${old.name.removePrefix(".old-")}")
    val cleanup =
      storage({ old }) {
        move(old, trash)
        trash
      }
    storage({ Unit }) { remove(cleanup) }
  }

  private fun directory(file: File) {
    if (!file.isDirectory && !file.mkdirs() && !file.isDirectory)
      throw IOException("Cannot create directory")
  }

  private fun move(from: File, to: File) {
    if (!from.renameTo(to)) throw IOException("Cannot rename saved prototype directory")
  }

  private fun remove(file: File) = files.remove(file)

  private object DiskFiles : SavedPrototypeFileOperations {
    override fun sync(file: File) {
      FileOutputStream(file, true).use { it.fd.sync() }
    }

    override fun remove(file: File) {
      if (!file.deleteRecursively()) throw IOException("Cannot remove saved prototype directory")
    }

    override fun readManifest(file: File): String = file.readText(Charsets.UTF_8)
  }

  private inline fun <T> storage(failure: () -> T, block: () -> T): T =
    try {
      block()
    } catch (error: IOException) {
      log("Saved prototype I/O failed", error)
      failure()
    } catch (error: SecurityException) {
      log("Saved prototype storage unavailable", error)
      failure()
    } catch (error: SerializationException) {
      log("Saved prototype manifest corrupt", error)
      failure()
    }

  private fun rejected(reason: SavedPrototypeRejection, message: String) =
    SavedPrototypeSaveResult.Rejected(reason, message)

  private companion object {
    const val MAX_MANIFEST_BYTES = 1024L * 1024

    val extensions =
      mapOf(
        "image/png" to "png",
        "image/jpeg" to "jpg",
        "image/webp" to "webp",
        "font/ttf" to "ttf",
        "font/otf" to "otf",
      )
  }
}

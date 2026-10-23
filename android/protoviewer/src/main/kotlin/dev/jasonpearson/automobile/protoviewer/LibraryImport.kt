package dev.jasonpearson.automobile.protoviewer

import dev.jasonpearson.automobile.protocol.PrototypeBundle
import dev.jasonpearson.automobile.protocol.PrototypeBundleExport
import dev.jasonpearson.automobile.protocol.PrototypeBundleExportInput
import dev.jasonpearson.automobile.protocol.PrototypeBundleExportResult
import dev.jasonpearson.automobile.protocol.PrototypeBundleLimits
import dev.jasonpearson.automobile.protocol.PrototypeBundleReadResult
import dev.jasonpearson.automobile.protocol.PrototypeBundleReader
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidation
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.PushbackInputStream
import java.net.URI
import java.util.logging.Level
import java.util.logging.Logger

const val PROTOTYPE_BUNDLE_MIME = "application/vnd.automobile.prototype+zip"

enum class ImportAction {
  View,
  Send,
}

data class LibraryImportRequest(val action: ImportAction?, val uri: String?)

sealed interface LibraryImportResult {
  data class Imported(val entry: LibraryEntry) : LibraryImportResult

  data class Rejected(val path: String, val reason: String) : LibraryImportResult
}

fun interface LibraryImporter {
  fun import(request: LibraryImportRequest): LibraryImportResult
}

fun interface ImportContent {
  fun open(uri: String): InputStream
}

fun interface ImportAssetCheck {
  /** Null means accepted; otherwise return the offending asset path. */
  fun invalidPath(bundle: PrototypeBundle): String?
}

fun interface LibraryImportCommit {
  /** A null label keeps the app's default label for imports. */
  fun commit(
    bundle: PrototypeBundle,
    source: LibrarySource,
    label: String?,
  ): LibraryResult<LibraryEntry>
}

/** The validation and commit half of an import, for bytes the app has already read itself. */
fun interface LibraryBytesImporter {
  fun importBytes(bytes: ByteArray, source: LibrarySource, label: String?): LibraryImportResult
}

/** No Android or disk dependencies: the only side effect is the final injected commit. */
class ValidatedLibraryImporter(
  private val ownAuthorities: Set<String>,
  private val content: ImportContent,
  private val capabilities: Set<String>,
  private val assets: ImportAssetCheck,
  private val commit: LibraryImportCommit,
) : LibraryImporter, LibraryBytesImporter {
  @Suppress(
    "TooGenericExceptionCaught",
  ) // Injected content/storage adapters may throw operational exceptions.
  override fun import(request: LibraryImportRequest): LibraryImportResult {
    return try {
      if (!allowed(request))
        return LibraryImportResult.Rejected("uri", "External content URI required")
      val bytes =
        content.open(checkNotNull(request.uri)).use(::readImportLimited)
          ?: return LibraryImportResult.Rejected("content", "Content exceeds byte limit")
      val source =
        if (request.action == ImportAction.View) LibrarySource.file else LibrarySource.share
      importBytes(bytes, source, null)
    } catch (error: Exception) {
      Logger.getLogger("ProtoViewerImport").log(Level.WARNING, "Import failed", error)
      LibraryImportResult.Rejected("content", "Unable to read or commit prototype within limits")
    }
  }

  @Suppress(
    "TooGenericExceptionCaught",
  ) // Injected content/storage adapters may throw operational exceptions.
  override fun importBytes(
    bytes: ByteArray,
    source: LibrarySource,
    label: String?,
  ): LibraryImportResult {
    return try {
      val bundle =
        when (val read = readBundle(bytes)) {
          is PrototypeBundleReadResult.Rejected ->
            return LibraryImportResult.Rejected(read.path ?: "bundle", read.code.name)
          is PrototypeBundleReadResult.Success -> read.bundle
        }
      validate(bundle)?.let {
        return it
      }
      when (val saved = commit.commit(bundle, source, label)) {
        is LibraryResult.Success -> LibraryImportResult.Imported(saved.value)
        is LibraryResult.Failure -> LibraryImportResult.Rejected("library", saved.error.name)
      }
    } catch (error: Exception) {
      Logger.getLogger("ProtoViewerImport").log(Level.WARNING, "Import failed", error)
      LibraryImportResult.Rejected("content", "Unable to read or commit prototype within limits")
    }
  }

  private fun allowed(request: LibraryImportRequest): Boolean {
    if (request.action == null || request.uri == null) return false
    val uri = URI.create(request.uri)
    val authority = uri.authority ?: return false
    return uri.scheme == "content" &&
      Regex("[A-Za-z0-9_.-]+").matches(authority) &&
      ownAuthorities.none { it.equals(authority, ignoreCase = true) }
  }

  private fun validate(bundle: PrototypeBundle): LibraryImportResult.Rejected? {
    val policy = PrototypeSpecValidator.validate(bundle.spec, library = true)
    if (policy is PrototypeSpecValidation.Failure)
      return LibraryImportResult.Rejected("spec.json:${policy.error.path}", policy.error.message)
    val supported = PrototypeSpecValidator.validate(bundle.spec, capabilities, library = true)
    if (supported is PrototypeSpecValidation.Failure || !capabilities.containsAll(bundle.requires))
      return LibraryImportResult.Rejected("spec.json", "This prototype needs a newer ProtoViewer")
    return assets.invalidPath(bundle)?.let {
      LibraryImportResult.Rejected(it, "Invalid image dimensions")
    }
  }

  private fun readBundle(bytes: ByteArray): PrototypeBundleReadResult {
    if (zip(bytes)) return PrototypeBundleReader.read(bytes)
    // Canonical export reuses the strict transport JSON parser and complete asset traversal for
    // bare specs as well. Missing images/fonts fail here rather than rendering placeholders.
    return when (
      val exported =
        PrototypeBundleExport.export(PrototypeBundleExportInput(bytes, { null }, { null }))
    ) {
      is PrototypeBundleExportResult.Rejected ->
        PrototypeBundleReadResult.Rejected(exported.code, exported.path)
      is PrototypeBundleExportResult.Success -> PrototypeBundleReader.read(exported.bytes)
    }
  }
}

/** Reads at most the bundle cap (zip) or the spec cap (bare JSON); null when over the cap. */
internal fun readImportLimited(stream: InputStream): ByteArray? {
  val input = PushbackInputStream(stream, 2)
  val first = input.read()
  val second = input.read()
  if (second >= 0) input.unread(second)
  if (first >= 0) input.unread(first)
  val signature = byteArrayOf(first.toByte(), second.toByte())
  val limit =
    if (zip(signature)) PrototypeBundleLimits.MAX_COMPRESSED_BYTES
    else PrototypeBundleLimits.MAX_SPEC_BYTES
  val output = ByteArrayOutputStream()
  val buffer = ByteArray(8192)
  while (true) {
    val count = input.read(buffer, 0, minOf(buffer.size, limit - output.size() + 1))
    if (count == -1) break
    if (output.size() + count > limit) return null
    output.write(buffer, 0, count)
  }
  return output.toByteArray()
}

private fun zip(bytes: ByteArray) =
  bytes.size >= 2 && bytes[0] == 80.toByte() && bytes[1] == 75.toByte()

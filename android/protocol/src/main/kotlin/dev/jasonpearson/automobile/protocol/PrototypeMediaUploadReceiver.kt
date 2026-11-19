package dev.jasonpearson.automobile.protocol

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CharsetDecoder
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import java.util.Base64
import java.util.UUID

/**
 * Where media bytes live while they stream in and after commit. Names are opaque receiver tokens,
 * never asset ids, so an id can never reach the file system. Tests use an in-memory fake.
 */
interface PrototypeMediaFiles {
  @Throws(IOException::class) fun create(name: String): PrototypeMediaPartialFile

  /** Removes a committed file; a missing file is not an error. */
  fun delete(name: String)

  /** The committed file for players that need a path; null when not file-backed. */
  fun file(name: String): File? = null
}

/** One upload's file before commit: append-only, then either published or discarded. */
interface PrototypeMediaPartialFile {
  @Throws(IOException::class) fun append(bytes: ByteArray)

  /** Makes the bytes readable under the committed name. */
  @Throws(IOException::class) fun publish()

  /** Closes and deletes the partial bytes; safe to call more than once. */
  fun discard()
}

/**
 * Production [PrototypeMediaFiles]: `<name>.part` while streaming, renamed to `<name>` on publish,
 * so a reader never sees a partial file under a committed name.
 */
class DirectoryPrototypeMediaFiles(private val directory: File) : PrototypeMediaFiles {
  override fun create(name: String): PrototypeMediaPartialFile {
    if (!directory.isDirectory && !directory.mkdirs()) {
      throw IOException("Cannot create media directory")
    }
    val partial = File(directory, "$name.part")
    val target = File(directory, name)
    val output = FileOutputStream(partial)
    return object : PrototypeMediaPartialFile {
      private var open = true

      override fun append(bytes: ByteArray) = output.write(bytes)

      override fun publish() {
        close()
        if (!partial.renameTo(target)) {
          partial.delete()
          throw IOException("Cannot publish media file")
        }
      }

      override fun discard() {
        close()
        partial.delete()
      }

      private fun close() {
        if (open) {
          open = false
          output.close()
        }
      }
    }
  }

  override fun delete(name: String) {
    File(directory, name).delete()
  }

  override fun file(name: String): File = File(directory, name)
}

data class PrototypeMediaLimits(
  val maxAssetBytes: Long = PrototypeMediaContract.MAX_PROTOTYPE_MEDIA_ASSET_BYTES.toLong(),
  val maxVttBytes: Long = PrototypeMediaContract.MAX_PROTOTYPE_VTT_ASSET_BYTES.toLong(),
  val maxCount: Int = PrototypeMediaContract.MAX_PROTOTYPE_MEDIA_ASSET_COUNT,
  val maxTotalBytes: Long = PrototypeMediaContract.MAX_PROTOTYPE_MEDIA_ASSET_TOTAL_BYTES.toLong(),
  val maxChunkBytes: Int = PrototypeMediaContract.MAX_PROTOTYPE_MEDIA_CHUNK_BYTES,
  val maxIdLength: Int = PrototypeAssetContract.MAX_PROTOTYPE_ASSET_ID_LENGTH,
) {
  /** Longest base64 text that can still decode to one chunk; longer is rejected undecoded. */
  val maxEncodedChunkLength: Int = (maxChunkBytes + 2) / 3 * 4

  fun maxBytes(mimeType: String): Long =
    if (mimeType == PrototypeMediaContract.VTT_MIME_TYPE) maxVttBytes else maxAssetBytes
}

/** The closed rejection vocabulary shared with TypeScript; [code] is the wire value. */
enum class PrototypeMediaRejection(val code: String) {
  INVALID_ID("invalid_id"),
  UNSUPPORTED_MIME_TYPE("unsupported_mime_type"),
  EMPTY("empty"),
  TOO_LARGE("too_large"),
  INVALID_SHA256("invalid_sha256"),
  COUNT_LIMIT("count_limit"),
  TOTAL_LIMIT("total_limit"),
  UNKNOWN_UPLOAD("unknown_upload"),
  OFFSET_MISMATCH("offset_mismatch"),
  EMPTY_CHUNK("empty_chunk"),
  CHUNK_TOO_LARGE("chunk_too_large"),
  INVALID_BASE64("invalid_base64"),
  OVERFLOW("overflow"),
  TRUNCATED("truncated"),
  SHA256_MISMATCH("sha256_mismatch"),
  CONTENT_MISMATCH("content_mismatch"),
  NOT_UTF8("not_utf8"),
  STORAGE_FAILURE("storage_failure"),
}

data class PrototypeMediaInfo(
  val id: String,
  val mimeType: String,
  val byteCount: Long,
  val fileName: String,
)

sealed interface PrototypeMediaResult {
  /** A begin or chunk was accepted; [received] bytes are on disk so far. */
  data class Accepted(val received: Long) : PrototypeMediaResult

  data class Stored(val info: PrototypeMediaInfo, val replaced: Boolean) : PrototypeMediaResult

  /** The upload, if any, was dropped with its partial file; committed assets are untouched. */
  data class Rejected(val reason: PrototypeMediaRejection, val message: String) :
    PrototypeMediaResult
}

/**
 * Device side of the chunked media upload (#14254): `begin {id, mimeType, size, sha256}`,
 * contiguous `chunk {id, offset, bytes}`, then `commit {id}`. Bytes go straight to [files], never
 * collected on the heap; the digest, signature and (for captions) UTF-8 checks run incrementally.
 *
 * Any rejected chunk or commit drops that upload and deletes its partial file, so a truncated or
 * mismatched stream leaves nothing behind. Count and byte caps cover committed and in-flight
 * uploads together; when full a begin is rejected, never evicting, like the image store. Replacing
 * an id keeps the old asset readable until the new one commits, and its bytes are not counted
 * twice. Calls are serialized on the receiver; a chunk is at most one contract chunk of I/O.
 */
class PrototypeMediaUploadReceiver(
  private val files: PrototypeMediaFiles,
  val limits: PrototypeMediaLimits = PrototypeMediaLimits(),
  private val newName: () -> String = { "media-${UUID.randomUUID()}" },
) {
  private class Upload(
    val mimeType: String,
    val size: Long,
    val sha256: String,
    val fileName: String,
    val partial: PrototypeMediaPartialFile,
  ) {
    var received = 0L
    val digest: MessageDigest = MessageDigest.getInstance("SHA-256")
    val head = java.io.ByteArrayOutputStream(PrototypeMediaContract.SIGNATURE_PROBE_BYTES)
    var signatureChecked = false
    val utf8: Utf8Validator? =
      if (mimeType == PrototypeMediaContract.VTT_MIME_TYPE) Utf8Validator() else null
  }

  private val stored = LinkedHashMap<String, PrototypeMediaInfo>()
  private val pending = HashMap<String, Upload>()

  @Synchronized fun lookup(id: String): PrototypeMediaInfo? = stored[id]

  @Synchronized fun file(id: String): File? = stored[id]?.let { files.file(it.fileName) }

  @Synchronized
  fun begin(id: String, mimeType: String, size: Long, sha256: String): PrototypeMediaResult {
    beginProblem(id, mimeType, size, sha256)?.let {
      return it
    }
    pending.remove(id)?.partial?.discard()
    capacityProblem(id, size)?.let {
      return it
    }
    val fileName = newName()
    val partial =
      try {
        files.create(fileName)
      } catch (error: IOException) {
        return reject(
          PrototypeMediaRejection.STORAGE_FAILURE,
          "Cannot store media: ${error.message}",
        )
      }
    pending[id] = Upload(mimeType, size, sha256, fileName, partial)
    return PrototypeMediaResult.Accepted(0)
  }

  /** Decodes [dataBase64] only when its length can fit one chunk. */
  @Synchronized
  fun chunkBase64(id: String, offset: Long, dataBase64: String): PrototypeMediaResult {
    if (dataBase64.length > limits.maxEncodedChunkLength) {
      return fail(
        id,
        PrototypeMediaRejection.CHUNK_TOO_LARGE,
        "Chunk exceeds ${limits.maxChunkBytes} bytes.",
      )
    }
    val bytes =
      try {
        Base64.getDecoder().decode(dataBase64)
      } catch (error: IllegalArgumentException) {
        return fail(
          id,
          PrototypeMediaRejection.INVALID_BASE64,
          "Chunk is not valid base64: ${error.message}",
        )
      }
    return chunk(id, offset, bytes)
  }

  @Synchronized
  fun chunk(id: String, offset: Long, bytes: ByteArray): PrototypeMediaResult {
    val upload =
      pending[id]
        ?: return reject(
          PrototypeMediaRejection.UNKNOWN_UPLOAD,
          "No media upload '$id' is in progress.",
        )
    return chunkProblem(upload, offset, bytes)?.let { fail(id, it.first, it.second) }
      ?: write(id, upload, bytes)
  }

  @Synchronized
  fun commit(id: String): PrototypeMediaResult {
    val upload =
      pending[id]
        ?: return reject(
          PrototypeMediaRejection.UNKNOWN_UPLOAD,
          "No media upload '$id' is in progress.",
        )
    commitProblem(upload)?.let {
      return fail(id, it.first, it.second)
    }
    try {
      upload.partial.publish()
    } catch (error: IOException) {
      return fail(
        id,
        PrototypeMediaRejection.STORAGE_FAILURE,
        "Cannot store media: ${error.message}",
      )
    }
    pending.remove(id)
    val info = PrototypeMediaInfo(id, upload.mimeType, upload.size, upload.fileName)
    val previous = stored.remove(id)
    previous?.let { files.delete(it.fileName) }
    stored[id] = info
    return PrototypeMediaResult.Stored(info, replaced = previous != null)
  }

  /** Drops an in-flight upload and its partial file. Idempotent. */
  @Synchronized
  fun abort(id: String) {
    pending.remove(id)?.partial?.discard()
  }

  /** Drops every committed asset and in-flight upload, as when the prototype session ends. */
  @Synchronized
  fun clear() {
    pending.values.forEach { it.partial.discard() }
    pending.clear()
    stored.values.forEach { files.delete(it.fileName) }
    stored.clear()
  }

  private fun beginProblem(
    id: String,
    mimeType: String,
    size: Long,
    sha256: String,
  ): PrototypeMediaResult.Rejected? =
    when {
      PrototypeAssetContract.isMediaId(id) ->
        reject(
          PrototypeMediaRejection.INVALID_ID,
          "Media asset ids cannot start with ${PrototypeAssetContract.MEDIA_ID_PREFIX}.",
        )
      id.isEmpty() || id.length > limits.maxIdLength ->
        reject(
          PrototypeMediaRejection.INVALID_ID,
          "Media asset id must be 1 to ${limits.maxIdLength} characters.",
        )
      mimeType !in PrototypeMediaContract.MIME_TYPES ->
        reject(PrototypeMediaRejection.UNSUPPORTED_MIME_TYPE, "Unsupported media MIME type.")
      size <= 0 -> reject(PrototypeMediaRejection.EMPTY, "Media asset has no data.")
      size > limits.maxBytes(mimeType) ->
        reject(
          PrototypeMediaRejection.TOO_LARGE,
          "Media asset is $size bytes; the limit for $mimeType is ${limits.maxBytes(mimeType)}.",
        )
      !SHA256_HEX.matches(sha256) ->
        reject(
          PrototypeMediaRejection.INVALID_SHA256,
          "sha256 must be 64 lowercase hex characters.",
        )
      else -> null
    }

  private fun capacityProblem(id: String, size: Long): PrototypeMediaResult.Rejected? {
    val otherStored = stored.values.filter { it.id != id }
    val count = otherStored.size + pending.size + 1
    val bytes = otherStored.sumOf { it.byteCount } + pending.values.sumOf { it.size } + size
    return when {
      count > limits.maxCount ->
        reject(
          PrototypeMediaRejection.COUNT_LIMIT,
          "At most ${limits.maxCount} media assets; remove one before adding '$id'.",
        )
      bytes > limits.maxTotalBytes ->
        reject(
          PrototypeMediaRejection.TOTAL_LIMIT,
          "Media assets would total $bytes bytes; the limit is ${limits.maxTotalBytes}.",
        )
      else -> null
    }
  }

  private fun chunkProblem(
    upload: Upload,
    offset: Long,
    bytes: ByteArray,
  ): Pair<PrototypeMediaRejection, String>? =
    when {
      offset != upload.received ->
        PrototypeMediaRejection.OFFSET_MISMATCH to
          "Chunk offset $offset; expected ${upload.received}."
      bytes.isEmpty() -> PrototypeMediaRejection.EMPTY_CHUNK to "Chunk has no data."
      bytes.size > limits.maxChunkBytes ->
        PrototypeMediaRejection.CHUNK_TOO_LARGE to "Chunk exceeds ${limits.maxChunkBytes} bytes."
      upload.received + bytes.size > upload.size ->
        PrototypeMediaRejection.OVERFLOW to "Chunk runs past the declared ${upload.size} bytes."
      else -> null
    }

  private fun write(id: String, upload: Upload, bytes: ByteArray): PrototypeMediaResult {
    val room = PrototypeMediaContract.SIGNATURE_PROBE_BYTES - upload.head.size()
    if (room > 0) upload.head.write(bytes, 0, minOf(room, bytes.size))
    if (
      !upload.signatureChecked && upload.head.size() == PrototypeMediaContract.SIGNATURE_PROBE_BYTES
    ) {
      signatureProblem(upload)?.let {
        return fail(id, it.first, it.second)
      }
    }
    if (upload.utf8?.accept(bytes) == false) {
      return fail(id, PrototypeMediaRejection.NOT_UTF8, "WebVTT captions must be valid UTF-8.")
    }
    try {
      upload.partial.append(bytes)
    } catch (error: IOException) {
      return fail(
        id,
        PrototypeMediaRejection.STORAGE_FAILURE,
        "Cannot store media: ${error.message}",
      )
    }
    upload.digest.update(bytes)
    upload.received += bytes.size
    return PrototypeMediaResult.Accepted(upload.received)
  }

  private fun signatureProblem(upload: Upload): Pair<PrototypeMediaRejection, String>? {
    upload.signatureChecked = true
    return if (PrototypeMediaContract.signatureMatches(upload.mimeType, upload.head.toByteArray()))
      null
    else PrototypeMediaRejection.CONTENT_MISMATCH to "Media bytes are not ${upload.mimeType}."
  }

  private fun commitProblem(upload: Upload): Pair<PrototypeMediaRejection, String>? {
    if (upload.received != upload.size) {
      return PrototypeMediaRejection.TRUNCATED to
        "Received ${upload.received} of ${upload.size} bytes."
    }
    if (!upload.signatureChecked) {
      signatureProblem(upload)?.let {
        return it
      }
    }
    if (upload.utf8?.finish() == false) {
      return PrototypeMediaRejection.NOT_UTF8 to "WebVTT captions must be valid UTF-8."
    }
    val actual = upload.digest.digest().joinToString("") { "%02x".format(it) }
    return if (actual == upload.sha256) null
    else PrototypeMediaRejection.SHA256_MISMATCH to "Media bytes do not match the declared sha256."
  }

  /** Drops [id]'s upload with its partial file and returns the rejection. */
  private fun fail(
    id: String,
    reason: PrototypeMediaRejection,
    message: String,
  ): PrototypeMediaResult {
    abort(id)
    return reject(reason, message)
  }

  private fun reject(reason: PrototypeMediaRejection, message: String) =
    PrototypeMediaResult.Rejected(reason, message)

  private companion object {
    val SHA256_HEX = Regex("^[0-9a-f]{64}$")
  }
}

/** Strict streaming UTF-8 check: a code point may span chunks, malformed input is rejected. */
internal class Utf8Validator {
  private val decoder: CharsetDecoder =
    Charsets.UTF_8.newDecoder()
      .onMalformedInput(CodingErrorAction.REPORT)
      .onUnmappableCharacter(CodingErrorAction.REPORT)
  private val out: CharBuffer = CharBuffer.allocate(4096)
  private var carry = ByteArray(0)

  fun accept(bytes: ByteArray): Boolean = decode(carry + bytes, endOfInput = false)

  fun finish(): Boolean = decode(carry, endOfInput = true) && flush()

  private fun decode(bytes: ByteArray, endOfInput: Boolean): Boolean {
    val input = ByteBuffer.wrap(bytes)
    while (true) {
      out.clear()
      val result = decoder.decode(input, out, endOfInput)
      if (result.isError) return false
      if (result.isUnderflow) break
    }
    carry = ByteArray(input.remaining()).also { input.get(it) }
    return !endOfInput || carry.isEmpty()
  }

  private fun flush(): Boolean =
    try {
      out.clear()
      !decoder.flush(out).isError
    } catch (error: CharacterCodingException) {
      // flush reports by result for UTF-8; a thrown coding error is the same malformed-input
      // verdict.
      false
    }
}

package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeBundleErrorCode.*
import java.io.ByteArrayOutputStream
import java.util.zip.CRC32
import java.util.zip.DataFormatException
import java.util.zip.Inflater

internal object PrototypeBundleZipReader {
  private data class Budget(val limit: Long, val code: PrototypeBundleErrorCode)

  fun read(bytes: ByteArray): Map<String, ByteArray> {
    bundleRequire(bytes.size <= PrototypeBundleLimits.MAX_COMPRESSED_BYTES, archive_too_large)
    val entries = PrototypeBundleZipDirectory(bytes).read()
    val compressed = entries.sumOf { it.compressed }
    var expanded = 0L
    val result = linkedMapOf<String, ByteArray>()
    for (entry in entries) {
      val cap = PrototypeBundleLimits.entryCap(entry.name).toLong()
      bundleRequire(entry.expanded <= cap, entry_too_large, entry.name)
      val budget =
        listOf(
            Budget(cap, entry_too_large),
            Budget(PrototypeBundleLimits.MAX_EXPANDED_BYTES - expanded, expanded_too_large),
            Budget(compressed * PrototypeBundleLimits.MAX_RATIO - expanded, ratio_exceeded),
          )
          .minBy { it.limit }
      val output = inflate(bytes, entry, budget)
      expanded += output.size
      bundleRequire(output.size.toLong() == entry.expanded, size_mismatch, entry.name)
      bundleRequire(CRC32().apply { update(output) }.value == entry.crc, crc_mismatch, entry.name)
      result[entry.name] = output
    }
    return result
  }

  private fun inflate(bytes: ByteArray, entry: PrototypeBundleZipEntry, budget: Budget): ByteArray {
    if (entry.method == 0) {
      bundleRequire(entry.compressed <= budget.limit, budget.code, entry.name)
      return bytes.copyOfRange(entry.start, entry.end)
    }
    val inflater = Inflater(true)
    try {
      inflater.setInput(bytes, entry.start, entry.end - entry.start)
      val output = ByteArrayOutputStream()
      val buffer = ByteArray(8192)
      while (!inflater.finished()) {
        // At most one byte beyond the actual budget is ever produced, independent of header sizes.
        val count =
          inflater.inflate(
            buffer,
            0,
            minOf(buffer.size.toLong(), budget.limit + 1 - output.size()).toInt(),
          )
        bundleRequire(output.size().toLong() + count <= budget.limit, budget.code, entry.name)
        output.write(buffer, 0, count)
        bundleRequire(count > 0 || inflater.finished(), size_mismatch, entry.name)
      }
      bundleRequire(inflater.bytesRead == entry.compressed, size_mismatch, entry.name)
      return output.toByteArray()
    } catch (_: DataFormatException) {
      throw PrototypeBundleFailure(size_mismatch, entry.name)
    } finally {
      inflater.end()
    }
  }
}

package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeBundleErrorCode.*
import java.util.Locale

internal data class PrototypeBundleZipEntry(
  val name: String,
  val flags: Int,
  val method: Int,
  val crc: Long,
  val compressed: Long,
  val expanded: Long,
  val offset: Long,
  var start: Int = 0,
  var end: Int = 0,
)

/** Unsigned ZIP32 arithmetic uses Long until bounds have been checked. */
internal class PrototypeBundleZipDirectory(private val bytes: ByteArray) {
  private fun u16(at: Int) = (bytes[at].toInt() and 255) or ((bytes[at + 1].toInt() and 255) shl 8)

  private fun u32(at: Int) = u16(at).toLong() or (u16(at + 2).toLong() shl 16)

  private fun endOfDirectory(): Int {
    val positions = (maxOf(0, bytes.size - 65557)..bytes.size - 4).filter { u32(it) == 0x06054b50L }
    bundleRequire(positions.size == 1, not_a_zip)
    val end = positions.single()
    bundleRequire(end + 22 <= bytes.size, not_a_zip)
    bundleRequire(end < 20 || u32(end - 20) != 0x07064b50L, zip64_unsupported)
    val comment = u16(end + 20)
    bundleRequire(end + 22 + comment == bytes.size, trailing_bytes)
    bundleRequire(comment == 0, extra_field_forbidden)
    bundleRequire(u16(end + 4) == 0 && u16(end + 6) == 0, multi_disk)
    bundleRequire(u16(end + 8) == u16(end + 10), multi_disk)
    bundleRequire(
      u16(end + 10) != 65535 && u32(end + 12) != 0xffffffffL && u32(end + 16) != 0xffffffffL,
      zip64_unsupported,
    )
    bundleRequire(u16(end + 10) <= PrototypeBundleLimits.MAX_ENTRIES, too_many_entries)
    return end
  }

  private fun safeName(raw: ByteArray): String {
    val name = raw.toString(Charsets.UTF_8)
    bundleRequire(
      raw.none { it.toInt() == 0 || it.toInt() and 255 > 127 } && '\\' !in name,
      entry_name_forbidden,
      name,
    )
    bundleRequire(
      !name.startsWith('/') && ".." !in name.split('/') && "__MACOSX" !in name,
      entry_name_forbidden,
      name,
    )
    bundleRequire(!name.endsWith('/'), entry_name_forbidden, name)
    return name
  }

  private fun attributes(at: Int, e: PrototypeBundleZipEntry) {
    val type = (u32(at + 38) shr 16).toInt() and 0xf000
    bundleRequire(type == 0 || type == 0x8000, link_entry, e.name)
    bundleRequire(u32(at + 38) and 0x10 == 0L, link_entry, e.name)
    bundleRequire(e.flags and 0x41 == 0, encrypted_entry, e.name)
    bundleRequire(e.method == 0 || e.method == 8, method_unsupported, e.name)
    bundleRequire(u16(at + 34) == 0, multi_disk, e.name)
    bundleRequire(
      listOf(e.compressed, e.expanded, e.offset).none { it == 0xffffffffL } && u16(at + 6) < 45,
      zip64_unsupported,
      e.name,
    )
    bundleRequire(u16(at + 30) == 0 && u16(at + 32) == 0, extra_field_forbidden, e.name)
    bundleRequire(e.flags and 0x0806.inv() == 0, header_mismatch, e.name)
  }

  private fun local(e: PrototypeBundleZipEntry, directory: Long) {
    bundleRequire(e.offset + 30 <= directory, header_mismatch, e.name)
    val at = e.offset.toInt()
    bundleRequire(u32(at) == 0x04034b50L, header_mismatch, e.name)
    val nameEnd = at + 30 + u16(at + 26)
    bundleRequire(nameEnd <= directory, header_mismatch, e.name)
    bundleRequire(u16(at + 28) == 0, extra_field_forbidden, e.name)
    bundleRequire(
      bytes.copyOfRange(at + 30, nameEnd).contentEquals(e.name.toByteArray(Charsets.US_ASCII)),
      header_mismatch,
      e.name,
    )
    bundleRequire(
      u16(at + 6) == e.flags &&
        u16(at + 8) == e.method &&
        u32(at + 14) == e.crc &&
        u32(at + 18) == e.compressed &&
        u32(at + 22) == e.expanded,
      header_mismatch,
      e.name,
    )
    bundleRequire(u16(at + 4) < 45, zip64_unsupported, e.name)
    bundleRequire(nameEnd + e.compressed <= directory, header_mismatch, e.name)
    e.start = nameEnd
    e.end = (nameEnd + e.compressed).toInt()
  }

  fun read(): List<PrototypeBundleZipEntry> {
    val end = endOfDirectory()
    val directory = u32(end + 16)
    bundleRequire(directory + u32(end + 12) == end.toLong(), header_mismatch)
    var at = directory.toInt()
    val entries = ArrayList<PrototypeBundleZipEntry>()
    val names = HashSet<String>()
    repeat(u16(end + 10)) {
      bundleRequire(at.toLong() + 46 <= end && u32(at) == 0x02014b50L, header_mismatch)
      val next = at + 46 + u16(at + 28) + u16(at + 30) + u16(at + 32)
      bundleRequire(next <= end, header_mismatch)
      val name = safeName(bytes.copyOfRange(at + 46, at + 46 + u16(at + 28)))
      val entry =
        PrototypeBundleZipEntry(
          name,
          u16(at + 8),
          u16(at + 10),
          u32(at + 16),
          u32(at + 20),
          u32(at + 24),
          u32(at + 42),
        )
      attributes(at, entry)
      bundleRequire(names.add(name.lowercase(Locale.ROOT)), duplicate_entry, name)
      entries.add(entry)
      at = next
    }
    bundleRequire(at == end, header_mismatch)
    for (entry in entries) {
      bundleRequire(ENTRY_PATTERN.matches(entry.name), entry_not_allowed, entry.name)
      local(entry, directory)
    }
    var previousEnd = 0L
    for (entry in entries.sortedBy { it.offset }) {
      bundleRequire(entry.offset == previousEnd, header_mismatch, entry.name)
      previousEnd = entry.end.toLong()
    }
    bundleRequire(previousEnd == directory, header_mismatch)
    return entries
  }

  companion object {
    private val ENTRY_PATTERN =
      Regex(
        "(?:bundle\\.json|spec\\.json|assets/[0-9a-f]{64}\\.(?:png|jpg|webp)|fonts/[0-9a-f]{64}\\.(?:ttf|otf))",
      )
  }
}

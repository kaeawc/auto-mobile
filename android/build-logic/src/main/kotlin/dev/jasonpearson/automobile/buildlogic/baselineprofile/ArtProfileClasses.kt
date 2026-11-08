package dev.jasonpearson.automobile.buildlogic.baselineprofile

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.zip.Inflater

/**
 * Lists the class descriptors a compiled ART baseline profile (`assets/dexopt/baseline.prof`, the
 * version AGP packages) marks for loading. The profile stores dex type indexes, so each one is
 * resolved through the matching `classesN.dex` in the same APK.
 */
object ArtProfileClasses {
  private val MAGIC = byteArrayOf('p'.code.toByte(), 'r'.code.toByte(), 'o'.code.toByte(), 0)
  private const val SUPPORTED_VERSION = "010"
  private const val HEADER_SIZE = 17
  private const val DEX_STRING_IDS_OFFSET = 0x38
  private const val BITS_PER_METHOD = 2
  private const val BYTE_MASK = 0xFF
  private const val UNSIGNED_SHORT_MASK = 0xFFFF
  private const val ULEB_CONTINUATION = 0x80

  /** Thrown when the bytes are not a profile this reader understands. */
  class UnsupportedProfileException(message: String) : IllegalArgumentException(message)

  private class DexHeader(
    val key: String,
    val classCount: Int,
    val hotMethodRegionSize: Int,
    val methodCount: Int,
  )

  /** [dexByName] returns the bytes of an APK entry such as `classes2.dex`, or null if absent. */
  fun read(profile: ByteArray, dexByName: (String) -> ByteArray?): Set<String> {
    if (profile.size < HEADER_SIZE || !MAGIC.indices.all { profile[it] == MAGIC[it] }) {
      throw UnsupportedProfileException("not an ART binary profile")
    }
    val version = String(profile, MAGIC.size, SUPPORTED_VERSION.length, Charsets.US_ASCII)
    if (version != SUPPORTED_VERSION) {
      throw UnsupportedProfileException("unsupported ART profile version $version")
    }
    val header = ByteBuffer.wrap(profile).order(ByteOrder.LITTLE_ENDIAN)
    val dexCount = profile[MAGIC.size + SUPPORTED_VERSION.length + 1].toInt() and BYTE_MASK
    val uncompressedSize = header.getInt(HEADER_SIZE - Int.SIZE_BYTES * 2)
    val compressedSize = header.getInt(HEADER_SIZE - Int.SIZE_BYTES)
    val body =
      ByteBuffer.wrap(inflate(profile, HEADER_SIZE, compressedSize, uncompressedSize))
        .order(ByteOrder.LITTLE_ENDIAN)
    val dexHeaders = List(dexCount) { readDexHeader(body) }
    return buildSet {
      for (dex in dexHeaders) {
        body.position(body.position() + dex.hotMethodRegionSize)
        val dexName = dex.key.substringAfterLast('!')
        val types =
          dexByName(dexName)?.let(::typeDescriptors)
            ?: throw UnsupportedProfileException("profile names $dexName, which the APK lacks")
        var typeIndex = 0
        repeat(dex.classCount) {
          typeIndex += body.getShort().toInt() and UNSIGNED_SHORT_MASK
          add(types[typeIndex])
        }
        val bitmapBytes = (dex.methodCount * BITS_PER_METHOD + Byte.SIZE_BITS - 1) / Byte.SIZE_BITS
        body.position(body.position() + bitmapBytes)
      }
    }
  }

  private fun readDexHeader(body: ByteBuffer): DexHeader {
    val keySize = body.getShort().toInt() and UNSIGNED_SHORT_MASK
    val classCount = body.getShort().toInt() and UNSIGNED_SHORT_MASK
    val hotMethodRegionSize = body.getInt()
    body.getInt() // dex checksum
    val methodCount = body.getInt()
    val key = ByteArray(keySize).also { body.get(it) }
    return DexHeader(String(key, Charsets.UTF_8), classCount, hotMethodRegionSize, methodCount)
  }

  private fun inflate(source: ByteArray, offset: Int, length: Int, expectedSize: Int): ByteArray {
    val inflater = Inflater()
    try {
      inflater.setInput(source, offset, length)
      val out = ByteArrayOutputStream(expectedSize)
      val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
      while (!inflater.finished()) {
        val count = inflater.inflate(buffer)
        if (count == 0 && (inflater.needsInput() || inflater.needsDictionary())) break
        out.write(buffer, 0, count)
      }
      val bytes = out.toByteArray()
      if (bytes.size != expectedSize) {
        throw UnsupportedProfileException(
          "profile body is ${bytes.size} bytes, expected $expectedSize",
        )
      }
      return bytes
    } finally {
      inflater.end()
    }
  }

  /** Type descriptors by type index, read from the dex `string_ids` and `type_ids` tables. */
  internal fun typeDescriptors(dex: ByteArray): List<String> {
    val buffer = ByteBuffer.wrap(dex).order(ByteOrder.LITTLE_ENDIAN)
    val stringIdsOffset = buffer.getInt(DEX_STRING_IDS_OFFSET + Int.SIZE_BYTES)
    val typeIdsSize = buffer.getInt(DEX_STRING_IDS_OFFSET + Int.SIZE_BYTES * 2)
    val typeIdsOffset = buffer.getInt(DEX_STRING_IDS_OFFSET + Int.SIZE_BYTES * 3)
    return List(typeIdsSize) { type ->
      val stringIndex = buffer.getInt(typeIdsOffset + type * Int.SIZE_BYTES)
      var position = buffer.getInt(stringIdsOffset + stringIndex * Int.SIZE_BYTES)
      while (dex[position].toInt() and ULEB_CONTINUATION != 0) position++
      position++
      var end = position
      while (dex[end] != 0.toByte()) end++
      // Class descriptors are ASCII apart from rare MUTF-8 names, which UTF-8 decodes the same.
      String(dex, position, end - position, Charsets.UTF_8)
    }
  }
}

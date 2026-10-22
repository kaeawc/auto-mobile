package dev.jasonpearson.automobile.protocol

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.zip.CRC32

internal object PrototypeBundleZipWriter {
  fun write(files: Map<String, ByteArray>): ByteArray {
    val locals = ByteArrayOutputStream()
    val central = ByteArrayOutputStream()
    for ((path, bytes) in files) {
      val name = path.toByteArray(Charsets.US_ASCII)
      val crc = CRC32().apply { update(bytes) }.value.toInt()
      val local =
        ByteBuffer.allocate(30)
          .order(ByteOrder.LITTLE_ENDIAN)
          .apply {
            putInt(0, 0x04034b50)
            putShort(4, 20)
            putShort(12, 0x21)
            putInt(14, crc)
            putInt(18, bytes.size)
            putInt(22, bytes.size)
            putShort(26, name.size.toShort())
          }
          .array()
      val header =
        ByteBuffer.allocate(46)
          .order(ByteOrder.LITTLE_ENDIAN)
          .apply {
            putInt(0, 0x02014b50)
            putShort(4, 20)
            putShort(6, 20)
            putShort(14, 0x21)
            putInt(16, crc)
            putInt(20, bytes.size)
            putInt(24, bytes.size)
            putShort(28, name.size.toShort())
            putInt(42, locals.size())
          }
          .array()
      central.write(header)
      central.write(name)
      locals.write(local)
      locals.write(name)
      locals.write(bytes)
    }
    val end =
      ByteBuffer.allocate(22)
        .order(ByteOrder.LITTLE_ENDIAN)
        .apply {
          putInt(0, 0x06054b50)
          putShort(8, files.size.toShort())
          putShort(10, files.size.toShort())
          putInt(12, central.size())
          putInt(16, locals.size())
        }
        .array()
    locals.write(central.toByteArray())
    locals.write(end)
    return locals.toByteArray()
  }
}

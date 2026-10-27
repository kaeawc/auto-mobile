package dev.jasonpearson.automobile.ctrlproxy

import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Test

class HexFormattingTest {
  @Test
  fun `all byte values match the original formatter`() {
    for (value in 0..255) {
      val byte = value.toByte()
      assertEquals("byte $value", "%02x".format(Locale.ROOT, byte), formatHexByte(byte))
    }
  }

  @Test
  fun `hex bytes stay padded and lowercase under German locale`() {
    val previous = Locale.getDefault()
    try {
      Locale.setDefault(Locale.GERMANY)
      assertEquals(
        "000a7f80ff",
        byteArrayOf(0, 10, 127, -128, -1).joinToString("") { formatHexByte(it) },
      )
    } finally {
      Locale.setDefault(previous)
    }
  }
}

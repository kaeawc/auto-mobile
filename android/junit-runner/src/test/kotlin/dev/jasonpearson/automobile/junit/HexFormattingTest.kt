package dev.jasonpearson.automobile.junit

import java.util.Locale
import kotlin.test.assertEquals
import org.junit.Test

class HexFormattingTest {
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

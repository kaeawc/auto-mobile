package dev.jasonpearson.automobile.ctrlproxy.ime

import org.junit.Assert.assertEquals
import org.junit.Test

class ImeGraphemesTest {
  @Test
  fun `plain ASCII splits without Android ICU`() {
    assertEquals(listOf("h", "i"), ImeGraphemes.split("hi"))
    assertEquals(listOf("`"), ImeGraphemes.split("`"))
    assertEquals(listOf("a"), ImeGraphemes.split("a"))
  }

  @Test
  fun `plain ASCII previous starts without Android ICU`() {
    assertEquals(0, ImeGraphemes.previousStart("hi", 1))
    assertEquals(1, ImeGraphemes.previousStart("hi", 2))
    assertEquals(0, ImeGraphemes.previousStart("`", 1))
    assertEquals(0, ImeGraphemes.previousStart("a", 1))
  }

  @Test
  fun `independent Unicode code points do not need Android ICU`() {
    assertEquals(listOf("日", "本", "😀"), ImeGraphemes.split("日本😀"))
    assertEquals(2, ImeGraphemes.previousStart("日本😀", 4))
  }
}

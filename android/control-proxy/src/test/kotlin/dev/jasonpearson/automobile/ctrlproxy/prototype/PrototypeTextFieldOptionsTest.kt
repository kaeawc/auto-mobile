package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.ui.text.input.KeyboardType
import org.junit.Assert.*
import org.junit.Test

class PrototypeTextFieldOptionsTest {
  @Test
  fun `keyboard types map to their Compose equivalents`() {
    val cases =
      mapOf(
        null to KeyboardType.Text,
        "text" to KeyboardType.Text,
        "number" to KeyboardType.Number,
        "decimal" to KeyboardType.Decimal,
        "email" to KeyboardType.Email,
        "phone" to KeyboardType.Phone,
        "url" to KeyboardType.Uri,
        "password" to KeyboardType.Password,
      )
    for ((type, expected) in cases) {
      assertEquals(expected, prototypeTextFieldKeyboardType(type, null))
      assertEquals(expected, prototypeTextFieldKeyboardType(type, false))
      assertEquals(KeyboardType.Password, prototypeTextFieldKeyboardType(type, true))
    }
  }

  @Test
  fun `either password option enables masking`() {
    assertFalse(prototypeTextFieldSecure(null, null))
    assertFalse(prototypeTextFieldSecure(false, "text"))
    assertTrue(prototypeTextFieldSecure(true, "number"))
    assertTrue(prototypeTextFieldSecure(null, "password"))
    assertTrue(prototypeTextFieldSecure(false, "password"))
  }

  @Test
  fun `clipping preserves legacy input and exact limits`() {
    assertEquals("abcdef", prototypeTextFieldClip("abcdef", null))
    assertEquals("abc", prototypeTextFieldClip("abc", 3))
    assertEquals("abc", prototypeTextFieldClip("abcdef", 3))
    assertEquals("", prototypeTextFieldClip("", 1))
    assertEquals("é", prototypeTextFieldClip("éx", 1))
  }

  @Test
  fun `clipping does not split surrogate pairs`() {
    assertEquals("a", prototypeTextFieldClip("a😀b", 2))
    assertEquals("a😀", prototypeTextFieldClip("a😀b", 3))
    assertEquals("", prototypeTextFieldClip("😀", 1))
    assertEquals("😀", prototypeTextFieldClip("😀", 2))
    assertEquals("a\uD800", prototypeTextFieldClip("a\uD800b", 2))
  }

  @Test
  fun `counter exists only with maxLength and counts UTF-16 units`() {
    assertNull(prototypeTextFieldCounter("abc", null))
    assertEquals("0/4", prototypeTextFieldCounter("", 4))
    assertEquals("3/4", prototypeTextFieldCounter("abc", 4))
    assertEquals("2/4", prototypeTextFieldCounter("😀", 4))
  }
}

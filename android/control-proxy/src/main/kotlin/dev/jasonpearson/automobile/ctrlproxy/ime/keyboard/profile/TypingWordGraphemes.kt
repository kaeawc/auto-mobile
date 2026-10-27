package dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.profile

import android.icu.lang.UCharacter
import dev.jasonpearson.automobile.ctrlproxy.ime.ImeGraphemes

// UProperty.EXTENDED_PICTOGRAPHIC (API 29); preserve the value already inlined on older APIs.
private const val EXTENDED_PICTOGRAPHIC_PROPERTY = 64

internal fun String.insertAt(index: Int, value: String): String =
  substring(0, index) + value + substring(index)

internal fun String.isWordGrapheme(): Boolean {
  val base = codePointAt(0)
  if (!Character.isLetterOrDigit(base) && base != '\''.code) return false
  if (contains('\uFE0F') || contains('\u20E3')) return false
  return base < 0x80 || !UCharacter.hasBinaryProperty(base, EXTENDED_PICTOGRAPHIC_PROPERTY)
}

internal fun String.takeLastWord(): String {
  var index = length
  for (grapheme in ImeGraphemes.split(this).asReversed()) {
    if (!grapheme.isWordGrapheme()) break
    index -= grapheme.length
  }
  return substring(index)
}

internal fun String.takeWhileWord(): String {
  var index = 0
  for (grapheme in ImeGraphemes.split(this)) {
    if (!grapheme.isWordGrapheme()) break
    index += grapheme.length
  }
  return substring(0, index)
}

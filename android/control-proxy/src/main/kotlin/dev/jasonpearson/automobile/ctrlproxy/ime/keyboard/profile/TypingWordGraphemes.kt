package dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.profile

import android.icu.lang.UCharacter
import android.icu.lang.UProperty
import dev.jasonpearson.automobile.ctrlproxy.ime.ImeGraphemes

internal fun String.insertAt(index: Int, value: String): String =
  substring(0, index) + value + substring(index)

internal fun String.isWordGrapheme(): Boolean {
  val base = codePointAt(0)
  if (!Character.isLetterOrDigit(base) && base != '\''.code) return false
  if (contains('\uFE0F') || contains('\u20E3')) return false
  return base < 0x80 || !UCharacter.hasBinaryProperty(base, UProperty.EXTENDED_PICTOGRAPHIC)
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

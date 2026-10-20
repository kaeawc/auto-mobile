package dev.jasonpearson.automobile.ctrlproxy.ime

internal fun String.hasOnlyIndependentCodePoints(): Boolean {
  var index = 0
  while (index < length) {
    val codePoint = Character.codePointAt(this, index)
    if (codePoint.isExtend() || codePoint.isRegionalIndicator() || codePoint.mayJoinAnother()) {
      return false
    }
    index += Character.charCount(codePoint)
  }
  return true
}

// Keep controls (including CR/LF), Hangul, and possible Prepend/Extend characters on ICU's path.
private fun Int.mayJoinAnother(): Boolean =
  when (Character.getType(this)) {
    Character.CONTROL.toInt(),
    Character.FORMAT.toInt(),
    Character.LINE_SEPARATOR.toInt(),
    Character.PARAGRAPH_SEPARATOR.toInt(),
    Character.UNASSIGNED.toInt(),
    Character.PRIVATE_USE.toInt(),
    Character.SURROGATE.toInt() -> true
    Character.OTHER_LETTER.toInt() -> isConjoiningLetter()
    Character.MODIFIER_LETTER.toInt() -> this in 0xff9e..0xff9f
    else -> false
  }

private fun Int.isConjoiningLetter(): Boolean = conjoiningLetterRanges.any { this in it }

// Hangul and the Prepend/SpacingMark letters that must stay on ICU's path.
private val conjoiningLetterRanges =
  listOf(
    0x0d4e..0x0d4e,
    0x0e33..0x0e33,
    0x0eb3..0x0eb3,
    0x1100..0x11ff,
    0xa960..0xa97c,
    0xac00..0xd7a3,
    0xd7b0..0xd7fb,
    0x111c2..0x111c3,
    0x113d1..0x113d1,
    0x1193f..0x1193f,
    0x11941..0x11941,
    0x11a84..0x11a89,
    0x11d46..0x11d46,
    0x11f02..0x11f02,
    0x16d63..0x16d63,
    0x16d67..0x16d6a,
  )

internal fun String.hasOddRegionalIndicatorRunBefore(end: Int): Boolean {
  if (end >= length || !Character.codePointAt(this, end).isRegionalIndicator()) return false
  var index = end
  var count = 0
  while (index > 0) {
    val codePoint = Character.codePointBefore(this, index)
    if (!codePoint.isRegionalIndicator()) break
    count++
    index -= Character.charCount(codePoint)
  }
  return count % 2 == 1
}

internal fun Int.isExtend(): Boolean =
  isCombiningMark() ||
    this == ZERO_WIDTH_JOINER ||
    this == ZERO_WIDTH_NON_JOINER ||
    this in VARIATION_SELECTOR_START..VARIATION_SELECTOR_END ||
    this in SUPPLEMENTARY_VARIATION_SELECTOR_START..SUPPLEMENTARY_VARIATION_SELECTOR_END ||
    this in EMOJI_MODIFIER_START..EMOJI_MODIFIER_END ||
    this in EMOJI_TAG_START..EMOJI_TAG_END

private fun Int.isCombiningMark(): Boolean =
  when (Character.getType(this)) {
    Character.NON_SPACING_MARK.toInt(),
    Character.COMBINING_SPACING_MARK.toInt(),
    Character.ENCLOSING_MARK.toInt() -> true
    else -> false
  }

internal fun Int.isRegionalIndicator(): Boolean =
  this in REGIONAL_INDICATOR_START..REGIONAL_INDICATOR_END

private const val ZERO_WIDTH_NON_JOINER = 0x200c
internal const val ZERO_WIDTH_JOINER = 0x200d
private const val VARIATION_SELECTOR_START = 0xfe00
private const val VARIATION_SELECTOR_END = 0xfe0f
private const val SUPPLEMENTARY_VARIATION_SELECTOR_START = 0xe0100
private const val SUPPLEMENTARY_VARIATION_SELECTOR_END = 0xe01ef
private const val EMOJI_MODIFIER_START = 0x1f3fb
private const val EMOJI_MODIFIER_END = 0x1f3ff
private const val EMOJI_TAG_START = 0xe0020
private const val EMOJI_TAG_END = 0xe007f
private const val REGIONAL_INDICATOR_START = 0x1f1e6
private const val REGIONAL_INDICATOR_END = 0x1f1ff

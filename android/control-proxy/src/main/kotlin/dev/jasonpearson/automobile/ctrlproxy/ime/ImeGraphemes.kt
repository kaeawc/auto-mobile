package dev.jasonpearson.automobile.ctrlproxy.ime

import android.icu.text.BreakIterator
import java.util.Locale

/** Unicode editing units shared by profile composition and automation delivery. */
internal object ImeGraphemes {
  fun split(text: String): List<String> {
    if (text.isEmpty()) return emptyList()
    val breaks = characterBreaks(text)
    val graphemes = mutableListOf<String>()
    var start = 0
    while (start < text.length) {
      var end = nextBoundary(breaks, start)
      while (
        end < text.length &&
          (Character.codePointAt(text, end).isExtend() ||
            Character.codePointBefore(text, end) == ZERO_WIDTH_JOINER ||
            text.hasOddRegionalIndicatorRunBefore(end))
      ) {
        end = nextBoundary(breaks, end)
      }
      graphemes += text.substring(start, end)
      start = end
    }
    return graphemes
  }

  fun previousStart(text: String, cursor: Int): Int {
    require(cursor in 0..text.length)
    if (cursor == 0) return 0
    val breaks = characterBreaks(text)
    var start = previousBoundary(breaks, cursor)
    while (start > 0) {
      val firstCodePoint = Character.codePointAt(text, start)
      val previousCodePoint = Character.codePointBefore(text, start)
      if (
        firstCodePoint.isExtend() ||
          previousCodePoint == ZERO_WIDTH_JOINER ||
          (firstCodePoint.isRegionalIndicator() && text.hasOddRegionalIndicatorRunBefore(start))
      ) {
        start = previousBoundary(breaks, start)
      } else {
        break
      }
    }
    return start
  }

  private fun characterBreaks(text: String): BreakIterator =
    BreakIterator.getCharacterInstance(Locale.ROOT).apply { setText(text) }

  private fun nextBoundary(breaks: BreakIterator, offset: Int): Int =
    breaks.following(offset).takeIf { it != BreakIterator.DONE } ?: offset + 1

  private fun previousBoundary(breaks: BreakIterator, offset: Int): Int =
    breaks.preceding(offset).takeIf { it != BreakIterator.DONE } ?: 0

  private fun String.hasOddRegionalIndicatorRunBefore(end: Int): Boolean {
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

  private fun Int.isExtend(): Boolean =
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

  private fun Int.isRegionalIndicator(): Boolean =
    this in REGIONAL_INDICATOR_START..REGIONAL_INDICATOR_END

  private const val ZERO_WIDTH_NON_JOINER = 0x200c
  private const val ZERO_WIDTH_JOINER = 0x200d
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
}

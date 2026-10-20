package dev.jasonpearson.automobile.ctrlproxy.ime

import android.icu.text.BreakIterator
import java.util.Locale

/** Unicode editing units shared by profile composition and automation delivery. */
internal object ImeGraphemes {
  fun split(text: String): List<String> {
    if (text.isEmpty()) return emptyList()
    if (text.hasOnlyIndependentCodePoints()) {
      val graphemes = mutableListOf<String>()
      var start = 0
      while (start < text.length) {
        val end = start + Character.charCount(Character.codePointAt(text, start))
        graphemes += text.substring(start, end)
        start = end
      }
      return graphemes
    }
    val breaks = characterBreaks(text)
    val graphemes = mutableListOf<String>()
    var start = 0
    while (start < text.length) {
      var end = nextBoundary(breaks, start)
      while (end < text.length && text.joinsPreviousGraphemeAt(end)) {
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
    if (text.hasOnlyIndependentCodePoints()) {
      return cursor - Character.charCount(Character.codePointBefore(text, cursor))
    }
    val breaks = characterBreaks(text)
    var start = previousBoundary(breaks, cursor)
    while (start > 0) {
      val firstCodePoint = Character.codePointAt(text, start)
      val previousCodePoint = Character.codePointBefore(text, start)
      val joinsPreviousGrapheme =
        firstCodePoint.isExtend() ||
          previousCodePoint == ZERO_WIDTH_JOINER ||
          (firstCodePoint.isRegionalIndicator() && text.hasOddRegionalIndicatorRunBefore(start))
      if (joinsPreviousGrapheme) {
        start = previousBoundary(breaks, start)
      } else {
        break
      }
    }
    return start
  }

  private fun String.joinsPreviousGraphemeAt(end: Int): Boolean =
    Character.codePointAt(this, end).isExtend() ||
      Character.codePointBefore(this, end) == ZERO_WIDTH_JOINER ||
      hasOddRegionalIndicatorRunBefore(end)

  private fun characterBreaks(text: String): BreakIterator =
    BreakIterator.getCharacterInstance(Locale.ROOT).apply { setText(text) }

  private fun nextBoundary(breaks: BreakIterator, offset: Int): Int =
    breaks.following(offset).takeIf { it != BreakIterator.DONE } ?: offset + 1

  private fun previousBoundary(breaks: BreakIterator, offset: Int): Int =
    breaks.preceding(offset).takeIf { it != BreakIterator.DONE } ?: 0
}

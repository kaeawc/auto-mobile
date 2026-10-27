package dev.jasonpearson.automobile.protocol

/** Formatting-independent ASCII number used only to choose text motion. */
fun parseContentTransitionNumber(text: String): Double? {
  val token = StringBuilder()
  var digits = false
  var decimal = false
  for (character in text) {
    when {
      character in '0'..'9' -> {
        token.append(character)
        digits = true
      }
      character == '.' && !decimal -> {
        token.append(character)
        decimal = true
      }
      character == '-' && token.isEmpty() -> token.append(character)
    }
  }
  return if (digits) token.toString().toDoubleOrNull()?.takeIf { it.isFinite() } else null
}

fun contentTransitionDirection(previous: String, next: String): String {
  val before = parseContentTransitionNumber(previous)
  val after = parseContentTransitionNumber(next)
  return when {
    before == null || after == null || before == after -> "crossfade"
    after > before -> "up"
    else -> "down"
  }
}

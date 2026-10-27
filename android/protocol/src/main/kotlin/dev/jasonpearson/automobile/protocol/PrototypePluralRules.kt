package dev.jasonpearson.automobile.protocol

/** CLDR integer plural categories for the languages the prototype string tables support. */
internal object PrototypePluralRules {
  private val alwaysOther = setOf("ja", "zh", "ko", "vi", "th", "id", "ms", "lo", "km", "my")
  private val oneUpToOne = setOf("fr", "pt", "hi", "bn", "fa", "gu", "kn", "am")
  private val slavic = setOf("ru", "uk", "be", "pl")

  fun category(lang: String, count: Double): String =
    if (count.isFinite() && count in 0.0..9007199254740991.0 && count % 1 == 0.0)
      integerCategory(lang, count.toLong())
    else "other"

  private fun integerCategory(lang: String, n: Long): String =
    when (lang) {
      in alwaysOther -> "other"
      in oneUpToOne -> if (n <= 1) "one" else "other"
      in slavic -> slavic(lang, n)
      "cs",
      "sk" -> czech(n)
      "ar" -> arabic(n)
      else -> if (n == 1L) "one" else "other"
    }

  private fun czech(n: Long): String =
    when (n) {
      1L -> "one"
      in 2L..4L -> "few"
      else -> "other"
    }

  private fun slavic(lang: String, n: Long): String =
    when {
      if (lang == "pl") n == 1L else n % 10 == 1L && n % 100 != 11L -> "one"
      n % 10 in 2L..4L && n % 100 !in 12L..14L -> "few"
      else -> "many"
    }

  private fun arabic(n: Long): String =
    when {
      n == 0L -> "zero"
      n == 1L -> "one"
      n == 2L -> "two"
      n % 100 in 3L..10L -> "few"
      n % 100 in 11L..99L -> "many"
      else -> "other"
    }
}

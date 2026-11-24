package dev.jasonpearson.automobile.buildlogic.sdk

/**
 * The `build-android-compileSdk` catalog value: `"<major>"` or `"<major>.<minor>"` (for example
 * `"37.1"`). AndroidX libraries can require a minor SDK release in their AAR metadata, which a
 * plain Int compileSdk cannot express, so the convention plugins pass both parts to AGP's
 * `compileSdk { version = release(major) { minorApiLevel = minor } }` DSL.
 */
data class AndroidCompileSdk(val major: Int, val minor: Int) {
  companion object {
    private val FORMAT = Regex("""(\d+)(?:\.(\d+))?""")

    fun parse(value: String): AndroidCompileSdk {
      val match =
        FORMAT.matchEntire(value.trim())
          ?: throw IllegalArgumentException(
            "build-android-compileSdk must be <major> or <major>.<minor>, got '$value'"
          )
      return AndroidCompileSdk(
        major = match.groupValues[1].toInt(),
        minor = match.groupValues[2].ifEmpty { "0" }.toInt(),
      )
    }
  }
}

package dev.jasonpearson.automobile.buildlogic.sdk

// The build-android-compileSdk catalog value: "<major>" or "<major>.<minor>" (for example "37.1").
// AndroidX libraries can require a minor SDK release in their AAR metadata, which a plain Int
// compileSdk cannot express, so the convention plugins pass both parts to AGP's
// compileSdk { version = release(major) { minorApiLevel = minor } } DSL.
data class AndroidCompileSdk(val major: Int, val minor: Int) {
  companion object {
    private const val KEY = "build-android-compileSdk"
    private val FORMAT = Regex("""(\d+)(?:\.(\d+))?""")

    fun parse(value: String): AndroidCompileSdk {
      val match = FORMAT.matchEntire(value.trim())
      require(match != null) { "$KEY must be <major> or <major>.<minor>, got '$value'" }
      val (major, minor) = match.destructured
      return AndroidCompileSdk(major.toInt(), minor.ifEmpty { "0" }.toInt())
    }
  }
}

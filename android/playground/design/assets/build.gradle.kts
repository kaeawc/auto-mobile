plugins {
  id("automobile.android-library")
}

android {
  namespace = "dev.jasonpearson.automobile.design.assets"

  defaultConfig {
    // Preserve this resource-only module's absence of an instrumentation runner.
    testInstrumentationRunner = null
  }
}

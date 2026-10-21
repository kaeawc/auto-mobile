plugins {
  id("automobile.android-library")
  alias(libs.plugins.compose.compiler)
}

android {
  namespace = "dev.jasonpearson.automobile.slides"

  buildFeatures { compose = true }

  lint {
    // Disable the problematic Compose UI lint check that has a known crash
    disable += "ConfigurationScreenWidthHeight"

    // Disable UnsafeOptInUsageError since we've already configured the Kotlin compiler
    // to opt-in to Media3's UnstableApi via freeCompilerArgs
    disable += "UnsafeOptInUsageError"
  }
}

dependencies {
  implementation(libs.androidx.core)
  implementation(libs.androidx.appcompat)
  implementation(libs.material)

  implementation(projects.playground.design.system)
  implementation(projects.playground.experimentation)
  implementation(projects.autoMobileSdk)

  // Compose dependencies
  implementation(platform(libs.compose.bom))
  implementation(libs.bundles.compose.ui)
  implementation(libs.androidx.lifecycle.viewmodel.ktx)
  implementation(libs.androidx.lifecycle.runtime)

  // Lifecycle compose integration
  implementation(libs.androidx.lifecycle.viewmodel.compose)

  // Kotlin coroutines
  implementation(libs.kotlinx.coroutines)

  // Media libraries for images and video
  implementation(libs.bundles.media.libraries)

  testImplementation(libs.junit)
  testImplementation(libs.mockk)
  debugImplementation(libs.bundles.compose.ui.debug)
  testImplementation(projects.junitRunner)
}

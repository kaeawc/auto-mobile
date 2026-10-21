plugins {
  id("automobile.android-library")
  alias(libs.plugins.compose.compiler)
  alias(libs.plugins.kotlin.serialization)
}

android {
  namespace = "dev.jasonpearson.automobile.discover"

  buildFeatures { compose = true }
}

dependencies {
  implementation(libs.androidx.core)
  implementation(libs.androidx.appcompat)
  implementation(libs.material)

  // Internal modules
  implementation(projects.playground.storage)
  implementation(projects.playground.mediaplayer)
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
  implementation(libs.kotlinx.serialization)

  // Image loading
  implementation(libs.coil.compose)
  implementation(libs.coil.network.okhttp)

  testImplementation(libs.junit)
  testImplementation(libs.kotlinx.coroutines)
  testImplementation(libs.kotlinx.coroutines.test)
  testImplementation(projects.junitRunner)
}

plugins {
  id("automobile.android-library")
  alias(libs.plugins.compose.compiler)
}

android {
  namespace = "dev.jasonpearson.automobile.onboarding"

  buildFeatures { compose = true }
}

dependencies {
  implementation(libs.androidx.core)
  implementation(libs.androidx.appcompat)
  implementation(libs.material)

  // Image loading
  implementation(libs.coil.compose)
  implementation(libs.coil.network.okhttp)

  // Storage module
  implementation(projects.playground.storage)
  implementation(projects.playground.experimentation)
  implementation(projects.autoMobileSdk)

  // Design system module
  implementation(projects.playground.design.assets)
  implementation(projects.playground.design.system)

  // Compose dependencies
  implementation(platform(libs.compose.bom))
  implementation(libs.bundles.compose.ui)
  implementation(libs.androidx.lifecycle.viewmodel.ktx)
  implementation(libs.androidx.lifecycle.runtime)

  // Lifecycle compose integration
  implementation(libs.androidx.lifecycle.viewmodel.compose)

  // Kotlin coroutines
  implementation(libs.kotlinx.coroutines)

  testImplementation(libs.junit)
  testImplementation(projects.junitRunner)
}

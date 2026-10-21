plugins {
  id("automobile.android-library")
  alias(libs.plugins.compose.compiler)
}

android {
  namespace = "dev.jasonpearson.automobile.login"

  buildFeatures { compose = true }
}

dependencies {
  implementation(libs.androidx.core)
  implementation(libs.androidx.appcompat)
  implementation(libs.material)

  // Compose dependencies
  implementation(platform(libs.compose.bom))
  implementation(libs.bundles.compose.ui)
  implementation(libs.androidx.lifecycle.viewmodel.ktx)
  implementation(libs.androidx.lifecycle.runtime)
  implementation(libs.androidx.lifecycle.viewmodel.compose)

  // Navigation Compose
  implementation(libs.navigation3.runtime)

  // Playground module dependencies
  implementation(projects.playground.experimentation)
  implementation(projects.playground.design.system)
  implementation(projects.playground.storage)
  implementation(projects.autoMobileSdk)

  // Kotlin coroutines
  implementation(libs.kotlinx.coroutines)

  testImplementation(libs.junit)
  testImplementation(projects.junitRunner)
}

plugins {
  id("automobile.android-library")
  alias(libs.plugins.compose.compiler)
}

android {
  namespace = "dev.jasonpearson.automobile.experimentation"

  buildFeatures { compose = true }
}

dependencies {
  implementation(libs.androidx.core)
  implementation(libs.androidx.appcompat)
  implementation(libs.material)

  // Storage module
  implementation(projects.playground.storage)

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
}

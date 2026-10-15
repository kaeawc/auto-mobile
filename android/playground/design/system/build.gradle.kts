plugins {
  id("automobile.android-library")
  alias(libs.plugins.compose.compiler)
}

android {
  namespace = "dev.jasonpearson.automobile.design.system"

  buildFeatures { compose = true }
}

dependencies {
  implementation(libs.androidx.core)
  implementation(libs.androidx.appcompat)
  implementation(libs.material)

  // Design assets module for logo resources
  implementation(projects.playground.design.assets)

  // Experimentation module for party mode logic
  implementation(projects.playground.experimentation)

  // Compose dependencies
  implementation(platform(libs.compose.bom))
  implementation(libs.bundles.compose.ui)
  implementation(libs.androidx.lifecycle.viewmodel.ktx)
  implementation(libs.androidx.lifecycle.runtime)

  // Lifecycle compose integration
  implementation(libs.androidx.lifecycle.viewmodel.compose)

  // Image loading with Coil
  implementation(libs.coil.compose)
  implementation(libs.coil.network.okhttp)

  // Kotlin coroutines
  implementation(libs.kotlinx.coroutines)

  testImplementation(libs.junit)
}

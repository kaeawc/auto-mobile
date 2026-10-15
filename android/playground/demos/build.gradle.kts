plugins {
  id("automobile.android-library")
  alias(libs.plugins.compose.compiler)
}

android {
  namespace = "dev.jasonpearson.automobile.demos"

  buildFeatures { compose = true }
}

dependencies {
  implementation(libs.androidx.core)
  implementation(libs.androidx.appcompat)
  implementation(libs.material)

  // Compose dependencies
  implementation(platform(libs.compose.bom))
  implementation(libs.bundles.compose.ui)

  implementation(projects.playground.design.system)

  // AutoMobile SDK utilities
  implementation(projects.autoMobileSdk)

  // OkHttp for network test demo
  implementation(libs.okhttp)

  // Coil for image loading
  implementation(libs.coil.compose)
  implementation(libs.coil.network.okhttp)

  testImplementation(libs.junit)
  testImplementation(projects.junitRunner)
}

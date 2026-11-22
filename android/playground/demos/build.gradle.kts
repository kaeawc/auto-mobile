plugins {
  id("automobile.android-library")
  alias(libs.plugins.compose.compiler)
}

android {
  namespace = "dev.jasonpearson.automobile.demos"

  buildFeatures { compose = true }

  // The committed prototype-embedding sample (generated from automobile:prototype/native) compiles
  // into this module unchanged, so the embedding contract is exercised against the real library.
  sourceSets.getByName("main") {
    kotlin.directories.add("../../../samples/prototype-embedding/android/app/src/main/java")
    assets.srcDir("../../../samples/prototype-embedding/android/app/src/main/assets")
  }
}

dependencies {
  implementation(libs.androidx.core)
  implementation(libs.androidx.appcompat)
  implementation(libs.material)

  // Compose dependencies
  implementation(platform(libs.compose.bom))
  implementation(libs.bundles.compose.ui)

  implementation(projects.playground.design.system)

  // Native prototype renderer, embedded by the "Embedded Prototype" demo
  implementation(projects.prototypeCompose)

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

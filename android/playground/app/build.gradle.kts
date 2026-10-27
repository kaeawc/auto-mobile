plugins {
  id("automobile.kotlin-common")
  id("automobile.robolectric-sdk-pin")
  id("automobile.android-app-signing")
  id("automobile.android-application")
  alias(libs.plugins.compose.compiler)
  alias(libs.plugins.kotlin.serialization)
}

android {
  namespace = "dev.jasonpearson.automobile.playground"

  defaultConfig {
    applicationId = "dev.jasonpearson.automobile.playground"
    versionCode = 1
  }

  buildTypes {
    release {
      isMinifyEnabled = false
    }
  }
  testOptions { unitTests { isIncludeAndroidResources = true } }
  buildFeatures {
    compose = true
    buildConfig = true
  }
}

dependencies {
  implementation(libs.androidx.core)
  // AppCompatActivity probe screen (AppCompatProbeActivity) for window-callback wrapping checks
  implementation(libs.androidx.appcompat)
  implementation(libs.androidx.lifecycle.runtime)
  implementation(libs.androidx.startup)
  implementation(platform(libs.compose.bom))
  implementation(libs.bundles.compose.ui)

  // Lifecycle compose integration
  implementation(libs.androidx.lifecycle.viewmodel.compose)

  // Kotlin coroutines
  implementation(libs.kotlinx.coroutines)

  // Navigation 3
  implementation(libs.navigation3.runtime)
  implementation(libs.navigation3.ui)

  // Kotlinx Serialization for navigation
  implementation(libs.kotlinx.serialization)

  // Media libraries for initializers
  implementation(libs.coil.compose)
  implementation(libs.coil.network.okhttp)

  // OkHttp for network interceptor
  implementation(libs.okhttp)

  // Splash Screen API support for Android 12+ backported to API 23+
  implementation(libs.androidx.core.splashscreen)

  // AutoMobile SDK for navigation tracking
  implementation(projects.autoMobileSdk)

  // Playground module dependencies
  implementation(projects.playground.design.system)
  implementation(projects.playground.login)
  implementation(projects.playground.home)
  implementation(projects.playground.discover)
  implementation(projects.playground.settings)
  implementation(projects.playground.mediaplayer)
  implementation(projects.playground.onboarding)
  implementation(projects.playground.slides)
  implementation(projects.playground.storage)
  implementation(projects.playground.demos)
  implementation(projects.playground.experimentation)
  implementation(libs.androidx.lifecycle.viewmodel.navigation3.android)

  // Test dependencies
  testImplementation(libs.bundles.unit.test)
  testImplementation(projects.junitRunner)
  testImplementation(libs.robolectric)

  // Media3 annotation marker for opt-in (needed for compile-time opt-in checks)
  // Since the app uses androidx.media3.common.util.UnstableApi opt-in annotation,
  // we need the media3 library available at compile time
  compileOnly(libs.media3.exoplayer)
  testCompileOnly(libs.media3.exoplayer)

  // Debug dependencies
  debugImplementation(libs.bundles.compose.ui.debug)
}

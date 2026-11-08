plugins {
  id("automobile.android-application")
  id("automobile.robolectric-sdk-pin")
  alias(libs.plugins.compose.compiler)
}

// Deterministic Compose for TV fixture: browse rows of cards that reveal more cards on D-pad
// advance, a search field, a detail screen and a player whose MediaSession reacts to media keys.
// No network, no video decoding and no Google account; it needs API 28 or later.
android {
  namespace = "dev.jasonpearson.automobile.tvfixture"
  defaultConfig {
    // Android TV images the emulator lane boots start well above this; Compose needs 23 and up.
    minSdk = 28
    applicationId = "dev.jasonpearson.automobile.tvfixture"
    versionCode = 1
  }
  buildFeatures { compose = true }
  testOptions { unitTests.isIncludeAndroidResources = true }
}

dependencies {
  implementation(platform(libs.compose.bom))
  implementation(libs.androidx.activity.compose)
  implementation(libs.androidx.core)
  implementation(libs.compose.ui.core)
  implementation(libs.compose.ui.foundation)
  implementation(libs.tv.material)
  // AutoMobile SDK: each screen reports a navigation event so explore and navigateTo work (#17421).
  implementation(projects.autoMobileSdk)

  testImplementation(libs.junit)
  testImplementation(libs.robolectric)
  testImplementation(libs.compose.ui.junit)
  debugImplementation(libs.compose.ui.test.manifest)
}

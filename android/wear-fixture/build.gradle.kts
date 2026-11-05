plugins {
  id("automobile.android-application")
  id("automobile.robolectric-sdk-pin")
  alias(libs.plugins.compose.compiler)
}

// Deterministic Wear OS fixture: a long list with a detail screen, a crown-only picker, a
// swipe-to-dismiss screen, a confirmation dialog, a tile, a complication data source, a
// notification
// with two actions and an ongoing activity. No network and no Google account, so it installs on any
// Wear image.
android {
  namespace = "dev.jasonpearson.automobile.wearfixture"
  defaultConfig {
    // Wear OS 3 (API 30) is the oldest image the emulator lane boots; tiles need 26 and up.
    minSdk = 30
    applicationId = "dev.jasonpearson.automobile.wearfixture"
    versionCode = 1
  }
  buildFeatures { compose = true }
}

dependencies {
  implementation(platform(libs.compose.bom))
  implementation(libs.androidx.activity.compose)
  implementation(libs.androidx.concurrent.futures)
  implementation(libs.androidx.core)
  implementation(libs.compose.ui.core)
  implementation(libs.wear.compose.foundation)
  implementation(libs.wear.compose.material3)
  implementation(libs.wear.tiles)
  implementation(libs.wear.protolayout)
  implementation(libs.wear.complications.data.source)
  implementation(libs.wear.ongoing)

  testImplementation(libs.junit)
  testImplementation(libs.robolectric)
}

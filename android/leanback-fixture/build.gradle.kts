plugins {
  id("automobile.android-application")
  id("automobile.robolectric-sdk-pin")
}

// Deterministic Leanback fixture: a BrowseSupportFragment with a headers column and rows of cards
// that reveal more cards on D-pad advance, plus a detail screen. It covers the View-based Leanback
// focus model next to the Compose for TV fixture. No network and no Google account.
android {
  namespace = "dev.jasonpearson.automobile.leanbackfixture"
  defaultConfig {
    minSdk = 28
    applicationId = "dev.jasonpearson.automobile.leanbackfixture"
    versionCode = 1
  }
  testOptions { unitTests.isIncludeAndroidResources = true }
}

dependencies {
  implementation(libs.androidx.core)
  implementation(libs.androidx.leanback)
  // AutoMobile SDK: each screen reports a navigation event so explore and navigateTo work (#17421).
  implementation(projects.autoMobileSdk)

  testImplementation(libs.junit)
  testImplementation(libs.robolectric)
}

plugins {
  id("automobile.android-application")
  id("automobile.robolectric-sdk-pin")
}

// Deterministic Android Automotive OS fixture: a media browse tree, Car App Library templates and
// one driving-safe plus one parked-only activity. No network and no Google services, so it installs
// on non-Play AAOS images.
android {
  namespace = "dev.jasonpearson.automobile.automotivefixture"
  defaultConfig {
    // Android Automotive OS starts at API 29; androidx.car.app:app-automotive needs it too.
    minSdk = 29
    applicationId = "dev.jasonpearson.automobile.automotivefixture"
    versionCode = 1
  }
}

dependencies {
  implementation(libs.androidx.car.app)
  implementation(libs.androidx.car.app.automotive)

  testImplementation(libs.junit)
  testImplementation(libs.robolectric)
}

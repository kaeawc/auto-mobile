plugins {
  id("automobile.android-application")
}

android {
  namespace = "dev.jasonpearson.automobile.glassesfixture"
  defaultConfig {
    minSdk = 28
    applicationId = "dev.jasonpearson.automobile.glassesfixture"
    versionCode = 1
  }
}

dependencies {
  implementation(libs.androidx.core)

  testImplementation(libs.junit)
}

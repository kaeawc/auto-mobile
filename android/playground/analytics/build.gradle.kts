plugins {
  id("automobile.android-library")
}

android {
  namespace = "dev.jasonpearson.automobile.analytics"
}

dependencies {
  implementation(libs.androidx.core)
  implementation(libs.androidx.appcompat)
  implementation(libs.material)
  testImplementation(libs.junit)
}

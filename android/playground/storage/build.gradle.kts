plugins {
  id("automobile.android-library")
}

android {
  namespace = "dev.jasonpearson.automobile.storage"
}

dependencies {
  implementation(libs.androidx.core)
  implementation(libs.androidx.appcompat)
  implementation(libs.material)

  // Kotlin coroutines
  implementation(libs.kotlinx.coroutines)
  implementation(libs.kotlinx.serialization)

  testImplementation(libs.junit)
}

plugins {
  id("automobile.kotlin-common")
  kotlin("jvm")
  kotlin("plugin.serialization")
}

kotlin {
  explicitApi()
}

java {
  toolchain { languageVersion.set(JavaLanguageVersion.of(libs.versions.build.java.target.get())) }
}

dependencies {
  implementation(libs.kotlinx.coroutines)
  implementation(libs.kotlinx.serialization)
}

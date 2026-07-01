plugins {
  kotlin("jvm")
  alias(libs.plugins.kotlin.serialization)
  kotlin("plugin.compose")
  alias(libs.plugins.compose.multiplatform)
  alias(libs.plugins.metro)
}

repositories {
  google()
  mavenCentral()
}

java {
  toolchain { languageVersion.set(JavaLanguageVersion.of(libs.versions.build.java.target.get())) }
}

sourceSets {
  named("main") { resources.srcDir(rootProject.projectDir.parentFile.resolve("schemas")) }
}

dependencies {
  // Domain module
  api(project(":desktop-domain"))

  // Shared modules
  implementation(project(":protocol"))
  implementation(project(":test-plan-validation"))

  // Compose Desktop
  implementation(compose.desktop.currentOs)
  implementation(compose.material3)
  implementation(compose.materialIconsExtended)

  // Kotlin ecosystem
  implementation(libs.kotlinx.coroutines)
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-swing:1.11.0")
  implementation(libs.kotlinx.serialization)

  // YAML and JSON schema validation
  implementation(libs.snakeyaml)
  implementation(libs.json.schema.validator)

  // Metro DI
  implementation(libs.metro.runtime)

  // Test dependencies
  testImplementation(libs.kotlin.test)
  testImplementation(libs.kotlinx.coroutines.test)
  testImplementation("junit:junit:4.13.2")
  testImplementation(libs.turbine)
  testImplementation(compose.desktop.uiTestJUnit4)
  testImplementation(compose.desktop.currentOs)
}

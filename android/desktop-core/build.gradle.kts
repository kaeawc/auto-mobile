import groovy.json.JsonSlurper

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

// Stamp the package version into the jar manifest so the desktop daemon socket client can declare
// its build to the daemon's version handshake gate (#2744), mirroring the JUnit runner. Resolve the
// repo-root package.json relative to THIS project's dir (android/desktop-core), not the root
// project's — desktop-core is also built inside the standalone android/ide-plugin Gradle build,
// whose root would otherwise resolve to a nonexistent android/package.json and fail configuration.
val npmPackageVersion =
    providers.fileContents(layout.projectDirectory.file("../../package.json")).asText.map { packageJson ->
      (JsonSlurper().parseText(packageJson) as Map<*, *>)["version"].toString()
    }

tasks.named<Jar>("jar") {
  manifest { attributes("Implementation-Version" to npmPackageVersion.get()) }
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

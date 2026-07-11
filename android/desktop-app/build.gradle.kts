import org.jetbrains.compose.desktop.application.dsl.TargetFormat
import org.jetbrains.compose.reload.gradle.ComposeHotRun

plugins {
  kotlin("jvm")
  alias(libs.plugins.kotlin.serialization)
  kotlin("plugin.compose")
  alias(libs.plugins.compose.multiplatform)
  alias(libs.plugins.compose.hot.reload)
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
  // Shared module (UX, unix socket architecture, settings, data sources)
  implementation(project(":desktop-core"))

  // Compose Desktop
  implementation(compose.desktop.currentOs)
  implementation(compose.material3)
  implementation(compose.materialIconsExtended)

  // Kotlin ecosystem
  implementation(libs.kotlinx.coroutines)
  implementation(libs.kotlinx.serialization)

  // Metro DI
  implementation(libs.metro.runtime)

  // Test dependencies
  testImplementation(libs.kotlin.test)
  testImplementation(libs.kotlinx.coroutines.test)
}

compose.desktop {
  application {
    mainClass = "dev.jasonpearson.automobile.desktop.MainKt"
    nativeDistributions {
      targetFormats(TargetFormat.Dmg, TargetFormat.Msi, TargetFormat.Deb)
      packageName = "AutoMobile"
      packageVersion = "1.0.0"
      description = "AutoMobile Desktop - Device automation and testing dashboard"
      vendor = "AutoMobile"

      linux { iconFile.set(project.file("src/main/resources/icons/app-icon.png")) }
      macOS { iconFile.set(project.file("src/main/resources/icons/app-icon.icns")) }
      windows { iconFile.set(project.file("src/main/resources/icons/app-icon.ico")) }
    }
  }
}

// Compose Hot Reload: `./gradlew :desktop-app:hotRun --autoReload` launches the desktop
// dashboard with live UI reloading. Composables live in :desktop-core (an implementation
// dependency), so edits there reload into the running window without a restart.
tasks.withType<ComposeHotRun>().configureEach {
  mainClass.set("dev.jasonpearson.automobile.desktop.MainKt")
}

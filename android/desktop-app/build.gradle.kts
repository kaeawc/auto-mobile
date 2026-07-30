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

// --- Native installer versioning ---------------------------------------------
// The installer version is driven from the release version so the DMG/MSI/Deb
// identity matches the npm/Maven coordinates. The release workflows pass
// `-PdesktopPackageVersion=<version>` (plain semver, no leading v); local builds
// fall back to VERSION_NAME. jpackage accepts only MAJOR.MINOR.PATCH, so any
// `-SNAPSHOT`/build-metadata suffix is stripped and missing parts default to 0.
// Accepted limitation: jpackage has no field for a prerelease qualifier, so a
// prerelease (0.1.0-rc.1) packages with the same OS-level version as its 0.1.0
// final. Prereleases are rare and the npm/tag identity still distinguishes them;
// revisit if desktop RCs ship regularly.
val desktopReleaseVersion: String =
  (findProperty("desktopPackageVersion") as String?)
    ?: (findProperty("VERSION_NAME") as String?)
    ?: "0.0.0"

fun normalizeSemver(raw: String): Triple<Int, Int, Int> {
  val core = raw.substringBefore('-').substringBefore('+')
  val parts = core.split('.')
  fun part(i: Int) = parts.getOrNull(i)?.toIntOrNull() ?: 0
  return Triple(part(0), part(1), part(2))
}

val desktopPackageVersion: String =
  normalizeSemver(desktopReleaseVersion).let { (major, minor, patch) -> "$major.$minor.$patch" }

// jpackage on macOS rejects a major version of 0 (CFBundleVersion's first
// component must be > 0), and our pre-1.0 line is 0.0.x. Floor the macOS major at
// 1 (0.0.47 -> 1.0.47) so DMG packaging succeeds; MSI/Deb keep the real version.
// Monotonic within the 0.0.x line — revisit when the project reaches a real 1.0.0.
val desktopMacPackageVersion: String =
  normalizeSemver(desktopReleaseVersion).let { (major, minor, patch) ->
    "${if (major == 0) 1 else major}.$minor.$patch"
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
      packageVersion = desktopPackageVersion
      description = "AutoMobile Desktop - Device automation and testing dashboard"
      vendor = "AutoMobile"

      // Custom installer icons are intentionally omitted for now: the committed
      // app-icon.{icns,ico,png} are 1x1 placeholder stubs (the .icns is in fact a
      // PNG), which jpackage would reject or embed as a broken icon. jpackage
      // falls back to its default icon until real branded assets replace them.
      macOS {
        bundleID = "dev.jasonpearson.automobile.desktop"
        // jpackage rejects a 0 major on macOS; use the floored version here.
        packageVersion = desktopMacPackageVersion
        // Sign only when the release workflow provides a Developer ID identity
        // (MACOS_SIGN=true). Notarization + stapling is done by the workflow with
        // notarytool after this signed DMG is built, matching the pattern used by
        // the ScreenCaptureKit helper release. Local/unsigned builds leave sign off.
        signing {
          sign.set(
            project.providers.environmentVariable("MACOS_SIGN").map { it == "true" }.orElse(false)
          )
          identity.set(
            project.providers.environmentVariable("MACOS_DEVELOPER_ID_SIGNING_IDENTITY").orElse("")
          )
        }
      }
    }
  }
}

// Compose Hot Reload: `./gradlew :desktop-app:hotRun --autoReload` launches the desktop
// dashboard with live UI reloading. Composables live in :desktop-core (an implementation
// dependency), so edits there reload into the running window without a restart.
tasks.withType<ComposeHotRun>().configureEach {
  mainClass.set("dev.jasonpearson.automobile.desktop.MainKt")
}

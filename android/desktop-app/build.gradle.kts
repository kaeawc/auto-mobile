import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import java.util.zip.ZipOutputStream
import org.gradle.api.artifacts.transform.InputArtifact
import org.gradle.api.artifacts.transform.TransformAction
import org.gradle.api.artifacts.transform.TransformOutputs
import org.gradle.api.artifacts.transform.TransformParameters
import org.jetbrains.compose.desktop.application.dsl.TargetFormat
import org.jetbrains.compose.reload.gradle.ComposeHotRun

plugins {
  id("automobile.kotlin-common")
  kotlin("jvm")
  alias(libs.plugins.kotlin.serialization)
  kotlin("plugin.compose")
  alias(libs.plugins.compose.multiplatform)
  alias(libs.plugins.compose.hot.reload)
  alias(libs.plugins.metro)
  // Conveyor packaging + auto-update (POC, coexists with the jpackage `compose.desktop` block
  // below). Adds the printConveyorConfig / writeConveyorConfig tasks and feeds the runtime
  // classpath to `conveyor make`. See conveyor.conf and #5227.
  alias(libs.plugins.conveyor)
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

// --- Expose the app version to the running app (issue #5223) -------------------
// The app needs its own version at runtime to check GitHub Releases for updates.
// Two classpath-global carriers are written, both from the same `desktopReleaseVersion`:
//   1) a generated `automobile-version.properties` resource (the deterministic primary source —
//      jpackage's runtime image always includes it), and
//   2) the jar manifest's Implementation-Version/Title (a belt-and-suspenders fallback).
// `PackagedVersionSource` (in :desktop-core) reads the resource first, then scans manifests for
// the one titled "AutoMobile". Neither affects the installer identity below.
val generateVersionResource by tasks.registering {
  val versionValue = desktopReleaseVersion
  val outputDir = layout.buildDirectory.dir("generated/version/resources")
  inputs.property("version", versionValue)
  outputs.dir(outputDir)
  doLast {
    val file = outputDir.get().file("automobile-version.properties").asFile
    file.parentFile.mkdirs()
    file.writeText("version=$versionValue\ntitle=AutoMobile\n", Charsets.UTF_8)
  }
}

sourceSets { named("main") { resources.srcDir(generateVersionResource) } }

tasks.named<Jar>("jar") {
  manifest {
    attributes(
      "Implementation-Title" to "AutoMobile",
      "Implementation-Version" to desktopReleaseVersion,
    )
  }
}

// --- Strip bundled ffmpeg/ffprobe program executables --------------------------
// The org.bytedeco:ffmpeg:<ver>:<platform> classifier jar ships the ffmpeg and
// ffprobe CLI programs alongside the libav*/libjni* JNI libraries. The desktop
// app only uses the JNI bindings (H264Decoder in :desktop-core), so the programs
// are dead weight — and on macOS they break notarization: Compose's signer
// re-signs *.dylib/*.jnilib entries inside jars during packaging, but not
// extensionless Mach-O executables, so Apple's notary service finds the
// ad-hoc-signed ffmpeg/ffprobe binaries and rejects the DMG as Invalid.
// Filtering is applied to all platforms uniformly so the shipped runtime
// classpath does not vary by OS.
val ffmpegProgramsStripped: Attribute<Boolean> =
  Attribute.of(
    "dev.jasonpearson.automobile.desktop.ffmpegProgramsStripped",
    Boolean::class.javaObjectType,
  )

abstract class StripFfmpegProgramsTransform : TransformAction<TransformParameters.None> {
  @get:InputArtifact abstract val inputArtifact: Provider<FileSystemLocation>

  override fun transform(outputs: TransformOutputs) {
    val input = inputArtifact.get().asFile
    if (!input.name.startsWith("ffmpeg-")) {
      outputs.file(input)
      return
    }
    val output = outputs.file("${input.nameWithoutExtension}-no-programs.jar")
    ZipFile(input).use { zip ->
      ZipOutputStream(output.outputStream().buffered()).use { out ->
        for (entry in zip.entries()) {
          if (isFfmpegProgram(entry)) continue
          out.putNextEntry(ZipEntry(entry.name).apply { time = entry.time })
          if (!entry.isDirectory) {
            zip.getInputStream(entry).use { it.copyTo(out) }
          }
          out.closeEntry()
        }
      }
    }
  }

  private fun isFfmpegProgram(entry: ZipEntry): Boolean {
    if (entry.isDirectory || !entry.name.startsWith("org/bytedeco/ffmpeg/")) {
      return false
    }
    val fileName = entry.name.substringAfterLast('/')
    return fileName == "ffmpeg" ||
      fileName == "ffprobe" ||
      fileName == "ffmpeg.exe" ||
      fileName == "ffprobe.exe"
  }
}

dependencies {
  attributesSchema { attribute(ffmpegProgramsStripped) }
  artifactTypes.named("jar") { attributes.attribute(ffmpegProgramsStripped, false) }
  registerTransform(StripFfmpegProgramsTransform::class) {
    from
      .attribute(ffmpegProgramsStripped, false)
      .attribute(ArtifactTypeDefinition.ARTIFACT_TYPE_ATTRIBUTE, "jar")
    to
      .attribute(ffmpegProgramsStripped, true)
      .attribute(ArtifactTypeDefinition.ARTIFACT_TYPE_ATTRIBUTE, "jar")
  }
}

configurations.named("runtimeClasspath") {
  attributes.attribute(ffmpegProgramsStripped, true)
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
  testImplementation(libs.junit)
}

compose.desktop {
  application {
    mainClass = "dev.jasonpearson.automobile.desktop.MainKt"
    nativeDistributions {
      targetFormats(TargetFormat.Dmg, TargetFormat.Msi, TargetFormat.Deb)
      // GitHubReleaseSource (constructed during application startup) uses the JDK HttpClient.
      // Compose's minimized jlink runtime does not infer this module from the classpath, so it
      // must be declared explicitly or packaged apps fail with NoClassDefFoundError.
      modules("java.net.http")
      packageName = "AutoMobile"
      packageVersion = desktopPackageVersion
      description = "AutoMobile Desktop - Device automation and testing dashboard"
      vendor = "AutoMobile"

      macOS {
        iconFile.set(project.file("src/main/resources/icons/app-icon.icns"))
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
      windows {
        iconFile.set(project.file("src/main/resources/icons/app-icon.ico"))
        // Stable Windows Installer UpgradeCode. jpackage generates a fresh UUID
        // per build when this is unset, so consecutive MSIs would not recognize
        // each other as upgrades and would install side-by-side. This value must
        // stay constant across all future releases.
        upgradeUuid = "D3041B43-B2F0-413F-980F-A05C6DC370B2"
      }
      linux { iconFile.set(project.file("src/main/resources/icons/app-icon.png")) }
    }
  }
}

// Compose Hot Reload: `./gradlew :desktop-app:hotRun --autoReload --no-configuration-cache`
// launches the desktop dashboard with live UI reloading. Composables live in :desktop-core
// (an implementation dependency), so edits there recompile and reload into the running window
// without a restart. `--no-configuration-cache` is required because the hot-reload run tasks
// (e.g. ComposeHotSnapshotTask) are not configuration-cache serializable and the repo enables
// the configuration cache by default. The `hotRun` task itself is auto-registered by the
// hot-reload plugin -- which only happens because the Compose Multiplatform plugin is declared
// on the root classloader in android/build.gradle.kts (see the comment there); this block just
// points the auto-registered task at the app's main class.
tasks.withType<ComposeHotRun>().configureEach {
  mainClass.set("dev.jasonpearson.automobile.desktop.MainKt")
}

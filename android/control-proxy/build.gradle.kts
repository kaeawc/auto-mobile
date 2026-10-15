import com.android.build.api.artifact.ScopedArtifact
import com.android.build.api.artifact.SingleArtifact
import com.android.build.api.variant.ScopedArtifacts
import dev.jasonpearson.automobile.buildlogic.r8.VerifyR8KeptClassesTask
import org.gradle.api.tasks.PathSensitivity

plugins {
  id("automobile.kotlin-common")
  id("automobile.robolectric-sdk-pin")
  id("automobile.android-app-signing")
  alias(libs.plugins.android.application)
  alias(libs.plugins.kotlin.serialization)
  alias(libs.plugins.compose.compiler)
}

val minifyRelease =
  providers
    .gradleProperty("automobile.ctrlproxy.minifyRelease")
    .map { !it.equals("false", ignoreCase = true) }
    .orElse(true)

android {
  namespace = "dev.jasonpearson.automobile.ctrlproxy"
  compileSdk = libs.versions.build.android.compileSdk.get().toInt()
  buildToolsVersion = libs.versions.build.android.buildTools.get()

  defaultConfig {
    applicationId = "dev.jasonpearson.automobile.ctrlproxy"
    minSdk = libs.versions.build.android.minSdk.get().toInt()
    targetSdk = libs.versions.build.android.targetSdk.get().toInt()
    versionCode = 1
    versionName = "0.0.85-SNAPSHOT"

    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
  }

  buildTypes {
    release {
      isMinifyEnabled = minifyRelease.get()
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
    }
  }

  lint {
    // Suppress ProtectedPermissions for MANAGE_CA_CERTIFICATES
    // This permission is used when the app is set as device owner/profile owner
    disable += "ProtectedPermissions"
  }

  buildFeatures { compose = true }

  // Robolectric needs merged resources to render Compose Material 3 off-device. The
  // verifyRobolectricSdkPin guard checks the properties pin; the guard caps pins at SDK 35 (36+
  // fails on JDK 21).
  testOptions { unitTests.isIncludeAndroidResources = true }

  compileOptions {
    sourceCompatibility = JavaVersion.toVersion(libs.versions.build.java.target.get())
    targetCompatibility = JavaVersion.toVersion(libs.versions.build.java.target.get())
  }

  packaging {
    resources {
      // Exclude duplicate META-INF files from Ktor dependencies
      excludes += "/META-INF/INDEX.LIST"
      excludes += "/META-INF/*.kotlin_module"
    }
  }
}

androidComponents {
  onVariants(selector().withBuildType("release")) { variant ->
    if (minifyRelease.get()) {
      val verify =
        tasks.register<VerifyR8KeptClassesTask>("verifyReleaseR8KeptClasses") {
          mappingFile.set(variant.artifacts.get(SingleArtifact.OBFUSCATION_MAPPING_FILE))
          mergedManifest.set(variant.artifacts.get(SingleArtifact.MERGED_MANIFEST))
          namespace.set(variant.namespace)
          ownedPackagePrefixes.set(listOf("dev/jasonpearson/automobile/"))
          requiredMembers.set(
            listOf("filled", "outlined", "rounded", "sharp", "twotone").map {
              "androidx.compose.material.icons.$it.HomeKt#getHome"
            },
          )
          reportFile.set(layout.buildDirectory.file("reports/r8/release-kept-classes.txt"))
        }
      variant.artifacts
        .forScope(ScopedArtifacts.Scope.ALL)
        .use(verify)
        .toGet(
          ScopedArtifact.CLASSES,
          VerifyR8KeptClassesTask::classJars,
          VerifyR8KeptClassesTask::classDirs,
        )
      tasks.matching { it.name == "assembleRelease" }.configureEach { dependsOn(verify) }
      // Verify every R8 invocation, including packageRelease, installRelease and bundleRelease.
      tasks.matching { it.name == "minifyReleaseWithR8" }.configureEach { finalizedBy(verify) }
    }
  }
}

dependencies {
  implementation(libs.androidx.core)

  // AutoMobile SDK for navigation event tracking
  implementation(projects.autoMobileSdk)

  // Protocol module for type-safe WebSocket messages
  implementation(projects.protocol)

  // Compose BOM
  implementation(platform(libs.compose.bom))
  // The compose.ui bundle includes ui-tooling, which must stay debug-only in CtrlProxy.
  implementation(libs.androidx.activity.compose)
  implementation(libs.compose.ui.core)
  implementation(libs.compose.ui.util)
  implementation(libs.compose.ui.graphics)
  implementation(libs.compose.ui.foundation)
  implementation(libs.compose.ui.tooling.preview)
  implementation(libs.compose.material)
  implementation(libs.compose.material.icons.extended)
  implementation(libs.androidx.lifecycle.viewmodel.compose)

  // Kotlin coroutines
  implementation(libs.kotlinx.coroutines)

  // Kotlinx Serialization for navigation
  implementation(libs.kotlinx.serialization)

  // WebSocket server dependencies
  implementation(libs.ktor.server.core)
  implementation(libs.ktor.server.cors)
  // CIO engine used instead of Netty to support lower minSdk (Netty requires API 26+)
  implementation(libs.ktor.server.sse)
  implementation(libs.ktor.server.cio)
  implementation(libs.ktor.server.websockets)
  implementation(libs.ktor.server.content.negotiation)
  implementation(libs.ktor.serialization.kotlinx.json)
  implementation(libs.okhttp)
  implementation(libs.okhttp.sse)

  // Test dependencies
  testImplementation(libs.bundles.unit.test)
  testImplementation(projects.junitRunner)
  testImplementation(libs.robolectric)
  // createComposeRule's mainClock drives prototype motion frame by frame (#10442).
  testImplementation(libs.compose.ui.junit)
  testImplementation(libs.ktor.client.core)
  testImplementation(libs.ktor.client.cio)
  testImplementation(libs.ktor.client.websockets)
  testImplementation(libs.ktor.client.content.negotiation)

  // Compose test dependencies
  debugImplementation(libs.bundles.compose.ui.debug)
}

// Opt-in stability diagnostics for prototype renderer performance work.
// scripts/android/compose-compiler-report.sh forces a compile and summarizes these reports.
if (providers.gradleProperty("automobile.composeCompilerReports").orNull == "true") {
  composeCompiler {
    reportsDestination = layout.buildDirectory.dir("compose-compiler-reports")
    metricsDestination = layout.buildDirectory.dir("compose-compiler-reports")
  }
}

// Forward the prototype renderer screenshot and preview switches from the Gradle invocation to the
// forked test JVM so `-Dscreenshot.record=true` (and friends) reach the tests. See
// src/test/kotlin/.../prototype/screenshot/PrototypeScreenshotEnvironment.kt and
// PrototypePreview.kt for
// the supported flags.
val screenshotProperties =
  listOf(
    "screenshot.record",
    "screenshot.reference.os",
    "screenshot.golden.dir",
    "screenshot.report.dir",
    "prototype.preview.spec",
    "prototype.preview.out",
    "prototype.preview.width",
    "prototype.preview.height",
    "prototype.preview.density",
    "prototype.preview.theme",
  )

tasks.withType<Test>().configureEach {
  inputs
    .dir(layout.projectDirectory.dir("../../test/fixtures/prototype-spec"))
    .withPathSensitivity(PathSensitivity.RELATIVE)
    .withPropertyName("prototypeSpecFixtures")
  inputs
    .file(layout.projectDirectory.file("../../test/fixtures/ime-commit-contract.json"))
    .withPathSensitivity(PathSensitivity.RELATIVE)
    .withPropertyName("imeCommitContract")
  inputs
    .file(layout.projectDirectory.file("../../benchmark/prototype-frame/spec.json"))
    .withPathSensitivity(PathSensitivity.RELATIVE)
    .withPropertyName("prototypeFrameBenchmarkSpec")
  inputs
    .file(layout.projectDirectory.file("../../benchmark/prototype-frame/scenarios.json"))
    .withPathSensitivity(PathSensitivity.RELATIVE)
    .withPropertyName("prototypeFrameBenchmarkScenarios")
  screenshotProperties.forEach { key ->
    System.getProperty(key)?.let { value -> systemProperty(key, value) }
  }
  // A preview reads spec files Gradle does not track, so never reuse an up-to-date or cached
  // result.
  if (System.getProperty("prototype.preview.spec") != null) {
    outputs.upToDateWhen { false }
    outputs.doNotCacheIf("prototype preview reads untracked spec files") { true }
  }
}
